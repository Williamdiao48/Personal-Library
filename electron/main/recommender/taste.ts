import { loadItemSignals, type ItemWithSignals } from './signals'
import { affinity } from './affinity'
import { loadVectors } from './store'
import { normalize, scale, sub, weightedMeanNormalized } from './vectorMath'

// C3.5 — the taste vector (§7.3 graded Rocchio) + the cold-start tier classifier
// (§8) + the orchestrator that reads signals and vectors and assembles both. The
// centroid math and tier logic are pure (ABI-agnostic); only `buildTaste` touches
// the db (via loadItemSignals/loadVectors) → its test needs the Node ABI.
//
// The taste vector is recomputed on demand, never persisted (D7): it's a weighted
// sum of cached item vectors, microseconds to rebuild, with no invalidation bugs.

export type ColdStartTier = 'empty' | 'thin' | 'normal' | 'power'

/** A liked item and its (positive) affinity weight — Chunk 4 seeds queries from
 *  the highest-weight items' tags/authors. */
export interface LikedItem {
  id: string
  weight: number
}

export interface TasteResult {
  tier: ColdStartTier
  /** k=1 for v1 (D5 seam); empty when there's no liked+embedded item (cold start). */
  centroids: Float32Array[]
  /** Positive-affinity items, weight-descending — for Chunk 4 query seeding. */
  liked: LikedItem[]
}

export const TASTE = {
  ALPHA: 1.0, // liked-centroid weight
  BETA: 0.3, // disliked-centroid subtraction (α>β: don't over-penalize)
  THIN_MAX: 4, // 1..THIN_MAX embeddable items → thin
  NORMAL_MAX: 20, // THIN_MAX+1..NORMAL_MAX → normal; above → power
} as const

/**
 * Graded Rocchio taste centroid(s) (§7.3): the weighted liked centroid minus
 * β·the weighted disliked centroid, L2-normalized. Items missing from `vecs`
 * (un-embedded, mid-backfill) are skipped. Empty liked set → `[]` (cold start).
 * Returns a length-1 array (k=1, D5); the rerank scores `max` over centroids so
 * upgrading to k>1 is an internal change with no consumer churn.
 */
export function buildTasteCentroids(
  sigs: ItemWithSignals[],
  vecs: Map<string, Float32Array>,
): Float32Array[] {
  const liked: { e: Float32Array; w: number }[] = []
  const disliked: { e: Float32Array; w: number }[] = []
  for (const s of sigs) {
    const e = vecs.get(s.id)
    if (!e) continue // skip un-embedded items
    const a = affinity(s)
    if (a > 0) liked.push({ e, w: a })
    else if (a < 0) disliked.push({ e, w: -a })
  }
  if (liked.length === 0) return [] // cold-start guard (§8)

  const cPos = weightedMeanNormalized(liked)
  const cNeg = disliked.length ? weightedMeanNormalized(disliked) : null
  const taste = cNeg ? normalize(sub(scale(cPos, TASTE.ALPHA), scale(cNeg, TASTE.BETA))) : cPos
  return [taste]
}

/**
 * Cold-start tier (§8) by the count of **embeddable** items (the caller passes
 * only items that have a vector). Ratings sharpen the taste vector's quality
 * within a tier; the tier boundary itself is breadth (count) driven.
 */
export function classifyTier(embeddable: ItemWithSignals[]): ColdStartTier {
  const n = embeddable.length
  if (n === 0) return 'empty'
  if (n <= TASTE.THIN_MAX) return 'thin'
  if (n <= TASTE.NORMAL_MAX) return 'normal'
  return 'power'
}

/**
 * Read the library's feedback signals + stored vectors and assemble the taste
 * result: the cold-start tier, the k=1 taste centroid (empty on cold start), and
 * the weight-descending liked set. Un-embedded items are excluded from all three.
 */
export function buildTaste(): TasteResult {
  const sigs = loadItemSignals()
  const vecs = loadVectors(sigs.map((s) => s.id)) // only embedded ids come back
  const embeddable = sigs.filter((s) => vecs.has(s.id))

  const tier = classifyTier(embeddable)
  const centroids = buildTasteCentroids(embeddable, vecs)
  const liked = embeddable
    .map((s) => ({ id: s.id, weight: affinity(s) }))
    .filter((x) => x.weight > 0)
    .sort((a, b) => b.weight - a.weight)

  return { tier, centroids, liked }
}
