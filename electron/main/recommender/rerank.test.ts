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
  authorKey,
  allocateSlots,
  floorAlloc,
  selectByQuota,
  diversifyBookPicks,
  leadTopicKey,
  applyPopularityPrior,
  POPULARITY,
  verifyCandidates,
  recommend,
  RERANK,
  type ScoredCandidate,
} from './rerank'
import { CANDIDATE_TEXT_VERSION, type Candidate } from './candidates'
import { saveCandidateVectors } from './candidateEmbeddings'
import { recordOpen } from './interactions'
import { ENGAGE } from './engagement'
import { EXPLORE } from './explore'
import type { TasteResult } from './taste'
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
  pages: 200, // known substantive length so books stay eligible for the explore length gate
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

  it('fuzzy-drops a candidate owned via a messy filename title (Elantris case)', () => {
    // Owned as a PDF: title = filename, author NULL → exact key can't match the clean
    // OpenLibrary candidate. Token-containment catches it.
    const elantris = cand({ title: 'Elantris', author: 'Brandon Sanderson', sourceId: '/works/E' })
    const other = cand({ title: 'Warbreaker', author: 'Brandon Sanderson', sourceId: '/works/W' })
    const ownedMessy = new Set(['elantris', 'brandon', 'sanderson']) // from the filename
    const out = filterCandidates([elantris, other], {
      keys: new Set(),
      ids: new Set(),
      titleTokens: [ownedMessy],
    })
    expect(out.map((c) => c.sourceId)).toEqual(['/works/W']) // Warbreaker kept
  })

  it('does not fuzzy-drop a generic short title (distinctiveness guard)', () => {
    const it = cand({ title: 'It', author: 'Stephen King', sourceId: '/works/IT' })
    const out = filterCandidates([it], {
      keys: new Set(),
      ids: new Set(),
      titleTokens: [new Set(['it', 'is', 'a', 'messy', 'owned', 'filename'])],
    })
    expect(out.map((c) => c.sourceId)).toEqual(['/works/IT']) // kept — "it" too generic
  })

  it('fuzzy match needs ALL candidate tokens present in ONE owned set', () => {
    const kept = cand({
      title: 'The Final Empire',
      author: 'Brandon Sanderson',
      sourceId: '/works/M',
    })
    // Tokens {final, empire} split across two different owned items → no single-set match.
    const out = filterCandidates([kept], {
      keys: new Set(),
      ids: new Set(),
      titleTokens: [new Set(['final', 'countdown']), new Set(['roman', 'empire'])],
    })
    expect(out.map((c) => c.sourceId)).toEqual(['/works/M'])
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

describe('floorAlloc', () => {
  const avail = { book: 100, fic: 100 } // plenty of both unless a test says otherwise

  it('leaves a proportional alloc untouched when both buckets already clear the floor', () => {
    expect(floorAlloc({ book: 18, fic: 18 }, 12, avail)).toEqual({ book: 18, fic: 18 })
  })

  it('raises the minority bucket to the floor, taking from the majority surplus', () => {
    // 90/10 split of 36 → 4 books; floor of 12 pulls 8 from fic.
    expect(floorAlloc({ book: 4, fic: 32 }, 12, avail)).toEqual({ book: 12, fic: 24 })
  })

  it('is symmetric — floors a starved fic bucket from the book surplus', () => {
    expect(floorAlloc({ book: 32, fic: 4 }, 12, avail)).toEqual({ book: 24, fic: 12 })
  })

  it('keeps book + fic constant', () => {
    const out = floorAlloc({ book: 2, fic: 34 }, 12, avail)
    expect(out.book + out.fic).toBe(36)
  })

  it('caps the floor at how many candidates the bucket actually has', () => {
    // Only 3 books exist → floor can only reach 3, not 12; fic keeps the rest.
    expect(floorAlloc({ book: 1, fic: 35 }, 12, { book: 3, fic: 100 })).toEqual({
      book: 3,
      fic: 33,
    })
  })

  it('does not drop the donor bucket below its own (availability-capped) floor', () => {
    // Both want 12 but only 20 slots; fic has just 8 candidates so its floor is 8,
    // leaving book able to take up to 12.
    expect(floorAlloc({ book: 2, fic: 18 }, 12, { book: 100, fic: 8 })).toEqual({
      book: 12,
      fic: 8,
    })
  })
})

describe('selectByQuota', () => {
  // Distinct authors so the book author-diversity (≤1/author) keeps each book.
  const b = (id: string, s: number) =>
    scored({
      cand: cand({ sourceId: id, source: 'book', author: `Author ${id}` }),
      vec: v(1, 0),
      score: s,
    })
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

  it('keeps ≤1 book per author when the top-up fills from the book leftovers (L4)', () => {
    // Same-author books so diversifyBookPicks keeps only one; a tiny fic pool forces
    // the fic quota to underfill, so the top-up must reach into the remaining books —
    // and must NOT re-admit another book by the already-picked author.
    const sameAuthor = (id: string, s: number) =>
      scored({ cand: cand({ sourceId: id, source: 'book', author: 'Solo Author' }), score: s })
    const pool = [
      sameAuthor('b1', 0.9),
      sameAuthor('b2', 0.85),
      sameAuthor('b3', 0.8),
      f('f1', 0.7),
    ]
    // Quota wants 2 books + 2 fics, but only 1 fic exists → top-up would otherwise
    // pull a second 'Solo Author' book to reach k=4.
    const out = selectByQuota(pool, 4, { book: 2, fic: 2 }, 0.7)
    const books = out.filter((s) => s.cand.source === 'book')
    expect(books).toHaveLength(1) // never two by the same author
    expect(books[0].cand.author).toBe('Solo Author')
  })
})

// ── diversifyBookPicks (pure — author diversity, favor new authors) ──────────
describe('authorKey', () => {
  it('normalizes case + punctuation and maps null/blank to empty', () => {
    expect(authorKey('Ursula K. Le Guin')).toBe('ursula k le guin')
    expect(authorKey(null)).toBe('')
    expect(authorKey('   ')).toBe('')
  })
})

describe('diversifyBookPicks', () => {
  const bk = (id: string, author: string, s: number) =>
    scored({ cand: cand({ sourceId: id, source: 'book', author }), vec: v(1, 0), score: s })

  it('keeps at most one book per author (highest score wins)', () => {
    const pool = [bk('a1', 'Author A', 0.9), bk('a2', 'Author A', 0.8), bk('b1', 'Author B', 0.7)]
    const out = diversifyBookPicks(pool, new Set(), 5, 0.7)
    expect(out.map((s) => s.cand.sourceId).sort()).toEqual(['a1', 'b1'])
  })

  it('favors new authors, capping owned-author books to ~the fraction of the quota', () => {
    // 8 new-author books + 4 owned-author books, quota 10 → ~2 owned (round(10*0.2)).
    const owned = new Set(['owned one', 'owned two', 'owned three', 'owned four'])
    const pool = [
      ...Array.from({ length: 8 }, (_, i) => bk(`new${i}`, `New ${i}`, 0.9 - i * 0.01)),
      bk('o0', 'Owned One', 0.95),
      bk('o1', 'Owned Two', 0.94),
      bk('o2', 'Owned Three', 0.93),
      bk('o3', 'Owned Four', 0.92),
    ]
    const out = diversifyBookPicks(pool, owned, 10, 0.7)
    const ownedPicked = out.filter((s) => owned.has(authorKey(s.cand.author)))
    expect(ownedPicked).toHaveLength(2)
    expect(out).toHaveLength(10) // 8 new + 2 owned
  })

  it('tops up from owned authors when new-author books underfill the quota', () => {
    // Only 2 new-author books but quota 5 → the rest fill from owned so it never shrinks.
    const owned = new Set(['owned a', 'owned b', 'owned c'])
    const pool = [
      bk('n0', 'New A', 0.9),
      bk('n1', 'New B', 0.8),
      bk('o0', 'Owned A', 0.7),
      bk('o1', 'Owned B', 0.6),
      bk('o2', 'Owned C', 0.5),
    ]
    const out = diversifyBookPicks(pool, owned, 5, 0.7)
    expect(out).toHaveLength(5)
    expect(out.filter((s) => !owned.has(authorKey(s.cand.author)))).toHaveLength(2)
  })

  it('returns [] for a non-positive quota', () => {
    expect(diversifyBookPicks([bk('a', 'A', 0.9)], new Set(), 0, 0.7)).toEqual([])
  })

  // ── topical diversity cap (de-fixation) ──────────────────────────────────────
  const bkS = (id: string, author: string, s: number, subjects: string[]) =>
    scored({
      cand: cand({ sourceId: id, source: 'book', author, subjects }),
      vec: v(1, 0),
      score: s,
    })

  it('caps books sharing one lead topic to TOPIC_CAP when siblings can fill the rest', () => {
    // 5 top-scoring "Bears" books (distinct authors) + 4 lower "Foxes" books. Quota 6.
    // Without the cap the 5 bears + 1 fox would win on score; the cap keeps ≤2 bears so
    // the animal-adventure siblings get promoted.
    const pool = [
      bkS('br0', 'A', 0.99, ['Bears', 'Bears, Fiction']),
      bkS('br1', 'B', 0.98, ['Bears']),
      bkS('br2', 'C', 0.97, ['Bears, Juvenile fiction']),
      bkS('br3', 'D', 0.96, ['Bears']),
      bkS('br4', 'E', 0.95, ['Bears']),
      bkS('fx0', 'F', 0.5, ['Foxes']),
      bkS('fx1', 'G', 0.49, ['Foxes']),
      bkS('fx2', 'H', 0.48, ['Wolves']),
      bkS('fx3', 'I', 0.47, ['Cats']),
    ]
    const out = diversifyBookPicks(pool, new Set(), 6, 0.7)
    const bears = out.filter((s) => s.cand.sourceId.startsWith('br'))
    expect(bears).toHaveLength(2) // capped
    expect(out).toHaveLength(6) // never shrinks — siblings fill the freed slots
  })

  it('relaxes the topic cap rather than under-fill when only one topic is available', () => {
    // All bears, quota 5 → the cap would leave 2, but a soft cap fills the page.
    const pool = [
      bkS('br0', 'A', 0.99, ['Bears']),
      bkS('br1', 'B', 0.98, ['Bears, Fiction']),
      bkS('br2', 'C', 0.97, ['Bears']),
      bkS('br3', 'D', 0.96, ['Bears']),
      bkS('br4', 'E', 0.95, ['Bears']),
    ]
    expect(diversifyBookPicks(pool, new Set(), 5, 0.7)).toHaveLength(5)
  })

  it('does not cap candidates whose subjects are all non-discriminative (empty topic key)', () => {
    // "Fiction"/"Juvenile Fiction" are format labels, not a topic → no cap key → all kept.
    const pool = [
      bkS('g0', 'A', 0.9, ['Fiction']),
      bkS('g1', 'B', 0.8, ['Juvenile Fiction']),
      bkS('g2', 'C', 0.7, ['General']),
    ]
    expect(diversifyBookPicks(pool, new Set(), 5, 0.7)).toHaveLength(3)
  })
})

describe('applyPopularityPrior', () => {
  const bkPop = (id: string, score: number, popularity?: number, source: 'book' | 'ao3' = 'book') =>
    scored({ cand: cand({ sourceId: id, source, popularity }), vec: v(1, 0), score })
  const noJitter = () => 0.5 // rng → (0.5 - 0.5) = 0 jitter, deterministic

  it('lifts a well-read book above a modestly-more-on-taste obscure one (leads by popularity)', () => {
    const pool = [
      bkPop('obscure', 0.55, 3), // higher taste, few readers
      bkPop('popular', 0.45, 20000), // lower taste, mega-read
    ]
    applyPopularityPrior(pool, POPULARITY, noJitter)
    const byId = Object.fromEntries(pool.map((s) => [s.cand.sourceId, s.score]))
    expect(byId['popular']).toBeGreaterThan(byId['obscure'])
  })

  it('does NOT let a mega-popular, vaguely-on-taste book overtake a clear taste match', () => {
    // The "Roald Dahl / Matilda" case: a loosely-on-taste blockbuster must not leapfrog a
    // book that genuinely fits. Because the lift is taste-SCALED, the vague book earns only
    // a small proportional boost — a flat additive prior (old behaviour) would have flipped
    // these (0.30 + 0.4 = 0.70 > 0.60).
    const pool = [
      bkPop('match', 0.6, 5), // clearly on-taste, few readers
      bkPop('vaguePopular', 0.3, 50000), // only vaguely on-taste, mega-read
    ]
    applyPopularityPrior(pool, POPULARITY, noJitter)
    const byId = Object.fromEntries(pool.map((s) => [s.cand.sourceId, s.score]))
    expect(byId['match']).toBeGreaterThan(byId['vaguePopular'])
  })

  it('is a no-op when no book carries a popularity signal (cannot-hurt invariant)', () => {
    const pool = [bkPop('a', 0.5), bkPop('b', 0.4)]
    applyPopularityPrior(pool, POPULARITY, noJitter)
    expect(pool.map((s) => s.score)).toEqual([0.5, 0.4])
  })

  it('leaves fics untouched, lifting only books', () => {
    // Two books (so the min-max prior has a span) + a fic that even carries a popularity
    // value: the fic must be skipped, the top-read book lifted.
    const pool = [
      bkPop('fic', 0.5, 9999, 'ao3'),
      bkPop('bookLo', 0.5, 10, 'book'),
      bkPop('bookHi', 0.5, 9999, 'book'),
    ]
    applyPopularityPrior(pool, POPULARITY, noJitter)
    const byId = Object.fromEntries(pool.map((s) => [s.cand.sourceId, s.score]))
    expect(byId['fic']).toBe(0.5) // fic has popularity but isn't a book → skipped
    expect(byId['bookHi']).toBeGreaterThan(byId['bookLo'])
  })

  it('jitters within ±JITTER/2 so the exact order varies between refreshes', () => {
    const mk = () => [bkPop('a', 0.5, 100), bkPop('b', 0.5, 100)] // equal → only jitter moves them
    const lo = mk()
    applyPopularityPrior(lo, POPULARITY, () => 0) // rng 0 → −JITTER/2
    const hi = mk()
    applyPopularityPrior(hi, POPULARITY, () => 1) // rng 1 → +JITTER/2
    expect(hi[0].score - lo[0].score).toBeCloseTo(POPULARITY.JITTER)
  })
})

describe('leadTopicKey', () => {
  it('is the first discriminative subject, canonicalized', () => {
    expect(
      leadTopicKey(cand({ subjects: ['Fiction', 'Bears, Juvenile fiction', 'Adventure'] })),
    ).toBe('bears')
  })
  it('is empty when no subject is discriminative', () => {
    expect(leadTopicKey(cand({ subjects: ['Fiction', 'General', "Children's literature"] }))).toBe(
      '',
    )
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
    number_of_pages_median: 200, // substantive length so candidates stay explore-eligible
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
    // Vary the candidate vectors so the reserved explore slots fill from a genuinely
    // distinct, non-redundant tail: most near taste (win exploit), a few on-taste-but-
    // distinct (fill explore). An all-identical fixture would trip the redundancy wall and
    // correctly under-fill — not what this cap test means to exercise.
    const candVer2 = `${stubEmbedder.modelVersion}|${CANDIDATE_TEXT_VERSION}`
    saveCandidateVectors(
      Array.from({ length: RERANK.TOP_K + 3 }, (_, i) => ({
        sourceId: `/works/C${i}`,
        vec: i < RERANK.TOP_K ? v(1, 0) : v(0.6, 0.8),
      })),
      candVer2,
    )

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
    // Vary vectors (see the cap test) so explore fills its reserved slots from a distinct
    // tail rather than under-filling on identical clones of the exploit feed.
    const candVer2 = `${stubEmbedder.modelVersion}|${CANDIDATE_TEXT_VERSION}`
    saveCandidateVectors(
      Array.from({ length: 20 }, (_, i) => ({
        sourceId: `/works/C${i}`,
        vec: i < 15 ? v(1, 0) : v(0.6, 0.8),
      })),
      candVer2,
    )
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

  // ── implicit-feedback engagement signal (ADR-0011) ─────────────────────────
  // The candidate cache stores each opened card's vector under the SAME version key
  // recommend() uses, so the engagement centroid can be rebuilt from opens.
  const candVer = `${stubEmbedder.modelVersion}|${CANDIDATE_TEXT_VERSION}`

  it('blends the engagement centroid into scoring (a north-pointing open pulls an east candidate score down)', async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' }) // east taste centroid
    // An opened card whose cached vector points NORTH (orthogonal to taste/candidate).
    recordOpen({
      sourceId: '/works/OPENED',
      title: 'Opened',
      author: 'O',
      source: 'book',
      url: 'https://openlibrary.org/works/OPENED',
      subjects: [],
    })
    saveCandidateVectors([{ sourceId: '/works/OPENED', vec: v(0, 1) }], candVer)
    fetchMock.mockResolvedValue(
      okJson({ docs: [doc({ key: '/works/F1', title: 'Fresh', author_name: ['X'] })] }),
    )

    const out = await recommend(stubEmbedder, [openLibrarySource])
    // Candidate east vs. east taste = cos 1; east vs. north engagement = cos 0.
    // Blended = (1−W)·1 + W·0 = 1−W_ENGAGE (vs. an unblended 1.0).
    expect(out[0].score).toBeCloseTo(1 - ENGAGE.W_ENGAGE, 5)
  })

  it('leaves scoring untouched when there are no opens (the cannot-hurt invariant)', async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' })
    fetchMock.mockResolvedValue(
      okJson({ docs: [doc({ key: '/works/F1', title: 'Fresh', author_name: ['X'] })] }),
    )
    const out = await recommend(stubEmbedder, [openLibrarySource])
    expect(out[0].score).toBeCloseTo(1, 5) // east vs. east, no engagement blend
  })

  it('hard-suppresses a just-opened card from the very next refresh (auto-expiring exclude)', async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' })
    const src: CandidateSource = {
      name: 'book',
      fetch: async () => [
        cand({ title: 'One', author: 'A', sourceId: '/works/C1', source: 'book' }),
        cand({ title: 'Two', author: 'B', sourceId: '/works/C2', source: 'book' }),
      ],
    }
    // Open C1 just now → within FULL_SUPPRESS_MS → excluded from the next refresh.
    recordOpen({
      sourceId: '/works/C1',
      title: 'One',
      author: 'A',
      source: 'book',
      url: 'https://openlibrary.org/works/C1',
      subjects: [],
    })
    const out = await recommend(stubEmbedder, [src])
    expect(out.map((c) => c.sourceId)).toEqual(['/works/C2'])
  })

  it('does NOT suppress an open older than FULL_SUPPRESS_MS (the card may resurface, now shaded)', async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' })
    const src: CandidateSource = {
      name: 'book',
      fetch: async () => [
        cand({ title: 'One', author: 'A', sourceId: '/works/C1', source: 'book' }),
      ],
    }
    // Opened well outside the suppression window → back in the candidate pool.
    recordOpen(
      {
        sourceId: '/works/C1',
        title: 'One',
        author: 'A',
        source: 'book',
        url: 'https://openlibrary.org/works/C1',
        subjects: [],
      },
      Date.now() - (ENGAGE.FULL_SUPPRESS_MS + 60_000),
    )
    const out = await recommend(stubEmbedder, [src])
    expect(out.map((c) => c.sourceId)).toEqual(['/works/C1'])
  })

  // ── exploration: epsilon slots + UCB-lite picker (explore.ts) ──────────────
  it('reserves explore slots, filled from the under-observed passed-over tail and tagged origin', async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' }) // owned/taste vec (1,0)
    // 9 in-taste "near" candidates fill the exploit quota exactly (so none spill into the
    // tail), + 4 recognisably-on-taste but under-observed "far" ones that become the tail.
    const near = Array.from({ length: 9 }, (_, i) =>
      doc({ key: `/works/N${i}`, title: `Near ${i}`, author_name: [`AN${i}`] }),
    )
    const far = Array.from({ length: 4 }, (_, i) =>
      doc({ key: `/works/F${i}`, title: `Far ${i}`, author_name: [`AF${i}`] }),
    )
    fetchMock.mockResolvedValue(okJson({ docs: [...near, ...far] }))
    // Pre-seed candidate vectors so scoring is deterministic (recommend loads the cache
    // before embedding): near = (1,0) (cos 1 to taste → exploit-preferred); far =
    // (0.5,0.866) (cos 0.5 to taste — comfortably on-taste, clears the relevance floor —
    // but 0 owned neighbours → high uncertainty, so the objective prefers them).
    const candVer2 = `${stubEmbedder.modelVersion}|${CANDIDATE_TEXT_VERSION}`
    saveCandidateVectors(
      [
        ...Array.from({ length: 9 }, (_, i) => ({ sourceId: `/works/N${i}`, vec: v(1, 0) })),
        ...Array.from({ length: 4 }, (_, i) => ({ sourceId: `/works/F${i}`, vec: v(0.5, 0.866) })),
      ],
      candVer2,
    )

    const out = await recommend(stubEmbedder, [openLibrarySource])
    const explore = out.filter((c) => c.origin === 'explore')
    expect(explore).toHaveLength(EXPLORE.SLOTS)
    // Explore picks are drawn from the under-observed FAR tail, never the in-taste near set.
    expect(explore.every((c) => c.sourceId.startsWith('/works/F'))).toBe(true)
    // Exploit cards omit the origin field entirely (byte-identical card shape).
    const exploit = out.filter((c) => c.origin === undefined)
    expect(exploit.every((c) => c.sourceId.startsWith('/works/N'))).toBe(true)
    expect(out).toHaveLength(RERANK.TOP_K)
  })

  it('excludes books by an already-owned author from explore (favours new authors)', async () => {
    // The "6th Seekers book" bug: exploration must never spend a slot on an author the reader
    // already owns. Seed an owned Erin Hunter book; 9 near fill exploit; the far tail carries
    // 2 more Erin Hunter books + 2 by new authors — only the new-author ones may be explored.
    seedLikedItem({ title: 'Seekers', author: 'Erin Hunter', tag: 'Fantasy' })
    const near = Array.from({ length: 9 }, (_, i) =>
      doc({ key: `/works/N${i}`, title: `Near ${i}`, author_name: [`AN${i}`] }),
    )
    const farOwned = Array.from({ length: 2 }, (_, i) =>
      doc({ key: `/works/FO${i}`, title: `More Seekers ${i}`, author_name: ['Erin Hunter'] }),
    )
    const farNew = Array.from({ length: 2 }, (_, i) =>
      doc({ key: `/works/FN${i}`, title: `Fresh ${i}`, author_name: [`Newcomer${i}`] }),
    )
    fetchMock.mockResolvedValue(okJson({ docs: [...near, ...farOwned, ...farNew] }))
    const candVer2 = `${stubEmbedder.modelVersion}|${CANDIDATE_TEXT_VERSION}`
    saveCandidateVectors(
      [
        // Near vectors are SLIGHTLY varied (all cos≈1 to taste, but mutually distinct) so MMR
        // keeps the 8 strongest in the fresh exploit slots (the weakest near spills to the tail,
        // where the redundancy wall harmlessly drops it) rather than pulling a novel far book in.
        ...Array.from({ length: 9 }, (_, i) => ({ sourceId: `/works/N${i}`, vec: v(1, 0.03 * i) })),
        // Owned far books sit at cos 0.5 ABOVE the taste axis; new-author far books at cos 0.5
        // BELOW it — same on-taste score, but a DISTINCT direction so the redundancy wall can't
        // conflate a new-author pick with the one owned book that the owned-author fraction seats
        // in exploit. Author is then the only lever deciding which far books explore may spend on.
        ...Array.from({ length: 2 }, (_, i) => ({ sourceId: `/works/FO${i}`, vec: v(0.5, 0.866) })),
        ...Array.from({ length: 2 }, (_, i) => ({
          sourceId: `/works/FN${i}`,
          vec: v(0.5, -0.866),
        })),
      ],
      candVer2,
    )

    const out = await recommend(stubEmbedder, [openLibrarySource])
    const explore = out.filter((c) => c.origin === 'explore')
    expect(explore.length).toBeGreaterThan(0)
    expect(explore.every((c) => c.sourceId.startsWith('/works/FN'))).toBe(true)
  })

  it('exploration is popularity-BLIND: explore cards keep the pure taste score, not the popularity-led one', async () => {
    // Regression for the "exploration feels the same as the traditional feed" bug: the
    // popularity prior mutates `score` in place, and if exploration ranked/emitted by that
    // boosted score the explore slots would collapse onto the grounded exploit feed. The
    // fix restores each tail candidate's PRE-popularity taste score for exploration.
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' }) // taste vec (1,0)
    // 9 near candidates (cos 1) fill the exploit quota; they carry the LOWEST readership so
    // the prior can't lift them. The 4 far candidates (cos 0.27 — above the explore floor,
    // firmly in the tail) carry the pool-MAX readership: under the bug the prior would boost
    // their score by ~WEIGHT and exploration would rank/emit that inflated number.
    const near = Array.from({ length: 9 }, (_, i) =>
      doc({
        key: `/works/N${i}`,
        title: `Near ${i}`,
        author_name: [`AN${i}`],
        readinglog_count: 10,
      }),
    )
    const far = Array.from({ length: 4 }, (_, i) =>
      doc({
        key: `/works/F${i}`,
        title: `Far ${i}`,
        author_name: [`AF${i}`],
        readinglog_count: 100000,
      }),
    )
    fetchMock.mockResolvedValue(okJson({ docs: [...near, ...far] }))
    const candVer2 = `${stubEmbedder.modelVersion}|${CANDIDATE_TEXT_VERSION}`
    saveCandidateVectors(
      [
        ...Array.from({ length: 9 }, (_, i) => ({ sourceId: `/works/N${i}`, vec: v(1, 0) })),
        ...Array.from({ length: 4 }, (_, i) => ({
          sourceId: `/works/F${i}`,
          vec: v(0.27, 0.96286),
        })),
      ],
      candVer2,
    )

    const out = await recommend(stubEmbedder, [openLibrarySource], undefined, { rng: () => 0 })
    const explore = out.filter((c) => c.origin === 'explore')
    expect(explore).toHaveLength(EXPLORE.SLOTS)
    expect(explore.every((c) => c.sourceId.startsWith('/works/F'))).toBe(true)
    // The far tail's PURE taste cosine is 0.27. Popularity (pool-max readership) would have
    // lifted the emitted score toward the exploit band; popularity-blind exploration keeps
    // it at the pure 0.27.
    expect(explore.every((c) => Math.abs(c.score - 0.27) < 1e-4)).toBe(true)
  })

  it('cannot-hurt: no owned evidence ⇒ exploration off, no card tagged (byte-identical shape)', async () => {
    // An overflowing pool that WOULD trigger exploration, but taste carries no ownedVecs
    // (cold-evidence / a pre-exploration caller) → k=0, every card is a plain exploit card.
    const docs = Array.from({ length: RERANK.TOP_K + 3 }, (_, i) =>
      doc({ key: `/works/C${i}`, title: `Cand ${i}`, author_name: [`A${i}`] }),
    )
    fetchMock.mockResolvedValue(okJson({ docs }))
    // A real seeded item so the source's taste-seed queries resolve, but an explicit
    // taste whose ownedVecs is empty (a pre-exploration caller) → the picker no-ops.
    const seedId = seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' })
    const taste: TasteResult = {
      tier: 'normal',
      centroids: [v(1, 0)],
      liked: [{ id: seedId, weight: 5 }],
      ownedVecs: [], // no evidence base ⇒ picker is a strict no-op
    }
    const out = await recommend(stubEmbedder, [openLibrarySource], taste)
    expect(out).toHaveLength(RERANK.TOP_K)
    expect(out.some((c) => c.origin !== undefined)).toBe(false)
  })

  it('forwards opts.fresh to every source (the Refresh soft-floor signal)', async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' })
    const seen: Array<{ fresh?: boolean; page?: number } | undefined> = []
    const src: CandidateSource = {
      name: 'book',
      fetch: async (_liked, opts) => {
        seen.push(opts)
        return [cand({ title: 'One', author: 'A', sourceId: '/works/C1', source: 'book' })]
      },
    }
    await recommend(stubEmbedder, [src], undefined, { fresh: true })
    expect(seen).toEqual([{ fresh: true, page: undefined }])

    seen.length = 0
    await recommend(stubEmbedder, [src]) // default read → not a fresh refresh
    expect(seen).toEqual([{ fresh: undefined, page: undefined }])
  })

  it('forwards opts.page to every source so a load-more digs a deeper window', async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' })
    const seen: Array<{ fresh?: boolean; page?: number } | undefined> = []
    const src: CandidateSource = {
      name: 'book',
      fetch: async (_liked, opts) => {
        seen.push(opts)
        return [cand({ title: 'One', author: 'A', sourceId: '/works/C1', source: 'book' })]
      },
    }
    await recommend(stubEmbedder, [src], undefined, { fresh: true, page: 3 })
    expect(seen).toEqual([{ fresh: true, page: 3 }])
  })

  it('contentMode="books" fetches only book sources and returns only books', async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' })
    const bookFetch = vi.fn(async () => [
      cand({ title: 'A Book', author: 'BA', sourceId: '/works/B1', source: 'book' }),
    ])
    const ficFetch = vi.fn(async () => [
      cand({ title: 'A Fic', author: 'FA', sourceId: 'https://ao3/1', source: 'ao3' }),
    ])
    const bookSrc: CandidateSource = { name: 'book', fetch: bookFetch }
    const ficSrc: CandidateSource = { name: 'ao3', fetch: ficFetch }

    const out = await recommend(stubEmbedder, [bookSrc, ficSrc], undefined, {
      contentMode: 'books',
    })

    expect(bookFetch).toHaveBeenCalledTimes(1)
    expect(ficFetch).not.toHaveBeenCalled() // fic source skipped entirely
    expect(out.map((c) => c.source)).toEqual(['book'])
  })

  it('contentMode="fanfiction" fetches only fic sources and returns only fics', async () => {
    seedLikedItem({ title: 'Seed', author: 'S', tag: 'Fantasy' })
    const bookFetch = vi.fn(async () => [
      cand({ title: 'A Book', author: 'BA', sourceId: '/works/B1', source: 'book' }),
    ])
    const ficFetch = vi.fn(async () => [
      cand({ title: 'A Fic', author: 'FA', sourceId: 'https://ao3/1', source: 'ao3' }),
    ])
    const bookSrc: CandidateSource = { name: 'book', fetch: bookFetch }
    const ficSrc: CandidateSource = { name: 'ao3', fetch: ficFetch }

    const out = await recommend(stubEmbedder, [bookSrc, ficSrc], undefined, {
      contentMode: 'fanfiction',
    })

    expect(ficFetch).toHaveBeenCalledTimes(1)
    expect(bookFetch).not.toHaveBeenCalled()
    expect(out.map((c) => c.source)).toEqual(['ao3'])
  })

  // ── opts.llmRerank (book bucket only) ─────────────────────────────────────
  // The stub embedder gives every candidate the same vector → equal cosine, so any
  // reordering is attributable to the injected LLM fit (the degenerate-span path).
  const threeBooks: CandidateSource = {
    name: 'book',
    fetch: async () => [
      cand({ title: 'Zero', author: 'A0', sourceId: '/works/C0', source: 'book' }),
      cand({ title: 'One', author: 'A1', sourceId: '/works/C1', source: 'book' }),
      cand({ title: 'Two', author: 'A2', sourceId: '/works/C2', source: 'book' }),
    ],
  }

  it('reorders the book bucket by the LLM fit when opts.llmRerank is supplied', async () => {
    seedLikedItem({ title: 'Seed', author: 'Owner', tag: 'Fantasy' })
    const client = {
      chatJson: vi.fn(async () => ({
        rankings: [
          { id: 'b0', fit: 0.1 },
          { id: 'b1', fit: 0.5 },
          { id: 'b2', fit: 0.9 },
        ],
      })),
    }
    const out = await recommend(stubEmbedder, [threeBooks], undefined, { llmRerank: { client } })
    expect(client.chatJson).toHaveBeenCalledTimes(1)
    // Highest fit first — the reverse of the source's cosine-tied order.
    expect(out.map((c) => c.sourceId)).toEqual(['/works/C2', '/works/C1', '/works/C0'])
  })

  it('falls back to the default order when the LLM client fails (null reply)', async () => {
    seedLikedItem({ title: 'Seed', author: 'Owner', tag: 'Fantasy' })
    const client = { chatJson: vi.fn(async () => null) }
    const out = await recommend(stubEmbedder, [threeBooks], undefined, { llmRerank: { client } })
    expect(out.map((c) => c.sourceId)).toEqual(['/works/C0', '/works/C1', '/works/C2'])
  })

  it('does not call the model when opts.llmRerank is absent (feature off)', async () => {
    seedLikedItem({ title: 'Seed', author: 'Owner', tag: 'Fantasy' })
    const out = await recommend(stubEmbedder, [threeBooks])
    expect(out.map((c) => c.sourceId)).toEqual(['/works/C0', '/works/C1', '/works/C2'])
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
