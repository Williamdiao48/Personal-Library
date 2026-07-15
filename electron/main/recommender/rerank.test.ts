import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { okJson } from '../../../test/stubs/httpResponse'
import {
  openTestDb,
  closeTestDb,
  seedItem,
  seedEmbedding,
  seedTag,
  tagItem,
  SEED_T0,
  type TestDb,
} from '../../../test/db/harness'
import { run } from '../db'
import { encodeVector } from './embeddingCodec'
import {
  candidateKey,
  candidateUrl,
  matchedTags,
  filterCandidates,
  scoreCandidate,
  mmrSelect,
  bucketOf,
  allocateSlots,
  selectByQuota,
  verifyCandidates,
  recommend,
  RERANK,
  type ScoredCandidate,
} from './rerank'
import type { Candidate } from './candidates'
import { openLibrarySource } from './sources/openLibrary'
import type { CandidateSource } from './candidateSource'
import type { Embedder } from './embedder-core'

// C4.4 — the rerank core (candidateKey / filter / score / MMR / verify) is pure
// and ABI-agnostic; `recommend()` touches the db (Node ABI), a mocked global
// fetch, and a stub Embedder.

const v = (...xs: number[]) => Float32Array.from(xs)

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  title: 'A Book',
  author: 'An Author',
  subjects: ['Fantasy'],
  coverUrl: null,
  sourceId: '/works/OL1W',
  isbn: null,
  description: null,
  source: 'book',
  ...over,
})

const scored = (over: Partial<ScoredCandidate> = {}): ScoredCandidate => ({
  cand: cand(),
  vec: v(1, 0),
  score: 0.5,
  ...over,
})

// ── candidateKey (pure) ──────────────────────────────────────────────────────
describe('candidateKey', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(candidateKey('The   Hobbit!', 'J.R.R. Tolkien')).toBe(
      candidateKey('the hobbit', 'j r r tolkien'),
    )
  })

  it('joins title and author, tolerating a null author', () => {
    expect(candidateKey('Dune', null)).toBe('dune|')
    expect(candidateKey('Dune', 'Herbert')).toBe('dune|herbert')
  })
})

// ── filterCandidates (pure) ──────────────────────────────────────────────────
describe('filterCandidates', () => {
  it('drops candidates whose title|author key is owned or dismissed', () => {
    const keep = cand({ title: 'Fresh', author: 'New', sourceId: '/works/KEEP' })
    const owned = cand({ title: 'Owned!', author: 'Me', sourceId: '/works/OWN' })
    const out = filterCandidates([keep, owned], {
      keys: new Set([candidateKey('owned', 'me')]),
      ids: new Set(),
    })
    expect(out.map((c) => c.sourceId)).toEqual(['/works/KEEP'])
  })

  it('drops candidates matching an excluded sourceId or ISBN', () => {
    const bySource = cand({ sourceId: '/works/DISMISSED' })
    const byIsbn = cand({ sourceId: '/works/OTHER', isbn: '9780000000001' })
    const keep = cand({ sourceId: '/works/KEEP' })
    const out = filterCandidates([bySource, byIsbn, keep], {
      keys: new Set(),
      ids: new Set(['/works/DISMISSED', '9780000000001']),
    })
    expect(out.map((c) => c.sourceId)).toEqual(['/works/KEEP'])
  })
})

// ── scoreCandidate (pure) ────────────────────────────────────────────────────
describe('scoreCandidate', () => {
  it('is the max cosine over the centroids', () => {
    const vec = v(1, 0)
    // one centroid aligned (cos 1), one orthogonal (cos 0) → max is 1
    expect(scoreCandidate(vec, [v(0, 1), v(1, 0)])).toBeCloseTo(1, 6)
  })

  it('returns the best of several partial matches', () => {
    const vec = v(1, 0)
    expect(scoreCandidate(vec, [v(-1, 0), v(0.6, 0.8)])).toBeCloseTo(0.6, 6)
  })
})

