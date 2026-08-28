import { describe, it, expect } from 'vitest'
import {
  EXPLORE,
  uncertainty,
  regionalEvidence,
  exploreObjective,
  pickExplorePicks,
  type ExploreConfig,
} from './explore'
import { cosine } from './vectorMath'
import type { ScoredCandidate } from './rerank'
import type { Candidate } from './candidates'

// explore.ts is pure / ABI-agnostic — synthetic unit vectors, no db, no ABI toggle.

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
  pages: 200, // default: a known substantive length so candidates clear the explore length gate
  ...over,
})

const scored = (
  id: string,
  vec: Float32Array,
  score = 0.5,
  over: Partial<Candidate> = {},
): ScoredCandidate => ({
  cand: cand({ sourceId: id, ...over }),
  vec,
  score,
})

const cfg = (over: Partial<ExploreConfig> = {}): ExploreConfig => ({ ...EXPLORE, ...over })

describe('uncertainty', () => {
  it('is 1 with no evidence and decays monotonically as evidence accrues', () => {
    expect(uncertainty(0)).toBe(1)
    expect(uncertainty(3)).toBeCloseTo(0.5, 5) // 1/sqrt(4)
    expect(uncertainty(1)).toBeGreaterThan(uncertainty(2))
    expect(uncertainty(2)).toBeGreaterThan(uncertainty(10))
  })
})

describe('regionalEvidence', () => {
  it('accumulates a squared kernel over owned vectors above the floor', () => {
    // One owned vector aligned with the candidate: cos 1 → (1 − 0.2)² = 0.64.
    expect(regionalEvidence(v(1, 0), [v(1, 0)], 0.2)).toBeCloseTo(0.64, 5)
    // Two aligned owned vectors → twice the evidence (abundance accumulates).
    expect(regionalEvidence(v(1, 0), [v(1, 0), v(1, 0)], 0.2)).toBeCloseTo(1.28, 5)
  })

  it('drops owned vectors at or below the floor as noise', () => {
    // Orthogonal (cos 0 < floor) contributes nothing.
    expect(regionalEvidence(v(0, 0, 1), [v(1, 0, 0), v(0, 1, 0)], 0.2)).toBe(0)
  })

  it('counts franchise ABUNDANCE that a hard neighbour wall (cos ≥ 0.5) would discard', () => {
    // The crux fix: 15 owned franchise items each at cos 0.45 to a companion candidate —
    // every one BELOW a 0.5 hard wall, so a hard neighbour count would be 0 ("novel!").
    // u=(0.45, √(1−0.45²)) is a unit vector at cosine 0.45 from v(1,0).
    const belowWall = v(0.45, Math.sqrt(1 - 0.45 * 0.45))
    const companion = v(1, 0)
    expect(cosine(companion, belowWall)).toBeCloseTo(0.45, 5) // confirm: below a 0.5 wall
    const owned = Array.from({ length: 15 }, () => belowWall)
    const evidence = regionalEvidence(companion, owned, 0.2)
    // Yet 15 sub-wall items accumulate real evidence: 15·(0.45−0.2)² ≈ 0.94.
    expect(evidence).toBeCloseTo(15 * (0.45 - 0.2) ** 2, 5)
    expect(evidence).toBeGreaterThan(0.9)
  })
})

describe('exploreObjective', () => {
  it('multiplies taste score by region uncertainty (peaks on on-taste × under-observed)', () => {
    expect(exploreObjective(0.5, 0)).toBeCloseTo(0.5, 5) // on-taste, wholly novel → full
    expect(exploreObjective(0.5, 3)).toBeCloseTo(0.25, 5) // same taste, saturated → halved
    // Irrelevant-but-novel loses to on-taste-and-novel: 0.15·1 < 0.5·1.
    expect(exploreObjective(0.15, 0)).toBeLessThan(exploreObjective(0.5, 0))
  })
})

