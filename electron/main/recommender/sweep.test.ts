import { describe, it, expect } from 'vitest'
import {
  mrrOf,
  foldsFor,
  sweep1D,
  expandGrid,
  gridSearch,
  rankByMRR,
  pairedVsBaseline,
  coordinateSearch,
  splitFolds,
  sweepWithValidation,
  mrrCI,
  type SweepPoint,
} from './sweep'
import type { EvalDetail, FoldResult } from './evaluate'

// Pure search/significance/split engine — no db/model, ABI-agnostic. Tests drive it with
// synthetic EvalDetails (a config → a fixed rank per fold), so every assertion is exact
// arithmetic; there is no embedding or randomness except the seeded fold split, which is
// asserted to be reproducible.

/** A synthetic fold at a chosen rank (nField only affects percentile, irrelevant here). */
const fold = (id: string, rank: number, nField = 100): FoldResult => ({
  id,
  rank,
  reciprocalRank: 1 / rank,
  hit5: rank <= 5 ? 1 : 0,
  hit10: rank <= 10 ? 1 : 0,
  percentile: 1 - (rank - 1) / (nField - 1),
})

/** Build an EvalDetail from an {id: rank} map (report.mrr computed from the folds). */
const detail = (ranks: Record<string, number>, nField = 100): EvalDetail => {
  const folds = Object.entries(ranks).map(([id, r]) => fold(id, r, nField))
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)
  return {
    folds,
    report: {
      mrr: mean(folds.map((f) => f.reciprocalRank)),
      hitAt5: mean(folds.map((f) => f.hit5)),
      hitAt10: mean(folds.map((f) => f.hit10)),
      meanPercentile: mean(folds.map((f) => f.percentile)),
      nFolds: folds.length,
      nField,
    },
  }
}

// ── mrrOf / foldsFor ──────────────────────────────────────────────────────────
describe('mrrOf / foldsFor', () => {
  it('mrrOf averages reciprocal ranks; empty → 0', () => {
    expect(mrrOf([fold('a', 1), fold('b', 2)])).toBeCloseTo(0.75, 12) // (1 + 0.5)/2
    expect(mrrOf([])).toBe(0)
  })

  it('foldsFor keeps only folds whose id is in the set', () => {
    const fs = [fold('a', 1), fold('b', 2), fold('c', 3)]
    const kept = foldsFor(fs, new Set(['a', 'c']))
    expect(kept.map((f) => f.id)).toEqual(['a', 'c'])
  })
})

// ── config generation ──────────────────────────────────────────────────────────
describe('sweep1D / expandGrid', () => {
  interface Cfg {
    alpha: number
    beta: number
  }
  const base: Cfg = { alpha: 1, beta: 0.3 }

  it('sweep1D varies one key, holds the rest', () => {
    const cfgs = sweep1D(base, 'beta', [0, 0.3, 0.6])
    expect(cfgs).toEqual([
      { alpha: 1, beta: 0 },
      { alpha: 1, beta: 0.3 },
      { alpha: 1, beta: 0.6 },
    ])
    expect(base.beta).toBe(0.3) // base untouched
  })

  it('expandGrid is the cartesian product of the given axes', () => {
    const cfgs = expandGrid(base, { alpha: [1, 2], beta: [0, 0.5] })
    expect(cfgs).toEqual([
      { alpha: 1, beta: 0 },
      { alpha: 1, beta: 0.5 },
      { alpha: 2, beta: 0 },
      { alpha: 2, beta: 0.5 },
    ])
  })

  it('expandGrid skips empty/absent axes (base value kept)', () => {
    expect(expandGrid(base, { alpha: [], beta: [0.1] })).toEqual([{ alpha: 1, beta: 0.1 }])
    expect(expandGrid(base, {})).toEqual([{ alpha: 1, beta: 0.3 }])
  })
})

// ── gridSearch / rankByMRR ──────────────────────────────────────────────────────
describe('gridSearch / rankByMRR', () => {
  it('evaluates every config in order via the injected evalFn', () => {
    const seen: number[] = []
    const evalFn = (c: number): EvalDetail => {
      seen.push(c)
      return detail({ x: c }) // rank = c → higher c is WORSE
    }
    const pts = gridSearch([1, 3, 2], evalFn)
    expect(seen).toEqual([1, 3, 2]) // input order
    expect(pts.map((p) => p.config)).toEqual([1, 3, 2])
  })

  it('rankByMRR sorts descending and is stable on ties', () => {
    const points: SweepPoint<string>[] = [
      { config: 'lo', detail: detail({ a: 4 }) }, // mrr .25
      { config: 'tieA', detail: detail({ a: 2 }) }, // mrr .5
      { config: 'hi', detail: detail({ a: 1 }) }, // mrr 1
      { config: 'tieB', detail: detail({ a: 2 }) }, // mrr .5 (ties tieA)
    ]
    const ranked = rankByMRR(points)
    expect(ranked.map((p) => p.config)).toEqual(['hi', 'tieA', 'tieB', 'lo'])
    expect(points[0].config).toBe('lo') // input not mutated
  })
})

