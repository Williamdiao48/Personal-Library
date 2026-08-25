import { describe, it, expect } from 'vitest'
import {
  leaveOneOut,
  leaveOneOutDetail,
  bootstrapMeanCI,
  pairedDeltaCI,
  type EvalItem,
  type FoldResult,
} from './evaluate'
import { cosine, normalize } from './vectorMath'

// Pure ranking-quality math — no db/model, ABI-agnostic. Two flavors of test:
//  1. a CONTROLLED scoreFn (`vec[0]` = the score) to place a held-out item at an exact
//     rank and pin MRR / hit@k / percentile arithmetic;
//  2. a REALISTIC geometric run (cosine to a mean centroid) to sanity-check end-to-end.

const item = (id: string, affinity: number, vec: Float32Array): EvalItem => ({ id, affinity, vec })

/** A builder that returns the (weight=affinity) mean of the kept positives, or [] when
 *  the kept set has no positive — mirrors buildTasteCentroids' cold-start guard. */
const meanPositiveBuilder = (kept: EvalItem[]): Float32Array[] => {
  const pos = kept.filter((k) => k.affinity > 0)
  if (pos.length === 0) return []
  const dim = pos[0].vec.length
  const acc = new Float32Array(dim)
  for (const p of pos) for (let i = 0; i < dim; i++) acc[i] += p.vec[i] * p.affinity
  return [normalize(acc)]
}

const maxCosine = (vec: Float32Array, cs: Float32Array[]): number =>
  cs.reduce((best, c) => Math.max(best, cosine(vec, c)), -Infinity)

const v = (...xs: number[]) => normalize(Float32Array.from(xs))

// ── Guards ───────────────────────────────────────────────────────────────────
describe('leaveOneOut — guards', () => {
  const dummyBuilder = () => [Float32Array.from([1])]
  const byFirst = (vec: Float32Array) => vec[0]

  it('empty input → all-zero report', () => {
    expect(leaveOneOut([], dummyBuilder, byFirst)).toEqual({
      mrr: 0,
      hitAt5: 0,
      hitAt10: 0,
      meanPercentile: 0,
      nFolds: 0,
      nField: 0,
    })
  })

  it('a single item cannot be ranked → zero report (nField reported)', () => {
    const r = leaveOneOut([item('a', 1, v(1, 0))], dummyBuilder, byFirst)
    expect(r.nFolds).toBe(0)
    expect(r.nField).toBe(1)
    expect(r.mrr).toBe(0)
  })

  it('no positive-affinity items → nothing to hold out → zero report', () => {
    const items = [item('a', 0, v(1, 0)), item('b', -0.5, v(0, 1))]
    const r = leaveOneOut(items, dummyBuilder, byFirst)
    expect(r.nFolds).toBe(0)
    expect(r.nField).toBe(2)
  })

  it('a lone positive among negatives → its fold has no taste → skipped', () => {
    // Holding out the only positive leaves a positive-less kept set, so the realistic
    // builder returns [] → the fold is unrankable and dropped (folds = 0).
    const items = [item('p', 1, v(1, 0)), item('n1', -0.5, v(0, 1)), item('n2', -0.5, v(0, 1))]
    const r = leaveOneOut(items, meanPositiveBuilder, maxCosine)
    expect(r.nFolds).toBe(0)
    expect(r.nField).toBe(3)
  })
})

// ── Controlled scoreFn: exact rank arithmetic ─────────────────────────────────
describe('leaveOneOut — exact rank arithmetic (score = vec[0])', () => {
  const fixedBuilder = () => [Float32Array.from([1])] // non-empty so folds are scored
  const byFirst = (vec: Float32Array) => vec[0]

  it('places held-out items at known ranks and averages MRR / hit@k / percentile', () => {
    // Two positives (A=0.5, B=0.9) + five neutral distractors (0.91..0.95).
    const items = [
      item('A', 1, Float32Array.from([0.5])),
      item('B', 1, Float32Array.from([0.9])),
      item('d1', 0, Float32Array.from([0.95])),
      item('d2', 0, Float32Array.from([0.94])),
      item('d3', 0, Float32Array.from([0.93])),
      item('d4', 0, Float32Array.from([0.92])),
      item('d5', 0, Float32Array.from([0.91])),
    ]
    const r = leaveOneOut(items, fixedBuilder, byFirst)

    // Hold out A (0.5): B + 5 distractors all strictly higher → rank 7.
    // Hold out B (0.9): 5 distractors strictly higher, A is not → rank 6.
    expect(r.nFolds).toBe(2)
    expect(r.nField).toBe(7)
    expect(r.mrr).toBeCloseTo((1 / 7 + 1 / 6) / 2, 10)
    expect(r.hitAt5).toBe(0) // ranks 6 and 7 both miss top-5
    expect(r.hitAt10).toBe(1) // both within top-10
    // percentile: rank 7 → 0 (worst), rank 6 → 1 − 5/6.
    expect(r.meanPercentile).toBeCloseTo((0 + (1 - 5 / 6)) / 2, 10)
  })

  it('ties are optimistic — an equal-scoring distractor does not outrank the held-out', () => {
    const items = [
      item('A', 1, Float32Array.from([0.8])),
      item('B', 1, Float32Array.from([0.8])), // ties A
      item('d', 0, Float32Array.from([0.1])),
    ]
    const r = leaveOneOut(items, fixedBuilder, byFirst)
    // Each fold: the other positive ties (not strictly greater), the distractor is lower
    // → rank 1 for both → MRR 1, everyone in top-5.
    expect(r.mrr).toBe(1)
    expect(r.hitAt5).toBe(1)
    expect(r.meanPercentile).toBe(1)
  })
})

