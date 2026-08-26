import { describe, it, expect } from 'vitest'
import {
  ENGAGE,
  recencyWeight,
  interactionWeight,
  engagementCentroid,
  blendEngagement,
  recentlyOpenedIds,
  type OpenInteraction,
} from './engagement'
import { cosine, normalize } from './vectorMath'

// Pure engagement-signal tests (ADR-0011). No db/model → ABI-agnostic. Synthetic
// unit vectors + exact arithmetic; the "cannot hurt" invariant is the marquee case.

const DAY = 24 * 60 * 60 * 1000
const vec = (...xs: number[]) => normalize(new Float32Array(xs))
const open = (sourceId: string, openedAt: number, openCount = 1): OpenInteraction => ({
  sourceId,
  openedAt,
  openCount,
})

describe('recencyWeight', () => {
  it('is 1 at age 0 and 0.5 at one half-life', () => {
    expect(recencyWeight(0, ENGAGE.HALF_LIFE_MS)).toBeCloseTo(1, 12)
    expect(recencyWeight(ENGAGE.HALF_LIFE_MS, ENGAGE.HALF_LIFE_MS)).toBeCloseTo(0.5, 12)
    expect(recencyWeight(2 * ENGAGE.HALF_LIFE_MS, ENGAGE.HALF_LIFE_MS)).toBeCloseTo(0.25, 12)
  })

  it('clamps a future-dated (negative-age) open to weight 1', () => {
    expect(recencyWeight(-5 * DAY, ENGAGE.HALF_LIFE_MS)).toBeCloseTo(1, 12)
  })

  it('degenerates to a flat weight of 1 when half-life ≤ 0', () => {
    expect(recencyWeight(999 * DAY, 0)).toBe(1)
  })
})

describe('interactionWeight', () => {
  it('folds recency with a gentle log2 repeat-open bonus', () => {
    const now = 1_000 * DAY
    // fresh open, count 1 → recency 1 × (1 + 0.5·log2(1)=0) = 1
    expect(interactionWeight(open('a', now), now)).toBeCloseTo(1, 12)
    // fresh open, count 4 → 1 × (1 + 0.5·log2(4)=1) = 2
    expect(interactionWeight(open('a', now, 4), now)).toBeCloseTo(2, 12)
    // one half-life old, count 1 → 0.5 × 1 = 0.5
    expect(interactionWeight(open('a', now - ENGAGE.HALF_LIFE_MS), now)).toBeCloseTo(0.5, 12)
  })

  it('treats a bogus openCount < 1 as 1 (no negative/zero weight)', () => {
    const now = 10 * DAY
    expect(interactionWeight(open('a', now, 0), now)).toBeCloseTo(1, 12)
  })
})

describe('engagementCentroid', () => {
  it('is null when there are no opens', () => {
    expect(engagementCentroid([], new Map(), 0)).toBeNull()
  })

  it('is null when no open has a cached vector (all skipped)', () => {
    const opens = [open('a', 0), open('b', 0)]
    expect(engagementCentroid(opens, new Map(), 0)).toBeNull()
  })

  it('skips opens without a vector but builds from the rest', () => {
    const vecs = new Map([['a', vec(1, 0, 0)]])
    const c = engagementCentroid([open('a', 0), open('b', 0)], vecs, 0)
    expect(c).not.toBeNull()
    // single member → the centroid IS that (normalized) vector
    expect(cosine(c!, vec(1, 0, 0))).toBeCloseTo(1, 6)
  })

  it('recency-weights the mean: a fresh open dominates a very old one', () => {
    const now = 1_000 * DAY
    const vecs = new Map([
      ['fresh', vec(1, 0)],
      ['old', vec(0, 1)],
    ])
    // 'old' is 10 half-lives back → weight ≈ 2^-10, negligible → centroid ≈ 'fresh'
    const opens = [open('fresh', now), open('old', now - 10 * ENGAGE.HALF_LIFE_MS)]
    const c = engagementCentroid(opens, vecs, now)!
    expect(cosine(c, vec(1, 0))).toBeGreaterThan(0.99)
  })

  it('equally-weighted orthogonal opens land on the 45° bisector', () => {
    const now = 5 * DAY
    const vecs = new Map([
      ['a', vec(1, 0)],
      ['b', vec(0, 1)],
    ])
    const c = engagementCentroid([open('a', now), open('b', now)], vecs, now)!
    expect(cosine(c, vec(1, 1))).toBeCloseTo(1, 6)
  })
})

describe('blendEngagement — the cannot-hurt invariant', () => {
  const v = vec(1, 0, 0)

  it('returns the taste score UNCHANGED when there is no engagement centroid', () => {
    expect(blendEngagement(0.42, v, null)).toBe(0.42)
    expect(blendEngagement(-0.13, v, null)).toBe(-0.13)
  })

  it('convex-blends taste and engagement cosine at W_ENGAGE', () => {
    const engage = vec(1, 0, 0) // cos(v, engage) = 1
    const taste = 0.2
    // (1−W)·0.2 + W·1
    expect(blendEngagement(taste, v, engage)).toBeCloseTo(
      (1 - ENGAGE.W_ENGAGE) * taste + ENGAGE.W_ENGAGE * 1,
      12,
    )
  })

  it('stays within [−1, 1] for opposed engagement', () => {
    const engage = vec(-1, 0, 0) // cos = −1
    const blended = blendEngagement(1, v, engage)
    expect(blended).toBeCloseTo((1 - ENGAGE.W_ENGAGE) * 1 + ENGAGE.W_ENGAGE * -1, 12)
    expect(blended).toBeGreaterThanOrEqual(-1)
    expect(blended).toBeLessThanOrEqual(1)
  })

  it('W_ENGAGE=0 (config override) is a pass-through even with a centroid', () => {
    const engage = vec(0, 1, 0)
    expect(blendEngagement(0.3, v, engage, { ...ENGAGE, W_ENGAGE: 0 })).toBeCloseTo(0.3, 12)
  })
})

describe('recentlyOpenedIds', () => {
  const now = 100 * DAY

  it('includes cards opened within FULL_SUPPRESS_MS and excludes older ones', () => {
    const opens = [
      open('recent', now - 1 * DAY), // < 3 days → suppressed
      open('edge', now - 2.9 * DAY), // < 3 days → suppressed
      open('old', now - 5 * DAY), // > 3 days → not suppressed
    ]
    const ids = recentlyOpenedIds(opens, now)
    expect(ids.has('recent')).toBe(true)
    expect(ids.has('edge')).toBe(true)
    expect(ids.has('old')).toBe(false)
  })

  it('is empty when there are no opens', () => {
    expect(recentlyOpenedIds([], now).size).toBe(0)
  })
})
