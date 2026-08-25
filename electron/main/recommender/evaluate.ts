// Offline quality metric (audit finding #5) — the PURE half. Turns a set of embedded
// library items + their affinities into a single ranking-quality number, with no db,
// no model, and no network → committed + unit-tested + ABI-agnostic. The real-library
// runner that feeds it your actual library.db lives in the gitignored, opt-in
// `evaluate.harness.test.ts` (same seam as tasteCluster.ts vs the eyeball harnesses).
//
// Method — leave-one-out over high-affinity items (§5 of the weak-points audit):
// for each held-out liked item `h`, rebuild taste from *everyone else*, then check how
// high `h` ranks against the whole field. A high rank means "the reader's OTHER taste
// predicts this liked item" — the same generalization the recommender leans on when it
// ranks unseen candidates. The field is the whole library (Option A): on a
// positive-skewed library (most are) there are too few true negatives to rank against,
// and other positives "pollute" the rank *equally across config variants*, so
// before/after deltas on a FIXED library stay a valid monotone tuning signal. This is a
// RELATIVE gate ("did that tweak move the number?"), not an absolute accuracy claim.
//
// Bias to keep in mind: kept items helped build the centroid they're scored against
// (in-sample advantage), so `h` (out-of-sample) is judged against a mildly lifted
// field. That bias is constant on a fixed library, so it cancels in deltas.

/** One embedded library item: its vector and its affinity (the relevance label). */
export interface EvalItem {
  id: string
  vec: Float32Array
  /** affinity ∈ [−1, +1] from the ladder; `> 0` marks a held-out "relevant" item. */
  affinity: number
}

/** The single-number report. `nFolds` = liked items actually evaluated; `nField` =
 *  the pool size each fold ranks against (the whole embedded library). */
export interface EvalReport {
  /** Mean reciprocal rank over the folds — the headline number (1 = always ranks #1). */
  mrr: number
  /** Fraction of held-out liked items landing in the top 5 / top 10. */
  hitAt5: number
  hitAt10: number
  /** Mean of `1 − (rank−1)/(nField−1)` — library-size-robust (1 = best, 0 = worst). */
  meanPercentile: number
  nFolds: number
  nField: number
}

/** One held-out item's outcome. Kept so callers can bootstrap the metrics (CIs) and
 *  pair two configs fold-by-fold — the aggregate `EvalReport` alone can't do either. */
export interface FoldResult {
  /** The held-out item's id — the join key for paired A/B comparisons. */
  id: string
  rank: number
  /** `1 / rank` — the per-fold value MRR averages. */
  reciprocalRank: number
  hit5: 0 | 1
  hit10: 0 | 1
  /** `1 − (rank−1)/(nField−1)`. */
  percentile: number
}

/** `leaveOneOut`'s aggregate plus the per-fold rows behind it (skipped folds omitted). */
export interface EvalDetail {
  report: EvalReport
  folds: FoldResult[]
}

const EMPTY: EvalReport = {
  mrr: 0,
  hitAt5: 0,
  hitAt10: 0,
  meanPercentile: 0,
  nFolds: 0,
  nField: 0,
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)

/**
 * Leave-one-out ranking quality over the positive-affinity items.
 *
 * `buildCentroids` and `scoreFn` are injected so this stays decoupled from the db/model
 * — the harness passes the real `buildTasteCentroids` (adapted) and `scoreCandidate`,
 * while callers exploring finding #1 can swap in a metadata-only centroid to A/B the
 * embedding-space mismatch. `scoreFn` is only ever called with a non-empty centroid set
 * (empty-taste folds are skipped), matching `scoreCandidate`'s contract.
 *
 * Ranking is optimistic on ties (a distractor must score *strictly* higher to outrank
 * `h`), so an exact-match held-out item ranks #1. Folds whose kept set has no positive
 * (so `buildCentroids` returns `[]`) are unrankable and skipped; `nFolds` counts only
 * the folds actually scored. Fewer than 2 items, or no positives, → an all-zero report.
 */
export function leaveOneOut(
  items: EvalItem[],
  buildCentroids: (kept: EvalItem[]) => Float32Array[],
  scoreFn: (vec: Float32Array, centroids: Float32Array[]) => number,
): EvalReport {
  return leaveOneOutDetail(items, buildCentroids, scoreFn).report
}

/**
 * The same leave-one-out pass as {@link leaveOneOut}, but also returning the per-fold
 * rows (`FoldResult[]`) the aggregate is built from. Callers need those rows to
 * **bootstrap** confidence intervals on the metrics ({@link bootstrapMeanCI}) and to
 * **pair** two configs fold-by-fold ({@link pairedDeltaCI}) — neither of which is
 * recoverable from the averaged `EvalReport`. The aggregate `report` is byte-identical
 * to what `leaveOneOut` returns (same optimistic-tie ranking, same skipped-fold rule).
 */