// ── Realistic geometry: predictive vs non-predictive libraries ────────────────
describe('leaveOneOut — realistic (cosine to a mean centroid)', () => {
  it('a coherent library scores a perfect MRR (held-out matches the shared taste)', () => {
    // 4 identical "east" positives + 3 orthogonal "north" neutrals. Holding out an east
    // rebuilds an east centroid; the held-out east ties the other easts (rank 1) and
    // buries the norths.
    const items = [
      ...Array.from({ length: 4 }, (_, i) => item(`e${i}`, 1, v(1, 0, 0))),
      ...Array.from({ length: 3 }, (_, i) => item(`n${i}`, 0, v(0, 1, 0))),
    ]
    const r = leaveOneOut(items, meanPositiveBuilder, maxCosine)
    expect(r.nFolds).toBe(4)
    expect(r.nField).toBe(7)
    expect(r.mrr).toBeCloseTo(1, 6)
    expect(r.hitAt5).toBe(1)
    expect(r.meanPercentile).toBeCloseTo(1, 6)
  })

  it('an incoherent library scores strictly worse than a coherent one', () => {
    const coherent = [
      ...Array.from({ length: 4 }, (_, i) => item(`e${i}`, 1, v(1, 0, 0))),
      ...Array.from({ length: 3 }, (_, i) => item(`n${i}`, 0, v(0, 1, 0))),
    ]
    // Mutually orthogonal positives: holding one out leaves a centroid it doesn't match,
    // while neutrals aligned with the remaining positives outrank it.
    const incoherent = [
      item('px', 1, v(1, 0, 0)),
      item('py', 1, v(0, 1, 0)),
      item('pz', 1, v(0, 0, 1)),
      item('dy', 0, v(0, 1, 0)),
      item('dz', 0, v(0, 0, 1)),
    ]
    const rc = leaveOneOut(coherent, meanPositiveBuilder, maxCosine)
    const ri = leaveOneOut(incoherent, meanPositiveBuilder, maxCosine)
    expect(ri.mrr).toBeLessThan(rc.mrr)
    expect(ri.meanPercentile).toBeLessThan(rc.meanPercentile)
  })
})

// ── Per-fold detail (the rows the uncertainty layer bootstraps) ────────────────
describe('leaveOneOutDetail — per-fold rows behind the aggregate', () => {
  const fixedBuilder = () => [Float32Array.from([1])]
  const byFirst = (vec: Float32Array) => vec[0]

  it('exposes one FoldResult per scored fold with an aggregate equal to leaveOneOut', () => {
    const items = [
      item('A', 1, Float32Array.from([0.5])),
      item('B', 1, Float32Array.from([0.9])),
      item('d1', 0, Float32Array.from([0.95])),
      item('d2', 0, Float32Array.from([0.94])),
    ]
    const detail = leaveOneOutDetail(items, fixedBuilder, byFirst)
    expect(detail.folds.map((f) => f.id).sort()).toEqual(['A', 'B'])
    expect(detail.report).toEqual(leaveOneOut(items, fixedBuilder, byFirst))
    // A (0.5): B + 2 distractors strictly higher → rank 4; B (0.9): 2 distractors → rank 3.
    const byId = new Map(detail.folds.map((f) => [f.id, f]))
    expect(byId.get('A')!.rank).toBe(4)
    expect(byId.get('B')!.rank).toBe(3)
    expect(byId.get('B')!.reciprocalRank).toBeCloseTo(1 / 3, 10)
  })

  it('skipped (unrankable) folds are omitted from the rows', () => {
    const items = [item('p', 1, v(1, 0)), item('n1', -0.5, v(0, 1)), item('n2', -0.5, v(0, 1))]
    const detail = leaveOneOutDetail(items, meanPositiveBuilder, maxCosine)
    expect(detail.folds).toHaveLength(0)
    expect(detail.report.nField).toBe(3)
  })
})

