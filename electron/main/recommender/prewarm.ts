import { buildTaste } from './taste'
import { prewarmBooks } from './sources/openLibrary'
import { now, logTiming } from './timing'

// Discover blurb prewarm. The OpenLibrary description N+1 (each book's blurb is a
// separate `/works/OL…W.json` fetch) is ~88% of a cold Refresh's latency, yet the
// blurb is load-bearing for ranking quality (without it the feed collapses into a
// subject-keyword monoculture). So rather than drop or defer blurbs, we fill their
// cache PROACTIVELY on idle: after a "content changed" event the lifecycle schedules
// a prewarm, which fetches the current taste's page-1 book pool into the caches so a
// later Refresh finds the N+1 already warm (~12ms instead of ~66s).
//
// Structured exactly like backfill.ts — a coalesced in-flight guard + a debounced
// schedule — and imported LAZILY by lifecycle so it stays out of the module graph
// (and pulls in no DB) until Discover arms it. It does no embedding and needs no
// worker: it only warms the network caches (candidate_cache), the expensive part.

/**
 * Coalesce a burst of triggers into a single prewarm this many ms after the last
 * one. Longer than backfill's 1500 — prewarm is idle-biased speculative work, not a
 * response the user is waiting on, so it debounces lazily to avoid churning on a
 * flurry of captures.
 */
export const PREWARM_DEBOUNCE_MS = 8000

async function doPrewarm(): Promise<void> {
  const t = now()
  const taste = buildTaste()
  // No liked items yet → no seed queries → nothing to warm. (buildTaste is cheap;
  // a cold-start user simply gets no prewarm, and their first Refresh is coldStart.)
  if (taste.liked.length === 0) return
  const warmed = await prewarmBooks(taste.liked)
  logTiming('prewarm:books', t, { warmed })
}

let running: Promise<void> | null = null

/**
 * Run one prewarm pass. Concurrent callers coalesce onto the in-flight run (the
 * guard), so a trigger arriving mid-pass doesn't kick a second overlapping prewarm.
 * Never rejects — a source failure degrades to a partial warm and is logged.
 */
export function runPrewarm(): Promise<void> {
  if (running) return running
  running = doPrewarm()
    .catch((err) => console.error('[prewarm] run failed:', err))
    .finally(() => {
      running = null
    })
  return running
}

let timer: ReturnType<typeof setTimeout> | null = null

/**
 * Debounced entry point for lifecycle triggers. A burst of content-change events
 * collapses into a single prewarm fired `delayMs` after the last one.
 * Fire-and-forget: never blocks the caller.
 */
export function schedulePrewarm(delayMs = PREWARM_DEBOUNCE_MS): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void runPrewarm()
  }, delayMs)
}

/** Test-only: drop the debounce timer + in-flight guard so state can't leak across tests. */
export function _resetPrewarmState(): void {
  if (timer) clearTimeout(timer)
  timer = null
  running = null
}