export function leaveOneOutDetail(
  items: EvalItem[],
  buildCentroids: (kept: EvalItem[]) => Float32Array[],
  scoreFn: (vec: Float32Array, centroids: Float32Array[]) => number,
): EvalDetail {
  const nField = items.length
  if (nField < 2) return { report: { ...EMPTY, nField }, folds: [] }
  const positives = items.filter((it) => it.affinity > 0)
  if (positives.length === 0) return { report: { ...EMPTY, nField }, folds: [] }

  const folds: FoldResult[] = []
  for (const h of positives) {
    const kept = items.filter((it) => it.id !== h.id)
    const centroids = buildCentroids(kept)
    if (centroids.length === 0) continue // no taste without h → unrankable fold

    const hScore = scoreFn(h.vec, centroids)
    // Rank of h = 1 + (distractors scoring strictly higher). Ties favor h (optimistic),
    // so an exact taste match ranks #1 even when in-sample items tie it.
    let strictlyBetter = 0
    for (const d of kept) {
      if (scoreFn(d.vec, centroids) > hScore) strictlyBetter++
    }
    const rank = strictlyBetter + 1 // 1-based; best possible = 1, worst = nField
    folds.push({
      id: h.id,
      rank,
      reciprocalRank: 1 / rank,
      hit5: rank <= 5 ? 1 : 0,
      hit10: rank <= 10 ? 1 : 0,
      percentile: 1 - (rank - 1) / (nField - 1),
    })
  }

  if (folds.length === 0) return { report: { ...EMPTY, nField }, folds: [] }
  const report: EvalReport = {
    mrr: mean(folds.map((f) => f.reciprocalRank)),
    hitAt5: mean(folds.map((f) => f.hit5)),
    hitAt10: mean(folds.map((f) => f.hit10)),
    meanPercentile: mean(folds.map((f) => f.percentile)),
    nFolds: folds.length,
    nField,
  }
  return { report, folds }
}

// ─────────────────────────────────────────────────────────────────────────────
// Uncertainty layer. A leave-one-out point estimate on a ~40-fold personal library
// is noisy: sd/√n means a small MRR move can be pure resampling luck. These helpers
// attach error bars so a tuning delta is only believed when it clears the noise.
//
// Everything is a DETERMINISTIC bootstrap (seeded PRNG) so a given fold set → the same
// interval every run — reproducible baselines, stable tests, no flakes.
// ─────────────────────────────────────────────────────────────────────────────

/** A bootstrap interval: the point estimate plus a [lo, hi] percentile band. */
export interface CI {
  /** The observed mean (the point estimate the interval surrounds). */
  mean: number
  lo: number
  hi: number
}

/** Deterministic PRNG (mulberry32) → reproducible resamples from a seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Linear-interpolated quantile of an already-sorted array. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]
  const idx = q * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

export interface BootstrapOpts {
  /** Resamples (default 2000 — plenty for a stable 95% band, still instant). */
  iters?: number
  /** Two-sided miss rate (default 0.05 → a 95% interval). */
  alpha?: number
  /** PRNG seed (default fixed) — pin it for reproducible intervals. */
  seed?: number
}

/**
 * Percentile bootstrap CI for the **mean** of a per-fold value array (e.g. every
 * fold's `reciprocalRank` → a CI on MRR). Resamples the folds with replacement `iters`
 * times, recomputes the mean each time, and reads the `alpha/2` … `1−alpha/2`
 * percentiles of that distribution. `< 2` values → a degenerate interval at the mean
 * (nothing to resample).
 */
export function bootstrapMeanCI(values: number[], opts: BootstrapOpts = {}): CI {
  const m = mean(values)
  const n = values.length
  if (n < 2) return { mean: m, lo: m, hi: m }
  const iters = opts.iters ?? 2000
  const alpha = opts.alpha ?? 0.05
  const rand = mulberry32(opts.seed ?? 0x9e3779b9)
  const means: number[] = new Array(iters)
  for (let b = 0; b < iters; b++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += values[(rand() * n) | 0]
    means[b] = sum / n
  }
  means.sort((x, y) => x - y)
  return { mean: m, lo: quantile(means, alpha / 2), hi: quantile(means, 1 - alpha / 2) }
}

/**
 * **Paired** bootstrap CI on the mean per-fold difference between two configs
 * (`metric(a) − metric(b)`), inner-joined on fold id. Because both configs are scored
 * on the *same* held-out items, pairing cancels the shared per-item variance — the
 * correct, far tighter test for "did this change help?" than comparing two independent
 * CIs. **Read it as significant only when the returned `[lo, hi]` excludes 0** (`lo > 0`
 * ⇒ a real gain, `hi < 0` ⇒ a real regression, straddling 0 ⇒ indistinguishable from
 * noise on this library). Folds present in only one config are dropped (can't pair).
 */
export function pairedDeltaCI(
  a: FoldResult[],
  b: FoldResult[],
  metric: (f: FoldResult) => number,
  opts: BootstrapOpts = {},
): CI {
  const bById = new Map(b.map((f) => [f.id, f]))
  const diffs: number[] = []
  for (const fa of a) {
    const fb = bById.get(fa.id)
    if (fb) diffs.push(metric(fa) - metric(fb))
  }
  return bootstrapMeanCI(diffs, opts)
}
