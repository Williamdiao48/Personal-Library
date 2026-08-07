import { describe, it, expect } from 'vitest'
import { leaveOneOut, type EvalItem } from './evaluate'
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