// ── mmrSelect (pure) ─────────────────────────────────────────────────────────
describe('mmrSelect', () => {
  it('picks the highest score first', () => {
    const out = mmrSelect(
      [
        scored({ cand: cand({ sourceId: 'lo' }), vec: v(0, 1), score: 0.3 }),
        scored({ cand: cand({ sourceId: 'hi' }), vec: v(1, 0), score: 0.9 }),
      ],
      2,
      RERANK.LAMBDA,
    )
    expect(out[0].cand.sourceId).toBe('hi')
  })

  it('defers a near-duplicate high scorer behind a distinct lower scorer', () => {
    // A and A' are near-identical (cos≈1); B is orthogonal to both. λ=0.7:
    //   pick 1 → A (highest score).
    //   pick 2 → B (0.7·0.6 − 0.3·0 = 0.42) beats A' (0.7·0.88 − 0.3·~1 ≈ 0.32).
    const A = scored({ cand: cand({ sourceId: 'A' }), vec: v(1, 0, 0), score: 0.9 })
    const Aprime = scored({ cand: cand({ sourceId: "A'" }), vec: v(0.999, 0.045, 0), score: 0.88 })
    const B = scored({ cand: cand({ sourceId: 'B' }), vec: v(0, 1, 0), score: 0.6 })
    const out = mmrSelect([A, Aprime, B], 3, 0.7)
    expect(out.map((s) => s.cand.sourceId)).toEqual(['A', 'B', "A'"])
  })

  it('stops at k', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      scored({ cand: cand({ sourceId: `s${i}` }), vec: v(1, 0), score: 1 - i * 0.1 }),
    )
    expect(mmrSelect(items, 3, 0.7)).toHaveLength(3)
  })
})

// ── source-balanced selection (pure) ─────────────────────────────────────────
describe('bucketOf', () => {
  it('groups ao3 + ffn as fic and book as book', () => {
    expect(bucketOf('book')).toBe('book')
    expect(bucketOf('ao3')).toBe('fic')
    expect(bucketOf('ffn')).toBe('fic')
  })
})

describe('allocateSlots', () => {
  it('splits slots proportional to the library mix (60/40 book → 7/5 of 12)', () => {
    expect(allocateSlots(12, { book: 15, fic: 10 })).toEqual({ book: 7, fic: 5 })
  })

  it('gives every slot to the only kind present', () => {
    expect(allocateSlots(10, { book: 8, fic: 0 })).toEqual({ book: 10, fic: 0 })
    expect(allocateSlots(10, { book: 0, fic: 3 })).toEqual({ book: 0, fic: 10 })
  })

  it('falls back to all-book when the library is empty', () => {
    expect(allocateSlots(10, { book: 0, fic: 0 })).toEqual({ book: 10, fic: 0 })
  })
})

describe('selectByQuota', () => {
  const b = (id: string, s: number) =>
    scored({ cand: cand({ sourceId: id, source: 'book' }), vec: v(1, 0), score: s })
  const f = (id: string, s: number) =>
    scored({ cand: cand({ sourceId: id, source: 'ao3' }), vec: v(1, 0), score: s })

  it('honors the book quota even when fics score higher (the reported skew)', () => {
    // 4 fics all outscore the 2 books, but a 2/2 quota still surfaces both books.
    const pool = [
      f('f1', 0.9),
      f('f2', 0.88),
      f('f3', 0.86),
      f('f4', 0.84),
      b('b1', 0.7),
      b('b2', 0.6),
    ]
    const out = selectByQuota(pool, 4, { book: 2, fic: 2 }, 0.7)
    const buckets = out.map((s) => s.cand.source)
    expect(buckets.filter((x) => x === 'book')).toHaveLength(2)
    expect(buckets.filter((x) => x === 'ao3')).toHaveLength(2)
    expect(out).toHaveLength(4)
  })

  it('tops up from the other bucket when one underfills its quota (never shrinks the feed)', () => {
    // Only 1 book but the quota wants 2 → the extra slot overflows to fic.
    const pool = [f('f1', 0.9), f('f2', 0.85), f('f3', 0.8), b('b1', 0.6)]
    const out = selectByQuota(pool, 4, { book: 2, fic: 2 }, 0.7)
    expect(out).toHaveLength(4)
    expect(out.filter((s) => s.cand.source === 'book')).toHaveLength(1)
  })

  it('returns picks in score-descending order', () => {
    const pool = [b('b1', 0.5), f('f1', 0.9), b('b2', 0.7)]
    const out = selectByQuota(pool, 3, { book: 2, fic: 1 }, 0.7)
    expect(out.map((s) => s.score)).toEqual([0.9, 0.7, 0.5])
  })
})

