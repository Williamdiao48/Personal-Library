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
// Cached once the deps have been dynamically imported, so shutdown can reference
// the SAME embed-host module instance (and its worker child) without a second
// import at quit time.
let embedHostMod: typeof import('../workers/embed-host') | null = null

function fire(): void {
  void (async () => {
    const [{ scheduleBackfill }, embedHost] = await Promise.all([
      import('./backfill'),
      import('../workers/embed-host'),
    ])
    embedHostMod = embedHost
    scheduleBackfill(embedHost.workerEmbedHost)
  })().catch((err) => console.error('[backfill] trigger failed:', err))
}

/** Fire-and-forget: schedule a debounced backfill after a content-changing event. */
export function triggerBackfill(): void {
  if (!armed) return
  fire()
}

/** Called once at app start: arm triggers and kick the initial backfill pass. */
export function armBackfill(): void {
  armed = true
  fire()
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
}
