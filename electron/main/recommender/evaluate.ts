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

const EMPTY: EvalReport = {
  mrr: 0,
  hitAt5: 0,
  hitAt10: 0,
  meanPercentile: 0,
  nFolds: 0,
  nField: 0,
}

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
  const nField = items.length
  if (nField < 2) return { ...EMPTY, nField }
  const positives = items.filter((it) => it.affinity > 0)
  if (positives.length === 0) return { ...EMPTY, nField }

  let sumReciprocalRank = 0
  let hit5 = 0
  let hit10 = 0
  let sumPercentile = 0
  let folds = 0

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

    sumReciprocalRank += 1 / rank
    if (rank <= 5) hit5++
    if (rank <= 10) hit10++
    sumPercentile += 1 - (rank - 1) / (nField - 1)
    folds++
  }

  if (folds === 0) return { ...EMPTY, nField }
  return {
    mrr: sumReciprocalRank / folds,
    hitAt5: hit5 / folds,
    hitAt10: hit10 / folds,
    meanPercentile: sumPercentile / folds,
    nFolds: folds,
    nField,
  }
}
