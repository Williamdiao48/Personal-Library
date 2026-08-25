// Config sweep (roadmap #2) — the PURE half. A search + significance + overfitting-guard
// engine over the ranking constants, driven by the offline eval. Committed +
// unit-tested + ABI-agnostic (no db, no model, no network): it is generic over an opaque
// config `C` and an injected `evalFn: (c) => EvalDetail`, mirroring the buildCentroids/
// scoreFn injection seam in evaluate.ts. The real-library driver that maps a config onto
// the actual taste centroids lives in the gitignored `evaluate.harness.test.ts`.
//
// Why an engine, not a script: hand-picking constants and eyeballing MRR invites two
// classic errors this module exists to prevent —
//   1. believing a delta that is within noise (→ every candidate is compared to the
//      baseline with a PAIRED bootstrap CI; a change is "accepted" only when its CI
//      excludes 0 — the same gate that rejected roadmap #4), and
//   2. reporting the winner of a many-config search as if it were unbiased (winner's
//      curse / multiple comparisons) — the best of N noisy configs looks better than it
//      is. The fix is a train/validation split: SELECT the best config on the train
//      folds, then REPORT its delta on held-out validation folds. A win that survives
//      validation is credible; one that evaporates was overfit to this library.
//
// The metric only sees the taste-centroid → cosine stage (that is all `leaveOneOut`
// scores). MMR/quota/book-diversity/LLM-rerank are downstream of it and are NOT tunable
// here — see the scope doc.

import {
  bootstrapMeanCI,
  pairedDeltaCI,
  type BootstrapOpts,
  type CI,
  type EvalDetail,
  type FoldResult,
} from './evaluate'

/** One evaluated config: the config itself and the leave-one-out detail it produced. */
export interface SweepPoint<C> {
  config: C
  detail: EvalDetail
}

/** Deterministic PRNG (mulberry32), duplicated from evaluate.ts (kept private there) so
 *  the fold split is reproducible without widening that module's surface. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)

/** MRR over a fold subset (mean reciprocal rank); `0` for an empty set. The per-fold
 *  metric the sweep optimizes and compares — kept here so callers restrict folds to a
 *  train/validation split and re-score without reaching into `EvalReport`. */
export function mrrOf(folds: FoldResult[]): number {
  return mean(folds.map((f) => f.reciprocalRank))
}

/** The folds whose held-out id is in `ids` — used to restrict a detail to a train or
 *  validation split (both a config and the baseline are sliced by the SAME id set so the
 *  paired comparison still lines up fold-for-fold). */
export function foldsFor(folds: FoldResult[], ids: Set<string>): FoldResult[] {
  return folds.filter((f) => ids.has(f.id))
}

// ─────────────────────────────────────────────────────────────────────────────
// Config generation. The harness owns the knob semantics; these just build the config
// LIST (a 1-D response curve, or a joint grid) to hand to `gridSearch`.
// ─────────────────────────────────────────────────────────────────────────────

/** One knob's response curve: `base` with a single `key` set to each of `values`. The
 *  first, cheapest diagnostic — which knobs move the metric at all before spending a
 *  joint search (cf. the auto-k per-k silhouette table). */
export function sweep1D<C, K extends keyof C>(base: C, key: K, values: C[K][]): C[] {
  return values.map((v) => ({ ...base, [key]: v }) as C)
}

/** Cartesian product of several knobs over `base`: every combination of the supplied
 *  per-key value lists (keys with an empty/absent list are left at their base value).
 *  Order is deterministic (axis order = `Object.keys(axes)`, values in list order). */
