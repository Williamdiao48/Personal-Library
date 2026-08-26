import { cosine, weightedMeanNormalized } from './vectorMath'

// Recommender #3 — the implicit-feedback engagement signal (ADR-0011). A Discover
// card *open* (clicking through to read a candidate externally) is a soft-positive:
// weak evidence you're drawn to that kind of work, but unvalidated (you haven't
// owned or rated it). This module turns the logged opens into (a) a recency-weighted
// **engagement centroid** blended into candidate scoring and (b) a short list of
// just-opened ids to suppress from the next refresh. Pure (no db/model) → ABI-agnostic.
//
// Design invariant (the "cannot hurt" guarantee, ADR-0011): with no opens the
// engagement centroid is null and `blendEngagement` returns the taste score
// UNCHANGED — Discover behaves byte-identically to today. The engagement signal is a
// SEPARATE stream that is never mixed into the validated taste vector; it only shades
// the final ranking by a small, conservative weight.
//
// `W_ENGAGE` is deliberately NOT tuned by the offline eval — an opened-but-not-owned
// card is not a leave-one-out label, so no build-time MRR delta can size it. It's set
// low on purpose; real validation is the retrospective open→import study once data
// accumulates. See docs/internal/planning/recommender/2026-08-25-implicit-feedback-scope.md.

export const ENGAGE = {
  /** Recency half-life: an open this old contributes half the weight of a fresh one. */
  HALF_LIFE_MS: 14 * 24 * 60 * 60 * 1000, // 2 weeks
  /** Repeat opens strengthen the signal, but gently: weight ×(1 + this·log2(count)). */
  OPEN_COUNT_LOG_BONUS: 0.5,
  /** Score blend: final = (1−W)·tasteCos + W·engageCos. Conservative — see header. */
  W_ENGAGE: 0.15,
  /** A just-opened card is hidden from refreshes newer than this (then it may return,
   *  now shaded by the engagement centroid rather than hard-excluded). */
  FULL_SUPPRESS_MS: 3 * 24 * 60 * 60 * 1000, // 3 days
} as const

/** The tunable engagement knobs. An explicit number interface (not `typeof ENGAGE`)
 *  so a test/config override like `{ ...ENGAGE, W_ENGAGE: 0 }` type-checks — the
 *  `as const` literal type would otherwise pin each field to its default value. */
export interface EngageCfg {
  HALF_LIFE_MS: number
  OPEN_COUNT_LOG_BONUS: number
  W_ENGAGE: number
  FULL_SUPPRESS_MS: number
}

/** One logged card open, as the pure layer consumes it (db shape lives in interactions.ts). */
export interface OpenInteraction {
  sourceId: string
  openedAt: number
  openCount: number
}

/**
 * Exponential recency weight `2^(−age/halfLife)` — 1.0 at age 0, 0.5 at one half-life,
 * decaying toward 0. A future-dated `openedAt` (clock skew) clamps to age 0 → weight 1.
 * `halfLifeMs ≤ 0` degenerates to a flat weight of 1 (no decay).
 */
export function recencyWeight(ageMs: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0) return 1
  const age = Math.max(0, ageMs)
  return Math.pow(2, -age / halfLifeMs)
}

/** A single interaction's centroid weight: recency decay × a gentle repeat-open bonus. */
export function interactionWeight(o: OpenInteraction, now: number, cfg: EngageCfg = ENGAGE): number {
  const recency = recencyWeight(now - o.openedAt, cfg.HALF_LIFE_MS)
  const count = Math.max(1, o.openCount)
  return recency * (1 + cfg.OPEN_COUNT_LOG_BONUS * Math.log2(count))
}

/**
 * The engagement centroid: the recency-weighted, L2-normalized mean of the opened
 * candidates' embedding vectors. Opens whose vector isn't cached are skipped (same
 * rule as the taste centroid skipping un-embedded items). Returns `null` when there's
 * nothing to build from (no opens, or none with a vector) — the signal is then absent
 * and scoring falls back to taste alone (the cannot-hurt guarantee).
 */
export function engagementCentroid(
  opens: OpenInteraction[],
  vecs: Map<string, Float32Array>,
  now: number,
  cfg: EngageCfg = ENGAGE,
): Float32Array | null {
  const members: { e: Float32Array; w: number }[] = []
  for (const o of opens) {
    const e = vecs.get(o.sourceId)
    if (!e) continue
    const w = interactionWeight(o, now, cfg)
    if (w > 0) members.push({ e, w })
  }
  if (members.length === 0) return null
  const c = weightedMeanNormalized(members)
  return c.length ? c : null
}

/**
 * Blend the engagement signal into a candidate's taste score: `(1−W)·taste + W·engageCos`.
 * When `engage` is null (no engagement signal) the taste score is returned UNCHANGED —
 * the invariant that keeps Discover byte-identical to today for a reader who's never
 * opened a card. Both terms are cosines in [−1, 1], so the blend stays in range.
 */
export function blendEngagement(
  tasteScore: number,
  vec: Float32Array,
  engage: Float32Array | null,
  cfg: EngageCfg = ENGAGE,
): number {
  if (!engage) return tasteScore
  return (1 - cfg.W_ENGAGE) * tasteScore + cfg.W_ENGAGE * cosine(vec, engage)
}

/**
 * The set of candidate ids to hard-suppress from the next refresh: cards opened within
 * `FULL_SUPPRESS_MS` of `now`. Mirrors the `dismissed_recommendations` exclude, but
 * auto-expires — after the window a card may resurface (now shaded, not hidden). Older
 * opens aren't returned here; they live on only through the engagement centroid.
 */
export function recentlyOpenedIds(
  opens: OpenInteraction[],
  now: number,
  cfg: EngageCfg = ENGAGE,
): Set<string> {
  const out = new Set<string>()
  for (const o of opens) {
    if (now - o.openedAt < cfg.FULL_SUPPRESS_MS) out.add(o.sourceId)
  }
  return out
}