// ── pairedVsBaseline ─────────────────────────────────────────────────────────
describe('pairedVsBaseline', () => {
  const baseline = detail({ a: 2, b: 4, c: 4 }) // rr: .5, .25, .25

  it('a uniformly-better config yields a CI strictly above 0', () => {
    const better: SweepPoint<string> = { config: 'better', detail: detail({ a: 1, b: 2, c: 2 }) }
    const ci = pairedVsBaseline(better, baseline, { seed: 1 })
    expect(ci.mean).toBeGreaterThan(0)
    expect(ci.lo).toBeGreaterThan(0) // every paired diff positive → whole band > 0
  })

  it('an identical config yields a degenerate zero interval', () => {
    const same: SweepPoint<string> = { config: 'same', detail: detail({ a: 2, b: 4, c: 4 }) }
    const ci = pairedVsBaseline(same, baseline, { seed: 1 })
    expect(ci.mean).toBe(0)
    expect(ci.lo).toBe(0)
    expect(ci.hi).toBe(0)
  })

  it('joins on fold id — only shared folds are paired', () => {
    // config has an extra fold 'd' and is missing 'c'; only a,b pair.
    const cfg: SweepPoint<string> = { config: 'x', detail: detail({ a: 1, b: 2, d: 1 }) }
    const ci = pairedVsBaseline(cfg, baseline, { seed: 1 })
    // diffs: a (1-.5=.5), b (.5-.25=.25) → mean .375
    expect(ci.mean).toBeCloseTo(0.375, 12)
  })
})

// ── coordinateSearch ───────────────────────────────────────────────────────────
describe('coordinateSearch', () => {
  // A 1-D objective peaked at x=5: score = -|x-5| (so mrr is maximal, 0, at x=5).
  // Neighbors step ±1.
  const scored = (x: number): EvalDetail => {
    const d = detail({ only: 1 })
    d.report = { ...d.report, mrr: -Math.abs(x - 5) } // encode the objective in mrr
    return d
  }
  const neighbors = (x: number): number[] => [x - 1, x + 1]

  it('climbs to the local optimum and stops', () => {
    const res = coordinateSearch(0, neighbors, scored)
    expect(res.config).toBe(5) // peak
    expect(res.detail.report.mrr).toBeCloseTo(0, 12) // -|5-5| (== -0)
  })

  it('records every evaluated config in history (start + all neighbors)', () => {
    const res = coordinateSearch(4, neighbors, scored)
    expect(res.config).toBe(5)
    // start(4) + 2 neighbors/round; it moves 4→5 then 5's neighbors don't improve → stop.
    expect(res.history[0].config).toBe(4)
    expect(res.history.length).toBeGreaterThanOrEqual(3)
    expect(res.history.some((h) => h.config === 5)).toBe(true)
  })

  it('a start already at the optimum makes no move', () => {
    const res = coordinateSearch(5, neighbors, scored)
    expect(res.config).toBe(5)
    expect(res.history[0].config).toBe(5)
  })

  it('respects maxRounds (stops before reaching the peak)', () => {
    const res = coordinateSearch(0, neighbors, scored, { maxRounds: 2 })
    expect(res.config).toBe(2) // 0→1→2 in two rounds
  })

  it('a custom score function overrides the default MRR', () => {
    // Default (mrr) peaks at x=5; a custom score = +|x-5| peaks the OTHER way (unbounded),
    // so from x=5 it climbs away. Neighbors ±1, capped by maxRounds to keep it finite.
    const res = coordinateSearch(5, neighbors, scored, {
      maxRounds: 3,
      score: (d) => -d.report.mrr, // invert: now larger |x-5| wins
    })
    // neighbors are evaluated [x-1, x+1] with STRICT improvement, so ties go to the lower
    // neighbor → it walks down: 5→4→3→2 over three rounds.
    expect(res.config).toBe(2)
  })
})