describe('pickExplorePicks', () => {
  // Owned evidence: the reader lives in the +x region (enough mass to saturate it).
  const owned = Array.from({ length: 8 }, () => v(1, 0, 0))
  const top = () => (): number => 0 // deterministic RNG → strict top-of-band

  it('cuts a far-from-taste book below the relative floor (the bearing-book fix)', () => {
    // A maximally-NOVEL but irrelevant book (orthogonal → uncertainty 1) is rejected,
    // because it is far below the relative floor set by a strong near-miss — even though
    // pure-novelty ranking would have crowned it. This is the core regression.
    const onTaste = scored('on-taste', v(0.9, 0.1, 0), 0.6) // a genuine near-miss
    const junk = scored('junk', v(0, 0, 1), 0.15) // "ball & roller bearing engineering"
    const picks = pickExplorePicks([onTaste, junk], owned, cfg({ SLOTS: 3 }), top())
    expect(picks.map((p) => p.cand.sourceId)).toEqual(['on-taste'])
  })

  it('among on-taste books, prefers the one in an under-observed region', () => {
    // Both clear the floor (equal score); the novel-region book wins on the objective
    // because the near-owned one is discounted by its high regional evidence.
    const nearOwned = scored('near', v(1, 0, 0), 0.5) // deep in known +x territory
    const novel = scored('novel', v(0, 0, 1), 0.5) // orthogonal → no evidence
    const picks = pickExplorePicks([nearOwned, novel], owned, cfg({ SLOTS: 1 }), top())
    expect(picks.map((p) => p.cand.sourceId)).toEqual(['novel'])
  })

  it('rejects candidates below the plausibility floor (under-fills rather than picks junk)', () => {
    const junk = scored('junk', v(0, 0, 1), 0.05) // novel but below the absolute backstop
    const picks = pickExplorePicks([junk], owned, cfg({ SLOTS: 2 }), top())
    expect(picks).toEqual([])
  })

  it('returns at most SLOTS picks', () => {
    const tail = [
      scored('n1', v(0, 0, 1), 0.5),
      scored('n2', v(0, 1, 0), 0.5),
      scored('n3', v(0, 1, 1), 0.5),
    ]
    expect(pickExplorePicks(tail, owned, cfg({ SLOTS: 2 }), top()).length).toBe(2)
  })

  it('varies its picks across refreshes (samples the top band via the RNG)', () => {
    // Four equally-eligible novel books; with OVERSAMPLE 2 the top band is 4, and two
    // different RNGs draw two different leading picks — the anti-staleness property.
    const tail = [
      scored('b1', v(0, 0, 1), 0.5),
      scored('b2', v(0, 1, 0), 0.5),
      scored('b3', v(0, -1, 0), 0.5),
      scored('b4', v(0, 0, -1), 0.5),
    ]
    const c = cfg({ SLOTS: 2, OVERSAMPLE: 2 })
    const first = pickExplorePicks(tail, owned, c, () => 0)[0].cand.sourceId
    const second = pickExplorePicks(tail, owned, c, () => 0.99)[0].cand.sourceId
    expect(first).not.toEqual(second)
  })

  it('draws from books only — fanfiction in the tail is never explored', () => {
    // A maximally-novel fic (orthogonal, top score) loses to a book. Fics are already
    // search-friendly; the explore budget is spent on the harder book-discovery problem.
    const fic = { cand: cand({ sourceId: 'fic', source: 'ao3' }), vec: v(0, 0, 1), score: 0.9 }
    const book = scored('book', v(0, 1, 0), 0.5)
    const picks = pickExplorePicks([fic, book], owned, cfg({ SLOTS: 3 }), top())
    expect(picks.map((p) => p.cand.sourceId)).toEqual(['book'])
  })

  it('rejects a book with no known page count (structural length gate)', () => {
    // The no-page-count picture-book leak: a perfectly novel, on-taste book with no length
    // metadata is ineligible; a substantive sibling in the same novel region is picked.
    const noPages = scored('nopages', v(0, 0, 1), 0.6, { pages: undefined })
    const substantive = scored('real', v(0, 1, 0), 0.6, { pages: 180 })
    const picks = pickExplorePicks([noPages, substantive], owned, cfg({ SLOTS: 3 }), top())
    expect(picks.map((p) => p.cand.sourceId)).toEqual(['real'])
  })

  it('rejects a book shorter than MIN_EXPLORE_PAGES', () => {
    const tooShort = scored('short', v(0, 0, 1), 0.6, { pages: 30 })
    expect(pickExplorePicks([tooShort], owned, cfg({ SLOTS: 2 }), top())).toEqual([])
  })

  it('rejects nonfiction (no fiction marker) even when novel and on-taste', () => {
    // A seed-science textbook: substantive length, on-taste enough, maximally novel — but no
    // fiction subject, so it never reaches the objective. A fiction sibling is picked instead.
    const textbook = scored('textbook', v(0, 0, 1), 0.6, { subjects: ['Seeds', 'Agriculture'] })
    const novel = scored('novel', v(0, 1, 0), 0.6, { subjects: ['Fantasy'] })
    const picks = pickExplorePicks([textbook, novel], owned, cfg({ SLOTS: 3 }), top())
    expect(picks.map((p) => p.cand.sourceId)).toEqual(['novel'])
  })

  it('drops an explore pick too similar to a visible exploit card (redundancy wall)', () => {
    // Two equally-eligible novel books; one points the same way as an emitted exploit card
    // (cos 1 > MAX_EXPLOIT_SIM) so it just echoes the normal feed and is dropped, leaving
    // the genuinely-distinct one. No-op when no exploit vecs are passed (the other tests).
    const echo = scored('echo', v(0, 1, 0), 0.6) // identical direction to the exploit card
    const distinct = scored('distinct', v(0, 0, 1), 0.6) // orthogonal to it
    const picks = pickExplorePicks([echo, distinct], owned, cfg({ SLOTS: 3 }), top(), [v(0, 1, 0)])
    expect(picks.map((p) => p.cand.sourceId)).toEqual(['distinct'])
  })

  it('is a no-op when the tail is all fanfiction (books-only, under-fills)', () => {
    const tail = [{ cand: cand({ sourceId: 'f1', source: 'ffn' }), vec: v(0, 0, 1), score: 0.9 }]
    expect(pickExplorePicks(tail, owned, cfg({ SLOTS: 3 }), top())).toEqual([])
  })

  it('is a no-op when SLOTS <= 0', () => {
    const tail = [scored('novel', v(0, 0, 1), 0.9)]
    expect(pickExplorePicks(tail, owned, cfg({ SLOTS: 0 }), top())).toEqual([])
  })

  it('is a no-op with an empty tail', () => {
    expect(pickExplorePicks([], owned, cfg({ SLOTS: 3 }), top())).toEqual([])
  })

  it('is a no-op with no owned evidence (cold start / bare taste)', () => {
    const tail = [scored('novel', v(0, 0, 1), 0.9)]
    expect(pickExplorePicks(tail, [], cfg({ SLOTS: 3 }), top())).toEqual([])
  })
})