export function expandGrid<C>(base: C, axes: Partial<{ [K in keyof C]: C[K][] }>): C[] {
  let out: C[] = [{ ...base }]
  for (const key of Object.keys(axes) as (keyof C)[]) {
    const values = axes[key]
    if (!values || values.length === 0) continue
    const next: C[] = []
    for (const cfg of out) for (const v of values) next.push({ ...cfg, [key]: v } as C)
    out = next
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Search.
// ─────────────────────────────────────────────────────────────────────────────

/** Evaluate every config through the injected `evalFn`, in input order. Pure relative to
 *  `evalFn` — no ranking, no side effects — so the caller decides how to select. */
export function gridSearch<C>(configs: C[], evalFn: (c: C) => EvalDetail): SweepPoint<C>[] {
  return configs.map((config) => ({ config, detail: evalFn(config) }))
}

/** Points sorted by MRR descending (stable: equal-MRR points keep their input order).
 *  Returns a new array; the input is not mutated. */
export function rankByMRR<C>(points: SweepPoint<C>[]): SweepPoint<C>[] {
  return points
    .map((p, i) => ({ p, i }))
    .sort((x, y) => y.p.detail.report.mrr - x.p.detail.report.mrr || x.i - y.i)
    .map(({ p }) => p)
}

/** Paired ΔMRR (config − baseline) over whatever folds each carries, joined on id. A
 *  thin wrapper over `pairedDeltaCI` fixed to the reciprocal-rank metric — the "did this
 *  config beat the baseline?" test. Believe it only when the CI excludes 0. */
export function pairedVsBaseline<C>(
  point: SweepPoint<C>,
  baseline: EvalDetail,
  opts: BootstrapOpts = {},
): CI {
  return pairedDeltaCI(point.detail.folds, baseline.folds, (f) => f.reciprocalRank, opts)
}

/**
 * Greedy **coordinate ascent** on the eval objective: from `start`, evaluate the
 * `neighbors(current)` (each a config differing in one knob), and move to the best
 * neighbor only if it STRICTLY improves the score; repeat until no neighbor improves or
 * `maxRounds` is hit. Strict improvement guarantees termination (the score is monotone
 * non-decreasing over a finite neighbourhood). Deterministic whenever `neighbors` and
 * `evalFn` are. `score` defaults to MRR. Every evaluated config is recorded in `history`
 * (for the benchmark log / to bootstrap the accepted move afterwards).
 */
export function coordinateSearch<C>(
  start: C,
  neighbors: (c: C) => C[],
  evalFn: (c: C) => EvalDetail,
  opts: { maxRounds?: number; score?: (d: EvalDetail) => number } = {},
): { config: C; detail: EvalDetail; history: SweepPoint<C>[] } {
  const maxRounds = opts.maxRounds ?? 20
  const score = opts.score ?? ((d: EvalDetail) => d.report.mrr)

  let config = start
  let detail = evalFn(start)
  let best = score(detail)
  const history: SweepPoint<C>[] = [{ config, detail }]

  for (let round = 0; round < maxRounds; round++) {
    let movedTo: SweepPoint<C> | null = null
    let movedScore = best
    for (const c of neighbors(config)) {
      const d = evalFn(c)
      history.push({ config: c, detail: d })
      const s = score(d)
      if (s > movedScore) {
        movedScore = s
        movedTo = { config: c, detail: d }
      }
    }
    if (!movedTo) break // local optimum: no neighbor strictly improves
    config = movedTo.config
    detail = movedTo.detail
    best = movedScore
  }
  return { config, detail, history }
}

// ─────────────────────────────────────────────────────────────────────────────
// Overfitting-honest selection. This is the point of the module.
// ─────────────────────────────────────────────────────────────────────────────

/** A deterministic train/validation partition of fold ids. `trainRatio` is the fraction
 *  routed to TRAIN; ids are sorted (order-independent) then seeded-shuffled so the split
 *  is reproducible from `seed`. `< 2` ids → everything in train, empty validation. */
export function splitFolds(
  ids: string[],
  trainRatio: number,
  seed: number,
): { train: Set<string>; valid: Set<string> } {
  const sorted = [...ids].sort()
  if (sorted.length < 2) return { train: new Set(sorted), valid: new Set() }
  const rand = mulberry32(seed)
  // Fisher–Yates over the sorted copy → deterministic shuffle.
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0
    ;[sorted[i], sorted[j]] = [sorted[j], sorted[i]]
  }
  const nTrain = Math.min(sorted.length - 1, Math.max(1, Math.round(sorted.length * trainRatio)))
  return { train: new Set(sorted.slice(0, nTrain)), valid: new Set(sorted.slice(nTrain)) }
}

/** The result of {@link sweepWithValidation}: the config picked on the training folds,
 *  plus its delta-vs-baseline on BOTH splits. `trainDelta` is the (optimistic) selection
 *  metric; `validDelta` is the honest report; `significant` is `validDelta.lo > 0`. */
export interface ValidatedSweep<C> {
  best: SweepPoint<C>
  /** ΔMRR vs baseline on the TRAIN folds — the metric `best` was chosen to maximize, so
   *  it is biased upward (winner's curse). Reported for transparency, not as the win. */
  trainDelta: CI
  /** ΔMRR vs baseline on the held-out VALIDATION folds — the credible, unbiased report. */
  validDelta: CI
  /** Whether the validated improvement clears noise (`validDelta.lo > 0`). */
  significant: boolean
  /** The chosen config's MRR on the training folds (the raw selection score). */
  trainMrr: number
}

/**
 * Select the best config on the TRAIN folds and report its improvement on the held-out
 * VALIDATION folds — the overfitting guard. Selection is by train MRR (equivalently, best
 * paired gain vs a fixed baseline on the train split); the return then re-measures that
 * one config's paired ΔMRR-vs-baseline on the validation split, where — having taken no
 * part in the selection — the estimate is unbiased. A change is `significant` only when
 * `validDelta.lo > 0`.
 *
 * `points` must be non-empty. Ties in train MRR resolve to the earliest in `points`
 * (deterministic). Both a config and the baseline are sliced by the same split id set so
 * the pairing holds. When the validation split is empty (tiny library), `validDelta`
 * degenerates to a point interval and `significant` is false — you cannot validate a win
 * you had no data to hold out.
 */
export function sweepWithValidation<C>(
  points: SweepPoint<C>[],
  baseline: EvalDetail,
  split: { train: Set<string>; valid: Set<string> },
  opts: BootstrapOpts = {},
): ValidatedSweep<C> {
  if (points.length === 0) throw new Error('sweepWithValidation: no configs to select from')

  let best = points[0]
  let bestMrr = mrrOf(foldsFor(points[0].detail.folds, split.train))
  for (let i = 1; i < points.length; i++) {
    const m = mrrOf(foldsFor(points[i].detail.folds, split.train))
    if (m > bestMrr) {
      bestMrr = m
      best = points[i]
    }
  }

  const rr = (f: FoldResult): number => f.reciprocalRank
  const trainDelta = pairedDeltaCI(
    foldsFor(best.detail.folds, split.train),
    foldsFor(baseline.folds, split.train),
    rr,
    opts,
  )
  const validDelta = pairedDeltaCI(
    foldsFor(best.detail.folds, split.valid),
    foldsFor(baseline.folds, split.valid),
    rr,
    opts,
  )
  return { best, trainDelta, validDelta, significant: validDelta.lo > 0, trainMrr: bestMrr }
}

/** Convenience over {@link bootstrapMeanCI}: the 95% CI on a config's own MRR (over its
 *  folds, or a split subset). For printing per-config baselines in the harness. */
export function mrrCI<C>(point: SweepPoint<C>, opts: BootstrapOpts = {}): CI {
  return bootstrapMeanCI(
    point.detail.folds.map((f) => f.reciprocalRank),
    opts,
  )
}