// ── splitFolds ──────────────────────────────────────────────────────────────────
describe('splitFolds', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `id${i}`)

  it('partitions all ids with no overlap, ~trainRatio in train', () => {
    const { train, valid } = splitFolds(ids, 0.7, 42)
    expect(train.size).toBe(7)
    expect(valid.size).toBe(3)
    const union = new Set([...train, ...valid])
    expect(union.size).toBe(10) // covers everything
    for (const id of train) expect(valid.has(id)).toBe(false) // disjoint
  })

  it('is deterministic for a fixed seed and independent of input order', () => {
    const a = splitFolds(ids, 0.7, 7)
    const b = splitFolds([...ids].reverse(), 0.7, 7)
    expect([...a.train].sort()).toEqual([...b.train].sort())
    expect([...a.valid].sort()).toEqual([...b.valid].sort())
  })

  it('different seeds generally give different splits', () => {
    const a = [...splitFolds(ids, 0.7, 1).train].sort()
    const b = [...splitFolds(ids, 0.7, 2).train].sort()
    expect(a).not.toEqual(b)
  })

  it('< 2 ids → everything in train, empty validation', () => {
    expect(splitFolds(['solo'], 0.5, 1)).toEqual({ train: new Set(['solo']), valid: new Set() })
    expect(splitFolds([], 0.5, 1)).toEqual({ train: new Set(), valid: new Set() })
  })

  it('always leaves at least one id on each side for n ≥ 2', () => {
    expect(splitFolds(['a', 'b'], 0.99, 1).valid.size).toBe(1) // ratio can't starve valid
    expect(splitFolds(['a', 'b'], 0.01, 1).train.size).toBe(1) // ... or train
  })
})

// ── sweepWithValidation ──────────────────────────────────────────────────────────
describe('sweepWithValidation', () => {
  // 6 folds: t0..t3 train, v0..v1 valid.
  const split = { train: new Set(['t0', 't1', 't2', 't3']), valid: new Set(['v0', 'v1']) }
  const baseline = detail({ t0: 4, t1: 4, t2: 4, t3: 4, v0: 4, v1: 4 }) // rr .25 everywhere

  it('selects the best config on TRAIN and reports its delta on VALID', () => {
    // A: big train gain, but validation NO better than baseline (overfit) → not significant.
    const overfit = detail({ t0: 1, t1: 1, t2: 1, t3: 1, v0: 4, v1: 4 })
    // B: modest, consistent gain on both splits.
    const honest = detail({ t0: 2, t1: 2, t2: 2, t3: 2, v0: 2, v1: 2 })
    const points: SweepPoint<string>[] = [
      { config: 'overfit', detail: overfit },
      { config: 'honest', detail: honest },
    ]
    const res = sweepWithValidation(points, baseline, split, { seed: 1 })
    // Train MRR: overfit=1.0 > honest=.5 → the overfit config is SELECTED.
    expect(res.best.config).toBe('overfit')
    expect(res.trainMrr).toBeCloseTo(1.0, 12)
    expect(res.trainDelta.lo).toBeGreaterThan(0) // train delta looks great...
    // ...but on validation the overfit config equals baseline → delta 0, NOT significant.
    expect(res.validDelta.mean).toBe(0)
    expect(res.significant).toBe(false)
  })

  it('a genuinely-better config validates (validDelta.lo > 0, significant)', () => {
    const honest = detail({ t0: 2, t1: 2, t2: 2, t3: 2, v0: 2, v1: 2 })
    const res = sweepWithValidation([{ config: 'honest', detail: honest }], baseline, split, {
      seed: 1,
    })
    expect(res.best.config).toBe('honest')
    expect(res.validDelta.lo).toBeGreaterThan(0) // .5-.25 on both valid folds → band > 0
    expect(res.significant).toBe(true)
  })

  it('ties in train MRR resolve to the earliest config', () => {
    const d = detail({ t0: 2, t1: 2, t2: 2, t3: 2, v0: 2, v1: 2 })
    const points: SweepPoint<string>[] = [
      { config: 'first', detail: d },
      { config: 'second', detail: detail({ t0: 2, t1: 2, t2: 2, t3: 2, v0: 3, v1: 3 }) },
    ]
    expect(sweepWithValidation(points, baseline, split, { seed: 1 }).best.config).toBe('first')
  })

  it('empty validation split → not significant (cannot validate)', () => {
    const allTrain = { train: new Set(['t0', 't1', 't2', 't3']), valid: new Set<string>() }
    const honest = detail({ t0: 2, t1: 2, t2: 2, t3: 2 })
    const res = sweepWithValidation([{ config: 'honest', detail: honest }], baseline, allTrain, {
      seed: 1,
    })
    expect(res.significant).toBe(false)
    expect(res.validDelta.lo).toBe(res.validDelta.hi) // degenerate interval
  })

  it('throws on an empty config list', () => {
    expect(() => sweepWithValidation([], baseline, split)).toThrow(/no configs/i)
  })
})

// ── mrrCI ─────────────────────────────────────────────────────────────────────
describe('mrrCI', () => {
  it('brackets the point MRR', () => {
    const point: SweepPoint<string> = { config: 'x', detail: detail({ a: 1, b: 2, c: 3, d: 4 }) }
    const ci = mrrCI(point, { seed: 1 })
    expect(ci.mean).toBeCloseTo(point.detail.report.mrr, 12)
    expect(ci.lo).toBeLessThanOrEqual(ci.mean)
    expect(ci.hi).toBeGreaterThanOrEqual(ci.mean)
  })
})
