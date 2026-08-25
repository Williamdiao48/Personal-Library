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

/** k-selection strategy. `auto` = silhouette model-selection (the number of facets is
 *  chosen from the data); `count` = legacy `round(n/TARGET_SIZE)` (facets scale only
 *  with library size, blind to whether real clusters exist). */
export type KSelect = 'auto' | 'count'

export const CLUSTER = {
  TARGET_SIZE: 8, // ('count' mode) ~one centroid per this many liked items
  MAX_CENTROIDS: 3, // cap on taste facets
  ITERS: 10, // Lloyd iterations (early-exits when assignments stabilize)
  DEDUP_COS: 0.98, // merge centroids more similar than this (uniform taste → 1 facet)
  /** How many facets to build. `auto` lets the data decide (see chooseKBySilhouette);
   *  `count` is the size-only legacy rule. Default `auto` — self-adapts per reader. */
  SELECT: 'auto' as KSelect,
  /** ('auto' mode) accept a k>1 split only if its mean silhouette clears this bar.
   *  Kaufman–Rousseeuw bands: <0.25 ≈ "no substantial structure", 0.25–0.5 weak,
   *  0.5–0.7 reasonable, >0.7 strong. Set at the "reasonable structure" boundary (0.5),
   *  NOT the weaker 0.25: the offline eval showed that on a real library a *weakly*
   *  separable split (silhouette ≈0.47) still ranks held-out liked items WORSE than a
   *  single centroid — cluster quality ≠ ranking quality, so only split on structure
   *  strong enough to be worth fragmenting the taste vector over. A coherent library
   *  scores below this and stays at k=1; a genuinely multi-facet reader clears it.
   *  See docs/internal/planning/recommender/eval-benchmark-log.md (finding F-2). */
  MIN_SILHOUETTE: 0.5,
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
 * One fixed-k weighted spherical k-means run over the (already canonically-sorted)
 * items. Maximin init → Lloyd iterations (assign to nearest centroid, recompute as the
 * weighted mean of members, drop empty clusters). Returns the centroids AND a final
 * member assignment recomputed against those centroids — `chooseKBySilhouette` needs
 * the assignment, which the centroids alone can't give. Deterministic; no dedup here
 * (the caller dedups once k is fixed).
 */
function clusterWithK(
  sorted: WeightedVec[],
  k: number,
  cfg = CLUSTER,
): { centroids: Float32Array[]; assign: number[] } {
  let centroids = maximinSeeds(sorted, k)
  let assign: number[] = new Array<number>(sorted.length).fill(-1)
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
  // Recompute the assignment against the FINAL centroids so it's consistent with them
  // (the loop's last `assign` may predate the final recompute / empty-cluster drops).
  return { centroids, assign: sorted.map((it) => nearest(it.e, centroids)) }
}

/**
 * Mean silhouette of an assignment, using cosine distance `d = 1 − cos` (vectors are
 * unit-length). For each item: `a` = mean distance to its own cluster, `b` = the min
 * over other clusters of the mean distance to that cluster, `s = (b − a)/max(a, b)`.
 * Items in a singleton cluster contribute 0 (convention). Needs ≥2 non-empty clusters
 * — fewer means "no split to score" → `NaN`. O(n²), but n (liked items) is small.
 */
function meanSilhouette(sorted: WeightedVec[], assign: number[], numClusters: number): number {
  const n = sorted.length
  const groups: number[][] = Array.from({ length: numClusters }, () => [])
  for (let i = 0; i < n; i++) if (assign[i] >= 0) groups[assign[i]].push(i)
  if (groups.filter((g) => g.length > 0).length < 2) return NaN

  const dist = (i: number, j: number): number => 1 - cosine(sorted[i].e, sorted[j].e)
  let total = 0
  for (let i = 0; i < n; i++) {
    const own = groups[assign[i]]
    if (own.length <= 1) continue // singleton → s = 0
    let a = 0
    for (const j of own) if (j !== i) a += dist(i, j)
    a /= own.length - 1
    let b = Infinity
    for (let c = 0; c < numClusters; c++) {
      if (c === assign[i] || groups[c].length === 0) continue
      let m = 0
      for (const j of groups[c]) m += dist(i, j)
      m /= groups[c].length
      if (m < b) b = m
    }
    total += (b - a) / Math.max(a, b)
  }
  return total / n
}

/** The chosen facet count plus the per-k silhouette scores it was chosen from
 *  (exposed so the eval/harness can show *why* a given k was picked). */
export interface KChoice {
  k: number
  /** Mean silhouette at each evaluated k≥2 (NaN-scoring k's omitted). */
  silhouettes: { k: number; score: number }[]
}

/**
 * Silhouette model-selection for the facet count: cluster at every k in
 * `2..min(MAX_CENTROIDS, n)`, score each split's mean silhouette, and take the k with
 * the highest score — but accept it only if that score clears `MIN_SILHOUETTE`;
 * otherwise fall back to **k=1** (a single centroid). This is the adaptive replacement
 * for the size-only `pickK`: a reader whose liked items form no separable clusters
 * (high mutual similarity) scores low and stays at one centroid, while a genuinely
 * multi-facet reader clears the bar and gets per-facet centroids — no hand-set count.
 * Deterministic: canonically sorts its input first (so the maximin seeds — and thus
 * the k≥3 partitions — are independent of caller row order), then clusters and scores.
 */
export function chooseKBySilhouette(items: WeightedVec[], cfg = CLUSTER): KChoice {
  const sorted = canonicalSort(items)
  const kMax = Math.min(cfg.MAX_CENTROIDS, sorted.length)
  const silhouettes: { k: number; score: number }[] = []
  let bestK = 1
  let bestScore = -Infinity
  for (let k = 2; k <= kMax; k++) {
    const { centroids, assign } = clusterWithK(sorted, k, cfg)
    const score = meanSilhouette(sorted, assign, centroids.length)
    if (Number.isNaN(score)) continue
    silhouettes.push({ k, score })
    if (score > bestScore) {
      bestScore = score
      bestK = k
    }
  }
  return { k: bestScore >= cfg.MIN_SILHOUETTE ? bestK : 1, silhouettes }
}

/**
 * Cluster the weighted liked vectors into k per-facet centroids. The facet count k is
 * chosen by `cfg.SELECT`: `auto` = silhouette model-selection (`chooseKBySilhouette`,
 * data-driven), `count` = the legacy size-only `pickK`. Weighted spherical k-means
 * (unit vectors, so cosine = dot): maximin init → Lloyd iterations → drop empty
 * clusters → merge near-duplicates. `k ≤ 1` returns the single weighted-mean centroid
 * (byte-identical to the pre-cluster behavior). Empty input → `[]`. Deterministic.
 */
export function clusterLikedCentroids(items: WeightedVec[], cfg = CLUSTER): Float32Array[] {
  const n = items.length
  if (n === 0) return []
  const sorted = canonicalSort(items)
  const single = (): Float32Array[] => {
    const c = weightedMeanNormalized(sorted.map((it) => ({ e: it.e, w: it.w })))
    return c.length ? [c] : []
  }

  const k = cfg.SELECT === 'auto' ? chooseKBySilhouette(sorted, cfg).k : pickK(n, cfg)
  if (k <= 1) return single()

  const { centroids } = clusterWithK(sorted, k, cfg)
  if (centroids.length <= 1) return centroids.length ? centroids : single()
  return dedupCentroids(centroids, cfg.DEDUP_COS)
}
