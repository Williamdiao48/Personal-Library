import { describe, it, expect } from 'vitest'
import { affinity, AFFINITY } from './affinity'
import type { ItemWithSignals } from './signals'

// Pure, ABI-agnostic — no db/model, runs without the Node-ABI toggle.

const sig = (over: Partial<ItemWithSignals> = {}): ItemWithSignals => ({
  id: 'x',
  rating: null,
  status: 'unread',
  depth: 0,
  minutes: 0,
  hasReview: false,
  ...over,
})

describe('affinity — rating branch (overrides status)', () => {
  it('maps 5★ → +1 even when the status says dropped', () => {
    expect(affinity(sig({ rating: 5, status: 'dropped' }))).toBeCloseTo(1, 6)
  })

  it('maps a mid rating linearly (4★ → +0.333)', () => {
    expect(affinity(sig({ rating: 4 }))).toBeCloseTo((4 - 3.5) / 1.5, 6)
  })

  it('treats 0★ as a strong dislike (clamped to −1), NOT "unrated"', () => {
    // (0 − 3.5)/1.5 = −2.33 → clamp −1. A `null` rating would give +0.15 instead.
    expect(affinity(sig({ rating: 0 }))).toBe(-1)
    expect(affinity(sig({ rating: null }))).toBeCloseTo(AFFINITY.SAVED, 6)
  })
})

describe('affinity — status ladder (no rating)', () => {
  it('dropped → −0.5, on-hold → −0.1', () => {
    expect(affinity(sig({ status: 'dropped' }))).toBeCloseTo(-0.5, 6)
    expect(affinity(sig({ status: 'on-hold' }))).toBeCloseTo(-0.1, 6)
  })

  it('finished → +0.7', () => {
    expect(affinity(sig({ status: 'finished' }))).toBeCloseTo(0.7, 6)
  })

  it('reading scales with depth (base + 0.45·depth)', () => {
    expect(affinity(sig({ status: 'reading', depth: 0 }))).toBeCloseTo(0.15, 6)
    expect(affinity(sig({ status: 'reading', depth: 1 }))).toBeCloseTo(0.6, 6)
  })

  it('unread/saved → the selection prior (+0.15)', () => {
    expect(affinity(sig({ status: 'unread' }))).toBeCloseTo(0.15, 6)
  })
})

describe('affinity — engagement multiplier', () => {
  it('adds up to +30% for ≥1h invested, and caps there', () => {
    expect(affinity(sig({ status: 'finished', minutes: 60 }))).toBeCloseTo(0.7 * 1.3, 6)
    expect(affinity(sig({ status: 'finished', minutes: 30 }))).toBeCloseTo(0.7 * 1.15, 6)
    expect(affinity(sig({ status: 'finished', minutes: 600 }))).toBeCloseTo(0.7 * 1.3, 6) // capped
  })

  it('applies to rating-based positives too', () => {
    expect(affinity(sig({ rating: 4, minutes: 60 }))).toBeCloseTo(((4 - 3.5) / 1.5) * 1.3, 6)
  })

  it('never rescues a negative (an hour on a dropped book is still a dislike)', () => {
    expect(affinity(sig({ status: 'dropped', minutes: 600 }))).toBeCloseTo(-0.5, 6)
  })
})

describe('affinity — review confidence bump', () => {
  it('nudges a positive further positive', () => {
    expect(affinity(sig({ status: 'reading', depth: 0.5, hasReview: true }))).toBeCloseTo(
      0.15 + 0.45 * 0.5 + 0.1,
      6,
    )
  })

  it('nudges a negative further negative (magnitude, following the sign)', () => {
    expect(affinity(sig({ status: 'dropped', hasReview: true }))).toBeCloseTo(-0.6, 6)
  })
})

describe('affinity — clamped to [−1, +1]', () => {
  it('a 5★ item with a review does not exceed +1', () => {
    expect(affinity(sig({ rating: 5, hasReview: true, minutes: 600 }))).toBe(1)
  })
})
