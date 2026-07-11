// C3.2 — the vector-math primitives the taste engine (§7.3 Rocchio) and Chunk 4's
// rerank both stand on. Pure: no db, no model, no electron → ABI-agnostic (tests
// run without the better-sqlite3 Node-ABI toggle). Every embedding in this app is
// L2-normalized at embed time, so `cosine` is a plain dot product; the only place
// vectors leave the unit sphere is a weighted sum/subtraction, which is why
// `weightedMeanNormalized` and the taste blend re-`normalize` before comparing.

/**
 * Cosine similarity of two vectors. Inputs are assumed **L2-normalized** (the
 * app's invariant), so this is just the dot product — identical → 1, orthogonal
 * → 0, opposite → −1. Returns 0 on a length mismatch (defensive; shouldn't happen).
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/** L2-normalize a vector to unit length. A zero vector is returned unchanged. */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const norm = Math.sqrt(sum)
  const out = new Float32Array(v.length)
  if (norm === 0) return out // all-zeros → nothing to scale; avoid /0
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
  return out
}

/** Scalar multiple `k · v` (new vector). */
export function scale(v: Float32Array, k: number): Float32Array {
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] * k
  return out
}

/** Element-wise `a − b` (new vector). Length mismatch → the shorter length. */
export function sub(a: Float32Array, b: Float32Array): Float32Array {
  const n = Math.min(a.length, b.length)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = a[i] - b[i]
  return out
}

/**
 * Weighted centroid `Σ wᵢ·eᵢ / Σ wᵢ`, then L2-normalized — the liked/disliked
 * centroid of §7.3. Empty input (or non-positive total weight) → a zero-length
 * vector; callers (buildTasteCentroids) guard emptiness before relying on a dim.
 */
export function weightedMeanNormalized(items: { e: Float32Array; w: number }[]): Float32Array {
  if (items.length === 0) return new Float32Array(0)
  const dim = items[0].e.length
  const acc = new Float32Array(dim)
  let totalW = 0
  for (const { e, w } of items) {
    if (e.length !== dim) continue // skip a mis-dimensioned vector defensively
    for (let i = 0; i < dim; i++) acc[i] += e[i] * w
    totalW += w
  }
  if (totalW <= 0) return new Float32Array(0)
  for (let i = 0; i < dim; i++) acc[i] /= totalW
  return normalize(acc)
}