// ── Uncertainty: bootstrap CI on a per-fold mean ──────────────────────────────
describe('bootstrapMeanCI — error bars on a per-fold mean', () => {
  it('reports the exact arithmetic mean as the point estimate', () => {
    expect(bootstrapMeanCI([0.2, 0.4, 0.6]).mean).toBeCloseTo(0.4, 10)
  })

  it('a constant sample → a degenerate interval at the mean (no spread)', () => {
    const ci = bootstrapMeanCI([0.5, 0.5, 0.5, 0.5])
    expect(ci.lo).toBeCloseTo(0.5, 10)
    expect(ci.hi).toBeCloseTo(0.5, 10)
  })

  it('< 2 values → interval collapses to the mean', () => {
    expect(bootstrapMeanCI([0.7])).toEqual({ mean: 0.7, lo: 0.7, hi: 0.7 })
    expect(bootstrapMeanCI([])).toEqual({ mean: 0, lo: 0, hi: 0 })
  })

  it('brackets the mean and is deterministic for a fixed seed', () => {
    const data = [0, 0.1, 0.2, 0.9, 1, 0.3, 0.05, 0.5]
    const a = bootstrapMeanCI(data, { seed: 42 })
    const b = bootstrapMeanCI(data, { seed: 42 })
    expect(a).toEqual(b) // same seed → identical interval (reproducible)
    expect(a.lo).toBeLessThanOrEqual(a.mean)
    expect(a.hi).toBeGreaterThanOrEqual(a.mean)
    expect(a.lo).toBeLessThan(a.hi) // a varied sample has real spread
  })

  it('lower-variance samples yield a narrower band than higher-variance ones (same mean)', () => {
    const tight = [0.45, 0.5, 0.5, 0.55]
    const wide = [0.0, 0.1, 0.9, 1.0]
    const t = bootstrapMeanCI(tight, { seed: 7 })
    const w = bootstrapMeanCI(wide, { seed: 7 })
    expect(t.mean).toBeCloseTo(w.mean, 10) // both mean 0.5
    expect(t.hi - t.lo).toBeLessThan(w.hi - w.lo)
  })
})

// ── Uncertainty: paired A/B delta ─────────────────────────────────────────────
describe('pairedDeltaCI — paired A/B significance', () => {
  const rr = (f: FoldResult) => f.reciprocalRank
  const fr = (id: string, reciprocalRank: number): FoldResult => ({
    id,
    rank: Math.round(1 / reciprocalRank),
    reciprocalRank,
    hit5: 0,
    hit10: 0,
    percentile: 0,
  })

  it('identical configs → a zero delta interval', () => {
    const a = [fr('x', 1), fr('y', 0.5), fr('z', 0.25)]
    const ci = pairedDeltaCI(a, a, rr)
    expect(ci.mean).toBeCloseTo(0, 10)
    expect(ci.lo).toBeCloseTo(0, 10)
    expect(ci.hi).toBeCloseTo(0, 10)
  })

  it('a uniformly-better config → CI excludes 0 (a real, significant gain)', () => {
    const worse = [fr('x', 0.2), fr('y', 0.25), fr('z', 0.1), fr('w', 0.5), fr('v', 0.33)]
    const better = [fr('x', 1), fr('y', 1), fr('z', 0.5), fr('w', 1), fr('v', 1)]
    const ci = pairedDeltaCI(better, worse, rr)
    expect(ci.mean).toBeGreaterThan(0)
    expect(ci.lo).toBeGreaterThan(0) // whole interval above 0 ⇒ believe the gain
  })

  it('a wash (some up, some down, mean ~0) → CI straddles 0 (noise)', () => {
    const a = [fr('x', 1), fr('y', 0.2), fr('z', 1), fr('w', 0.2)]
    const b = [fr('x', 0.2), fr('y', 1), fr('z', 0.2), fr('w', 1)]
    const ci = pairedDeltaCI(a, b, rr)
    expect(ci.lo).toBeLessThan(0)
    expect(ci.hi).toBeGreaterThan(0)
  })

  it('joins on fold id — folds present in only one config are dropped', () => {
    const a = [fr('x', 1), fr('y', 1), fr('only-a', 0.1)]
    const b = [fr('x', 0.5), fr('y', 0.5)] // no 'only-a'
    // Only x,y pair → diffs [0.5, 0.5] → degenerate interval at 0.5.
    const ci = pairedDeltaCI(a, b, rr)
    expect(ci.mean).toBeCloseTo(0.5, 10)
    expect(ci.lo).toBeCloseTo(0.5, 10)
    expect(ci.hi).toBeCloseTo(0.5, 10)
  })
})