// ── verifyCandidates (pure) ──────────────────────────────────────────────────
describe('verifyCandidates', () => {
  it('drops a picked title that is not in the fetched set', () => {
    const real = cand({ title: 'Real', sourceId: '/works/REAL' })
    const hallucinated = cand({ title: 'Made Up', sourceId: '/works/FAKE' })
    expect(verifyCandidates([real, hallucinated], [real]).map((c) => c.title)).toEqual(['Real'])
  })
})

// ── candidateUrl (pure) ──────────────────────────────────────────────────────
describe('candidateUrl', () => {
  it('prefixes an OpenLibrary work key with the origin', () => {
    expect(candidateUrl(cand({ source: 'book', sourceId: '/works/OL45804W' }))).toBe(
      'https://openlibrary.org/works/OL45804W',
    )
  })

  it('inserts a slash when a book key lacks a leading one', () => {
    expect(candidateUrl(cand({ source: 'book', sourceId: 'works/OL1W' }))).toBe(
      'https://openlibrary.org/works/OL1W',
    )
  })

  it('passes an AO3/FFN work URL through unchanged', () => {
    const url = 'https://archiveofourown.org/works/9'
    expect(candidateUrl(cand({ source: 'ao3', sourceId: url }))).toBe(url)
  })

  it('never double-prefixes a book that already carries a full URL', () => {
    const url = 'https://openlibrary.org/works/OL2W'
    expect(candidateUrl(cand({ source: 'book', sourceId: url }))).toBe(url)
  })
})

// ── matchedTags (pure) ───────────────────────────────────────────────────────
describe('matchedTags', () => {
  const seeds = new Set(['harry potter', 'slow burn', 'romance'])

  it('keeps the candidate subjects that overlap the taste seeds, case-insensitively', () => {
    expect(matchedTags(['Harry Potter', 'Adventure', 'Slow Burn'], seeds)).toEqual([
      'Harry Potter',
      'Slow Burn',
    ])
  })

  it('returns [] (UI falls back to own subjects) when nothing overlaps', () => {
    expect(matchedTags(['Mystery', 'Noir'], seeds)).toEqual([])
  })

  it('preserves subject order and caps the result', () => {
    const many = ['romance', 'slow burn', 'harry potter']
    expect(matchedTags(many, seeds, 2)).toEqual(['romance', 'slow burn'])
  })
})

