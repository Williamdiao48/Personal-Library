import type { ItemWithSignals } from './signals'

// C3.4 — the affinity ladder (§7.2): turn one item's feedback signals into a
// scalar affinity a ∈ [−1, +1] that the Rocchio taste vector (C3.5) uses as a
// weight — positive items pull the taste vector toward their content, negative
// items push it away. Pure (no db/model) → ABI-agnostic.
//
// Design principle: explicit ratings are sparse; implicit engagement is dense.
// The ladder produces a usable affinity from implicit signals alone (most users
// never rate) and lets an explicit rating override everything when present.
//
// Every constant lives here so the §10 eval (Chunk 6) can sweep them and the
// eyeball-gate tuning (C3.6) is a one-line edit (design decision 2).
export const AFFINITY = {
  /** rating → affinity: (rating − MIDPOINT) / SCALE. 5→+1, 3.5→0, 1→−1.67(→−1). */
  RATING_MIDPOINT: 3.5,
  RATING_SCALE: 1.5,
  DROPPED: -0.5, // strong implicit dislike
  FINISHED: 0.7, // strong implicit like
  READING_BASE: 0.15, // reading → BASE + DEPTH·depth
  READING_DEPTH: 0.45,
  ON_HOLD: -0.1, // mild negative
  SAVED: 0.15, // unread/saved → selection prior (chose to save, unvalidated)
  /** positive affinity gets ×(1 + MAX_BONUS·clamp(minutes/FULL_MINUTES)). */
  ENGAGEMENT_MAX_BONUS: 0.3,
  ENGAGEMENT_FULL_MINUTES: 60,
  /** review present → nudge |a| outward by this (confidence: they cared enough). */
  REVIEW_BUMP: 0.1,
} as const

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi)

/** Base affinity from the priority ladder (first match wins), pre-adjustment. */
function baseAffinity(sig: ItemWithSignals): number {
  // 1. An explicit rating overrides every implicit signal. `0` is a real rating
  //    (a strong dislike), so test for null — not falsiness.
  if (sig.rating != null) {
    return (sig.rating - AFFINITY.RATING_MIDPOINT) / AFFINITY.RATING_SCALE
  }
  // 2-6. Otherwise fall through the status ladder.
  switch (sig.status) {
    case 'dropped':
      return AFFINITY.DROPPED
    case 'finished':
      return AFFINITY.FINISHED
    case 'reading':
      return AFFINITY.READING_BASE + AFFINITY.READING_DEPTH * sig.depth
    case 'on-hold':
      return AFFINITY.ON_HOLD
    default: // 'unread' (or saved-but-unopened): the selection prior
      return AFFINITY.SAVED
  }
}

/**
 * Affinity a ∈ [−1, +1] for one item: the §7.2 ladder, then an engagement
 * multiplier on positive affinity (time invested = stronger signal, capped at
 * +30% for ≥1h), then a small review confidence bump, clamped to [−1, +1].
 */
export function affinity(sig: ItemWithSignals): number {
  let a = baseAffinity(sig)

  // Engagement: reward time invested — but only sharpen a positive signal, never
  // rescue a negative one (an hour spent on a book you dropped isn't a "like").
  if (a > 0) {
    const invested = clamp(sig.minutes / AFFINITY.ENGAGEMENT_FULL_MINUTES, 0, 1)
    a *= 1 + AFFINITY.ENGAGEMENT_MAX_BONUS * invested
  }

  // Review: they cared enough to write → more confident in whatever the sign is.
  if (sig.hasReview && a !== 0) {
    a += Math.sign(a) * AFFINITY.REVIEW_BUMP
  }

  return clamp(a, -1, 1)
}
