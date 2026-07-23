// C2.6 — the single lifecycle trigger for embedding backfill (D-C2-1).
//
// Every "content changed" event — app start, capture, import, refresh/append —
// calls triggerBackfill(). It is debounced + fire-and-forget (callers never
// await embedding), and the reconciler's hash gate makes correctness independent
// of catching every event, so per-edit hooks (title/author/review/tags) and
// rating/status changes are deliberately NOT wired: the next trigger reconciles
// them by hash.
//
// The heavy dependencies — the DB-backed backfill runner and the
// transformers/worker host — are imported LAZILY inside the trigger. So merely
// importing this module (and thus the IPC handlers that call it) pulls in neither
// better-sqlite3 nor the model, and the model machinery only loads when a
// backfill actually fires. The `armed` guard keeps triggers as no-ops until the
// real app arms them at startup, so unit tests that exercise the handlers never
// spawn a worker.

let armed = false
// Cached once the deps have been dynamically imported, so shutdown/disarm can
// reference the SAME module instances (and the embed-host's worker child + the
// backfill/prewarm debounce timers) without a second import.
let embedHostMod: typeof import('../workers/embed-host') | null = null
let backfillMod: typeof import('./backfill') | null = null
let prewarmMod: typeof import('./prewarm') | null = null

function fire(): void {
  void (async () => {
    const [backfill, embedHost, prewarm] = await Promise.all([
      import('./backfill'),
      import('../workers/embed-host'),
      import('./prewarm'),
    ])
    embedHostMod = embedHost
    backfillMod = backfill
    prewarmMod = prewarm
    // Re-check after the async import gap: if Discover was disarmed while these
    // dynamic imports were resolving, scheduling here would set timers *after*
    // disarmBackfill already ran — re-forking the worker the user just disabled.
    if (!armed) return
    backfill.scheduleBackfill(embedHost.workerEmbedHost)
    // Same "content changed" signal warms Discover's OpenLibrary blurb cache on idle,
    // so the description N+1 never lands on a user Refresh. Debounced independently;
    // no worker, no embedding — just the network caches. Gated by `armed` (Discover
    // off ⇒ no prewarm), same as backfill.
    prewarm.schedulePrewarm()
  })().catch((err) => console.error('[backfill] trigger failed:', err))
}

/** Fire-and-forget: schedule a debounced backfill after a content-changing event. */
export function triggerBackfill(): void {
  if (!armed) return
  fire()
}

/**
 * Arm triggers and kick the initial backfill pass. Called when Discover is
 * enabled (the renderer syncs the setting after boot — embeddings exist only to
 * serve the recommender, so a user who keeps Discover off does no embed work).
 * Idempotent-ish: re-arming re-fires, but the underlying schedule is debounced.
 */
export function armBackfill(): void {
  armed = true
  fire()
}

/**
 * Disarm triggers and tear down the embed worker — called when Discover is turned
 * off so no further embedding runs and the model's memory is released.
 */
export function disarmBackfill(): void {
  armed = false
  // Cancel any debounce timers scheduled just before the toggle, so nothing
  // re-forks the worker (backfill) or hits OpenLibrary (prewarm) after "off".
  // The post-await `armed` guard in fire() covers the case where an import is
  // still in flight; these cover the case where the timer is already set.
  backfillMod?.cancelBackfill()
  prewarmMod?.cancelPrewarm()
  embedHostMod?.shutdownEmbedWorker()
}

/**
 * Tear down the embed worker on app quit. A no-op if no backfill ever ran (the
 * host module was never imported, so no worker was forked).
 */
export function shutdownBackfill(): void {
  embedHostMod?.shutdownEmbedWorker()
}

/** Test-only: disarm + drop the cached host module so state can't leak. */
export function _resetLifecycle(): void {
  armed = false
  embedHostMod = null
  backfillMod = null
  prewarmMod = null
}