// ── recommend (orchestrator: db + mocked fetch + stub embedder) ──────────────
describe('recommend', () => {
  let db: TestDb
  let fetchMock: ReturnType<typeof vi.fn>

  // Every candidate embeds to the same east-pointing vector, so any liked item
  // whose vector is also east yields max score — membership/ordering is what the
  // orchestrator tests assert, not similarity magnitude.
  const stubEmbedder: Embedder = {
    modelVersion: 'stub',
    dim: 2,
    embed: async (texts) => texts.map(() => v(1, 0)),
  }

  const doc = (over: Record<string, unknown> = {}) => ({
    key: '/works/OL1W',
    title: 'A Book',
    author_name: ['An Author'],
    subject: ['Fantasy'],
    ...over,
  })

  beforeEach(() => {
    db = openTestDb()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    closeTestDb()
  })

  /** Seed one liked+embedded item (east vector, 5★) so buildTaste has a centroid. */
  function seedLikedItem(
    over: { title?: string; author?: string | null; tag?: string } = {},
  ): string {
    const id = seedItem(db, {
      title: over.title ?? 'Owned Book',
      author: over.author ?? 'Owner',
      rating: 5,
    })
    seedEmbedding(db, id, { embedding: encodeVector(v(1, 0)) })
    if (over.tag) tagItem(db, id, seedTag(db, over.tag))
    return id
  }

  it('refuses (returns []) on a cold-start library and never hits the network', async () => {
    // No liked+embedded item → buildTaste centroids [] → refuse before fetching.
    const out = await recommend(stubEmbedder, [openLibrarySource])
    expect(out).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns cards, filtering out owned and dismissed candidates', async () => {
    seedLikedItem({ title: 'Owned Book', author: 'Owner', tag: 'Fantasy' })
    run(
      `INSERT INTO dismissed_recommendations (id, title, author, source, dismissed_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['dismiss-1', 'Dismissed Book', 'Nope', null, SEED_T0],
    )
    fetchMock.mockResolvedValue(
      okJson({
        docs: [
          doc({ key: '/works/OWN', title: 'Owned Book', author_name: ['Owner'] }), // owned
          doc({ key: '/works/DIS', title: 'Dismissed Book', author_name: ['Nope'] }), // dismissed
          doc({ key: '/works/F1', title: 'Fresh One', author_name: ['X'] }),
          doc({ key: '/works/F2', title: 'Fresh Two', author_name: ['Y'] }),
        ],
      }),
    )

    const out = await recommend(stubEmbedder, [openLibrarySource])
    expect(out.map((c) => c.title)).toEqual(['Fresh One', 'Fresh Two'])
    expect(out[0].sourceId).toBe('/works/F1')
    expect(out[0].description).toBeNull() // OpenLibrary stub carries no blurb
    expect(out[0].score).toBeCloseTo(1, 5) // candidate east vs. east centroid
    // Widened output (C5.1): source badge, an openable URL, own subjects, "why" chips.
    expect(out[0].source).toBe('book')
    expect(out[0].url).toBe('https://openlibrary.org/works/F1')
    expect(out[0].subjects).toEqual(['Fantasy'])
    expect(out[0].matchedTags).toEqual([]) // liked item has no native tags → no overlap
    // Perf cache: only the KEPT candidates are embedded (owned/dismissed are filtered
    // out before the model runs), and their vectors are cached by sourceId for reuse.
    const cached = db
      .prepare(`SELECT source_id FROM candidate_embeddings ORDER BY source_id`)
      .all() as { source_id: string }[]
    expect(cached.map((r) => r.source_id)).toEqual(['/works/F1', '/works/F2'])
  })

  it('fills matchedTags with the taste tags a candidate shares (the deterministic why)', async () => {
    // A liked item carrying a native "Fantasy" tag → it lands in the taste seeds;
    // a candidate whose subjects include "Fantasy" then matches it ("War" does not).
    const liked = seedLikedItem({ title: 'Seed', author: 'S' })
    run(`INSERT INTO item_source_tags (item_id, name, category) VALUES (?, ?, ?)`, [
      liked,
      'Fantasy',
      'freeform',
    ])
    fetchMock.mockResolvedValue(
      okJson({
        docs: [
          doc({ key: '/works/M', title: 'Match', author_name: ['A'], subject: ['Fantasy', 'War'] }),
        ],
      }),
    )

    const out = await recommend(stubEmbedder, [openLibrarySource])
    expect(out[0].matchedTags).toEqual(['Fantasy'])
  })

  it('caps the result at TOP_K', async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' })
    const docs = Array.from({ length: RERANK.TOP_K + 3 }, (_, i) =>
      doc({ key: `/works/C${i}`, title: `Cand ${i}`, author_name: [`A${i}`] }),
    )
    fetchMock.mockResolvedValue(okJson({ docs }))

    const out = await recommend(stubEmbedder, [openLibrarySource])
    expect(out).toHaveLength(RERANK.TOP_K)
  })

  it('widens the emitted pool to opts.limit (a Discover page beyond the default TOP_K)', async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' })
    const src: CandidateSource = {
      name: 'book',
      fetch: async () =>
        Array.from({ length: 20 }, (_, i) =>
          cand({ title: `Cand ${i}`, author: `A${i}`, sourceId: `/works/C${i}`, source: 'book' }),
        ),
    }
    const out = await recommend(stubEmbedder, [src], undefined, { limit: 18 })
    expect(out).toHaveLength(18)
  })

  it('excludeIds drops already-shown candidates so the next page never repeats', async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' })
    const src: CandidateSource = {
      name: 'book',
      fetch: async () => [
        cand({ title: 'One', author: 'A', sourceId: '/works/C1', source: 'book' }),
        cand({ title: 'Two', author: 'B', sourceId: '/works/C2', source: 'book' }),
      ],
    }
    const out = await recommend(stubEmbedder, [src], undefined, { excludeIds: ['/works/C1'] })
    expect(out.map((c) => c.sourceId)).toEqual(['/works/C2'])
  })

  it('forwards opts.fresh to every source (the Refresh soft-floor signal)', async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' })
    const seen: Array<{ fresh?: boolean } | undefined> = []
    const src: CandidateSource = {
      name: 'book',
      fetch: async (_liked, opts) => {
        seen.push(opts)
        return [cand({ title: 'One', author: 'A', sourceId: '/works/C1', source: 'book' })]
      },
    }
    await recommend(stubEmbedder, [src], undefined, { fresh: true })
    expect(seen).toEqual([{ fresh: true }])

    seen.length = 0
    await recommend(stubEmbedder, [src]) // default read → not a fresh refresh
    expect(seen).toEqual([{ fresh: undefined }])
  })

  it("folds a fic's description (summary) into the text it embeds", async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' })
    const seen: string[] = []
    const spyEmbedder: Embedder = {
      modelVersion: 'stub',
      dim: 2,
      embed: async (texts) => {
        seen.push(...texts)
        return texts.map(() => v(1, 0))
      },
    }
    const src: CandidateSource = {
      name: 'ao3',
      fetch: async () => [
        cand({
          title: 'A Fic',
          author: 'Ficcer',
          sourceId: 'https://ao3/works/9',
          source: 'ao3',
          description: 'Rivals forced together over one long winter.',
        }),
      ],
    }
    await recommend(spyEmbedder, [src])
    // The candidate reaches the model with its summary in the metadata string, so
    // the vector reflects plot/tone — not just categorical tags.
    expect(
      seen.some((t) => t.includes('description: Rivals forced together over one long winter.')),
    ).toBe(true)
  })

  it('unions injected sources and dedups a cross-source title|author collision (F4)', async () => {
    seedLikedItem({ title: 'Owned Book', author: 'Owner', tag: 'Fantasy' })
    const book = cand({ title: 'Fresh One', author: 'X', sourceId: '/works/F1', source: 'book' })
    const fic = cand({
      title: 'A Fic',
      author: 'Ficcer',
      sourceId: 'https://ao3/works/9',
      source: 'ao3',
    })
    const dupOfBook = cand({
      title: 'Fresh One',
      author: 'X',
      sourceId: 'https://ao3/works/dup',
      source: 'ao3',
    })
    const bookSrc: CandidateSource = { name: 'book', fetch: async () => [book] }
    const ficSrc: CandidateSource = { name: 'ao3', fetch: async () => [fic, dupOfBook] }

    // Fanfic-first order: the ao3 "Fresh One" wins the title|author key, book's drops.
    const out = await recommend(stubEmbedder, [ficSrc, bookSrc])
    expect(out.map((c) => c.title).sort()).toEqual(['A Fic', 'Fresh One'])
    expect(fetchMock).not.toHaveBeenCalled() // injected sources bypass the network
  })

  it('survives a source that throws, keeping the healthy source (F4)', async () => {
    seedLikedItem({ title: 'Owned Book', author: 'Owner', tag: 'Fantasy' })
    const good: CandidateSource = {
      name: 'book',
      fetch: async () => [cand({ title: 'Survivor', author: 'S', sourceId: '/works/S' })],
    }
    const boom: CandidateSource = {
      name: 'ao3',
      fetch: async () => {
        throw new Error('source down')
      },
    }
    const out = await recommend(stubEmbedder, [boom, good])
    expect(out.map((c) => c.title)).toEqual(['Survivor'])
  })
})
