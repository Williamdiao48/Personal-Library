import { describe, it, expect } from 'vitest'
import { cosine, normalize, scale, sub, weightedMeanNormalized } from './vectorMath'

// Pure, ABI-agnostic (no db/model) — runs without the Node-ABI toggle.

const v = (...xs: number[]) => Float32Array.from(xs)
const l2 = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0))

describe('cosine', () => {
  it('is 1 for identical unit vectors', () => {
    const a = normalize(v(1, 2, 3))
    expect(cosine(a, a)).toBeCloseTo(1, 6)
  })

  it('is 0 for orthogonal vectors', () => {
    expect(cosine(v(1, 0), v(0, 1))).toBeCloseTo(0, 6)
  })

  it('is −1 for opposite unit vectors', () => {
    const a = normalize(v(1, 1))
    expect(cosine(a, scale(a, -1))).toBeCloseTo(-1, 6)
  })

  it('returns 0 on a length mismatch (defensive)', () => {
    expect(cosine(v(1, 2, 3), v(1, 2))).toBe(0)
  })
})

describe('normalize', () => {
  it('scales any vector to unit length', () => {
    const out = normalize(v(3, 4)) // |(3,4)| = 5
    expect(l2(out)).toBeCloseTo(1, 6)
    expect(Array.from(out)).toEqual([expect.closeTo(0.6, 6), expect.closeTo(0.8, 6)])
  })

  it('leaves a scaled vector pointing the same way (unit)', () => {
    const a = v(1, 2, 3)
    const n1 = normalize(a)
    const n2 = normalize(scale(a, 10)) // magnitude changes, direction does not
    expect(cosine(n1, n2)).toBeCloseTo(1, 6)
  })

  it('returns a zero vector unchanged (no divide-by-zero)', () => {
    expect(Array.from(normalize(v(0, 0, 0)))).toEqual([0, 0, 0])
  })
})

describe('scale / sub', () => {
  it('scale multiplies each component', () => {
    expect(Array.from(scale(v(1, -2, 3), 2))).toEqual([2, -4, 6])
  })

  it('sub subtracts element-wise', () => {
    expect(Array.from(sub(v(5, 5), v(1, 2)))).toEqual([4, 3])
  })
})

describe('weightedMeanNormalized', () => {
  it('pulls the centroid toward the heavier item', () => {
    const east = normalize(v(1, 0))
    const north = normalize(v(0, 1))
    const centroid = weightedMeanNormalized([
      { e: east, w: 3 },
      { e: north, w: 1 },
    ])
    // heavier weight on `east` → closer to east than to north
    expect(cosine(centroid, east)).toBeGreaterThan(cosine(centroid, north))
    expect(l2(centroid)).toBeCloseTo(1, 6)
  })

  it('a single item normalizes back to that item', () => {
    const e = normalize(v(2, 3, 6))
    const out = weightedMeanNormalized([{ e, w: 0.42 }])
    expect(cosine(out, e)).toBeCloseTo(1, 6)
  })

  it('empty input → zero-length vector', () => {
    expect(weightedMeanNormalized([]).length).toBe(0)
  })

  it('non-positive total weight → zero-length vector (degenerate)', () => {
    expect(weightedMeanNormalized([{ e: v(1, 0), w: 0 }]).length).toBe(0)
  })
})
