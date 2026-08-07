import { cosine, weightedMeanNormalized } from './vectorMath'

// Multi-facet taste clustering. A single weighted-mean centroid (§7.3) blurs a
// reader with distinct tastes (dark fantasy + cozy romance + hard SF) into one
// vector that sits *between* the clusters and matches each facet weakly, so minor-
// facet candidates get a mediocre cosine and get buried. This splits the LIKED item
// vectors into k>1 per-facet centroids via deterministic weighted spherical k-means;
// `scoreCandidate` already takes the MAX cosine over the returned centroids, so a
// candidate is judged against its NEAREST facet. Pure (no db/model) → ABI-agnostic.
//
// Determinism is a hard requirement: taste is recomputed on every refresh, so a
// non-deterministic clusterer would make the feed jitter between refreshes. Init is
// farthest-first (maximin) with no RNG, and inputs are canonically sorted, so the
// output is a pure function of the input set (independent of DB row order).

export const CLUSTER = {
  TARGET_SIZE: 8, // ~one centroid per this many liked items (splitting starts ~12)
  MAX_CENTROIDS: 3, // cap on taste facets
  ITERS: 10, // Lloyd iterations (early-exits when assignments stabilize)
  DEDUP_COS: 0.98, // merge centroids more similar than this (uniform taste → 1 facet)
} as const

/** A liked item's embedding + affinity weight + a stable key for deterministic ties. */
export interface WeightedVec {
  e: Float32Array
  w: number
  key: string
}

/**
 * How many centroids for `n` liked items: `round(n / TARGET_SIZE)`, clamped to
 * [1, MAX_CENTROIDS] and never more than `n`. `n = 0 → 0`. Small/thin libraries stay
 * at k=1 (identical to the single-centroid behavior), so only libraries with enough
 * signal split into facets.
 */
export function pickK(n: number, cfg = CLUSTER): number {
  if (n <= 0) return 0
  const k = Math.round(n / cfg.TARGET_SIZE)
  return Math.min(Math.max(k, 1), cfg.MAX_CENTROIDS, n)
}

/** Canonical order for determinism: weight desc, then key asc. */
function canonicalSort(items: WeightedVec[]): WeightedVec[] {
  return [...items].sort((a, b) => b.w - a.w || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** Index of the nearest centroid to `e` by cosine (ties → lowest index). */
function nearest(e: Float32Array, centroids: Float32Array[]): number {
  let best = 0
  let bestCos = -Infinity
  for (let c = 0; c < centroids.length; c++) {
    const cs = cosine(e, centroids[c])
    if (cs > bestCos) {
      bestCos = cs
      best = c
    }
  }
  return best
}

/** Drop centroids that duplicate an earlier one (cosine > threshold); keeps the first. */
function dedupCentroids(centroids: Float32Array[], threshold: number): Float32Array[] {
  const out: Float32Array[] = []
  for (const c of centroids) {
    if (!out.some((o) => cosine(c, o) > threshold)) out.push(c)
  }
  return out
}

/** Farthest-first (maximin) seed indices: highest-weight item, then each next = the
 *  item least similar (min max-cosine) to the seeds chosen so far. Deterministic. */
function maximinSeeds(sorted: WeightedVec[], k: number): Float32Array[] {
  const seeds: Float32Array[] = [sorted[0].e]
  const chosen = new Set<number>([0])
  while (seeds.length < k) {
    let best = -1
    let bestScore = Infinity // want the item with the SMALLEST max-cosine to any seed
    for (let i = 0; i < sorted.length; i++) {
      if (chosen.has(i)) continue
      let maxCos = -Infinity
      for (const s of seeds) {
        const c = cosine(sorted[i].e, s)
        if (c > maxCos) maxCos = c
      }
      if (maxCos < bestScore) {
        bestScore = maxCos
        best = i
      }
    }
    if (best === -1) break // ran out of distinct items
    chosen.add(best)
    seeds.push(sorted[best].e)
  }
  return seeds
}

/**
 * Cluster the weighted liked vectors into k per-facet centroids (k from `pickK`).
 * Weighted spherical k-means (vectors are unit-length, so cosine = dot): maximin
 * init → Lloyd iterations (assign to nearest centroid, recompute as the weighted-mean
 * of members) → drop empty clusters → merge near-duplicates. `k ≤ 1` returns the
 * single weighted-mean centroid (byte-identical to the pre-cluster behavior). Empty
 * input → `[]`. Deterministic.
 */
export function clusterLikedCentroids(items: WeightedVec[], cfg = CLUSTER): Float32Array[] {
  const n = items.length
  if (n === 0) return []
  const sorted = canonicalSort(items)
  const k = pickK(n, cfg)
  if (k <= 1) {
    const c = weightedMeanNormalized(sorted.map((it) => ({ e: it.e, w: it.w })))
    return c.length ? [c] : []
  }

  let centroids = maximinSeeds(sorted, k)
  let assign: number[] = new Array<number>(n).fill(-1)
  for (let iter = 0; iter < cfg.ITERS; iter++) {
    const next = sorted.map((it) => nearest(it.e, centroids))
    if (next.length === assign.length && next.every((v, i) => v === assign[i])) break // stable
    assign = next
    const recomputed: Float32Array[] = []
    for (let c = 0; c < centroids.length; c++) {
      const members = sorted.filter((_, i) => assign[i] === c).map((it) => ({ e: it.e, w: it.w }))
      if (members.length > 0) recomputed.push(weightedMeanNormalized(members)) // drop empty clusters
    }
    centroids = recomputed
    if (centroids.length <= 1) break
  }

  return dedupCentroids(centroids, cfg.DEDUP_COS)
}
