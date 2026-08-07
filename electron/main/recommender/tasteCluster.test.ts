import { describe, it, expect } from 'vitest'
import { clusterLikedCentroids, pickK, CLUSTER, type WeightedVec } from './tasteCluster'
import { cosine, normalize } from './vectorMath'

// Pure spherical-k-means clustering — no db/model, ABI-agnostic. Vectors are built
// unit-length (the app's invariant) so cosine is a plain dot.

const v = (...xs: number[]): Float32Array => normalize(Float32Array.from(xs))
const item = (e: Float32Array, w = 1, key = Math.random().toString()): WeightedVec => ({
  e,
  w,
  key,
})

/** k=2-forcing config: split at ≥ 2 items so the small fixtures below cluster. */
const K2 = { ...CLUSTER, TARGET_SIZE: 3 }

describe('pickK', () => {
  it('scales with count, clamped to [1, MAX] and never above n', () => {
    expect(pickK(0)).toBe(0)
    expect(pickK(1)).toBe(1) // clamp up to 1
    expect(pickK(8)).toBe(1) // round(8/8)
    expect(pickK(12)).toBe(2) // round(12/8) = 2 — splitting starts here
    expect(pickK(24)).toBe(3) // round(24/8) = 3
    expect(pickK(100)).toBe(3) // capped at MAX_CENTROIDS
    expect(pickK(2)).toBe(1) // round(2/8)=0 → clamped up
  })
})

describe('clusterLikedCentroids', () => {
  it('empty input → no centroids', () => {
    expect(clusterLikedCentroids([])).toEqual([])
  })

  it('below the split threshold → one weighted-mean centroid', () => {
    const items = [item(v(1, 0, 0)), item(v(1, 0.1, 0))]
    const out = clusterLikedCentroids(items) // default cfg, n=2 → k=1
    expect(out).toHaveLength(1)
    expect(cosine(out[0], v(1, 0, 0))).toBeGreaterThan(0.9)
  })

  it('splits two well-separated groups into one centroid each', () => {
    const groupA = Array.from({ length: 4 }, (_, i) => item(v(1, 0.02 * i, 0), 1, `a${i}`))
    const groupB = Array.from({ length: 4 }, (_, i) => item(v(0, 1, 0.02 * i), 1, `b${i}`))
    const out = clusterLikedCentroids([...groupA, ...groupB], K2)

    expect(out).toHaveLength(2)
    // Each source group is captured by exactly one returned centroid.
    const simA = out.map((c) => cosine(c, v(1, 0, 0)))
    const simB = out.map((c) => cosine(c, v(0, 1, 0)))
    expect(Math.max(...simA)).toBeGreaterThan(0.95)
    expect(Math.max(...simB)).toBeGreaterThan(0.95)
  })

  it('is deterministic — input order does not change the result', () => {
    const items = [
      item(v(1, 0, 0), 1, 'a0'),
      item(v(0.98, 0.05, 0), 1, 'a1'),
      item(v(0, 1, 0), 1, 'b0'),
      item(v(0.02, 0.99, 0), 1, 'b1'),
      item(v(1, 0.03, 0), 1, 'a2'),
      item(v(0, 0.98, 0.05), 1, 'b2'),
    ]
    const forward = clusterLikedCentroids(items, K2)
    const reversed = clusterLikedCentroids([...items].reverse(), K2)
    expect(reversed).toHaveLength(forward.length)
    // Same centroids regardless of order (match each forward centroid to a reversed one).
    for (const c of forward) {
      expect(reversed.some((r) => cosine(c, r) > 0.999)).toBe(true)
    }
  })

  it('collapses a uniform library to one facet (dedup near-duplicate centroids)', () => {
    const items = Array.from({ length: 12 }, (_, i) => item(v(1, 0.001 * i, 0), 1, `u${i}`))
    const out = clusterLikedCentroids(items, K2) // k would be >1, but the facets coincide
    expect(out).toHaveLength(1)
  })

  it('respects affinity weight — a heavily-weighted item pulls its centroid', () => {
    const items = [item(v(1, 0, 0), 10, 'heavy'), item(v(0, 1, 0), 1, 'light')]
    const out = clusterLikedCentroids(items) // n=2 → k=1: weighted mean leans to the heavy one
    expect(cosine(out[0], v(1, 0, 0))).toBeGreaterThan(cosine(out[0], v(0, 1, 0)))
  })
})
