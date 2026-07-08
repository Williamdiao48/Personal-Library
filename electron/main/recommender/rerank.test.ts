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
  filterCandidates,
  scoreCandidate,
  mmrSelect,
  verifyCandidates,
  recommend,
  RERANK,
  type ScoredCandidate,
} from './rerank'
import type { Candidate } from './candidates'
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

// ── verifyCandidates (pure) ──────────────────────────────────────────────────
describe('verifyCandidates', () => {
  it('drops a picked title that is not in the fetched set', () => {
    const real = cand({ title: 'Real', sourceId: '/works/REAL' })
    const hallucinated = cand({ title: 'Made Up', sourceId: '/works/FAKE' })
    expect(verifyCandidates([real, hallucinated], [real]).map((c) => c.title)).toEqual(['Real'])
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
    const out = await recommend(stubEmbedder)
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

    const out = await recommend(stubEmbedder)
    expect(out.map((c) => c.title)).toEqual(['Fresh One', 'Fresh Two'])
    expect(out[0].sourceId).toBe('/works/F1')
    expect(out[0].why).toBeUndefined() // no LLM blurb in Chunk 4
    expect(out[0].score).toBeCloseTo(1, 5) // candidate east vs. east centroid
  })

  it('caps the result at TOP_K', async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' })
    const docs = Array.from({ length: RERANK.TOP_K + 3 }, (_, i) =>
      doc({ key: `/works/C${i}`, title: `Cand ${i}`, author_name: [`A${i}`] }),
    )
    fetchMock.mockResolvedValue(okJson({ docs }))

    const out = await recommend(stubEmbedder)
    expect(out).toHaveLength(RERANK.TOP_K)
  })
})
