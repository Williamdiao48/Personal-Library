// ─────────────────────────────────────────────────────────────────────────────
// syncService — the main-process driver that actually RUNS the sync engine.
//
// runSyncRound (syncEngine.ts) is a pure orchestrator: hand it a db + a CloudRepo
// and it does one round. This module is the long-lived glue around it — the
// enabled gate, the triggers (sign-in event + periodic poll + manual "Sync now"),
// the single-flight guard, and the status it broadcasts to the renderer.
//
// Everything is best-effort and gated: nothing runs unless the user turned sync ON
// (renderer-owned setting, pushed here like enableDiscover), the build is
// configured, AND a session exists. A signed-out / local-only user costs nothing.
//
// The Supabase-touching bits sit behind a small `repoFactory` seam so the whole
// service is testable with a fake repo + the in-memory db harness (no network).
// ─────────────────────────────────────────────────────────────────────────────

import { BrowserWindow } from 'electron'
import { getDb } from '../../db'
import { getSupabase, isConfigured } from '../../auth/client'
import { createSupabaseCloudRepo, type CloudRepo } from './cloudRepo'
import { runSyncRound, type SyncReport } from './syncEngine'
import { startRealtime, stopRealtime } from './realtime'
import { scheduleReap } from '../reaper'
import { SYNC_SPECS } from './specs'
import {
  countDirty,
  getLastSyncedUserId,
  setLastSyncedUserId,
  resetSyncStateForNewUser,
} from './syncStore'

/** The renderer-facing snapshot of where sync stands right now. */
export interface SyncStatus {
  /** User's master switch (renderer-owned, mirrored here). */
  enabled: boolean
  /** Build carries Supabase creds. */
  configured: boolean
  /** A session exists (last known — updated on auth events + each round). */
  signedIn: boolean
  /** A round is in flight. */
  running: boolean
  /** ms epoch of the last successful round, or null if none this session. */
  lastSyncedAt: number | null
  /** Message from the last failed round, cleared on the next success. */
  lastError: string | null
  /** Rows queued to push right now (dirty = 1) across all synced tables. */
  pendingDirty: number
  /** Consecutive failed rounds; 0 when healthy. Drives the poll backoff. */
  consecutiveFailures: number
  /** ms epoch of the next scheduled poll, or null when no poll is armed
   *  (disabled / signed out). Grows with consecutiveFailures. */
  nextRetryAt: number | null
}

// How often to poll while enabled + signed in. A personal app is mostly idle, so
// this only bounds how stale a second device can get between manual syncs; the
// push side is snappier via the sign-in event + (future) post-mutation debounce.
const POLL_MS = 2 * 60_000
// Ceiling for the exponential backoff so a persistently offline/erroring client
// settles to a slow retry instead of hammering: base 2m doubles per consecutive
// failure (2m→4m→8m→16m→30m) and plateaus here. No jitter — a single-user app has
// no thundering herd to spread.
const MAX_BACKOFF_MS = 30 * 60_000
// Coalesce bursts of `schedule()` calls (auth event, future local-change events)
// into one round shortly after they settle.
const DEBOUNCE_MS = 4_000

let enabled = false
let signedIn = false
let running = false
let lastSyncedAt: number | null = null
let lastError: string | null = null
// Consecutive failed rounds — the backoff exponent. Reset to 0 on any success.
let consecutiveFailures = 0
// ms epoch of the next armed poll, surfaced for the UI; null when no poll is armed.
let nextRetryAt: number | null = null

let pollTimer: ReturnType<typeof setTimeout> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
// Set when a round is requested while one is already running, so we run exactly
// one more round afterwards (the in-flight one may have missed the newest edit).
let rerunQueued = false
// The promise of the round currently running, or null when idle. Lets flushNow
// wait out an in-flight round before forcing one that observes the newest write.
let activeRound: Promise<SyncStatus> | null = null

/** The Supabase-touching seam. Returns null when we can't sync right now
 *  (unconfigured or signed out). Overridable in tests. */
type RepoFactory = () => Promise<CloudRepo | null>

const defaultRepoFactory: RepoFactory = async () => {
  if (!isConfigured()) return null
  const supabase = getSupabase()
  if (!supabase) return null
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return null
  return createSupabaseCloudRepo(supabase, session.user.id)
}

let repoFactory: RepoFactory = defaultRepoFactory

export function getStatus(): SyncStatus {
  return {
    enabled,
    configured: isConfigured(),
    signedIn,
    running,
    lastSyncedAt,
    lastError,
    pendingDirty: countPendingDirty(),
    consecutiveFailures,
    nextRetryAt,
  }
}

/** Total rows queued to push across all synced tables. Computed fresh (a handful of
 *  COUNT(*)s over tiny tables) so it's always accurate; guarded so a not-yet-open db
 *  (early boot / tests without a harness) reports 0 rather than throwing. */
function countPendingDirty(): number {
  try {
    const db = getDb()
    let total = 0
    for (const spec of SYNC_SPECS) total += countDirty(db, spec)
    return total
  } catch {
    return 0
  }
}

function broadcastStatus(): void {
  const status = getStatus()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('sync:status', status)
  }
}

/**
 * Run exactly one round, guarded single-flight. No-ops (reporting current status)
 * when disabled or when there's nothing to sync against (unconfigured / signed
 * out). Never throws — runSyncRound already swallows PostgREST/network errors and
 * reports them, and any surprise here is caught and surfaced as lastError.
 */
export async function syncNow(): Promise<SyncStatus> {
  if (!enabled) return getStatus()
  if (running) {
    // A round is already in flight; ask it to run once more when it finishes so a
    // just-made local change isn't stranded until the next poll.
    rerunQueued = true
    return getStatus()
  }

  // Track the round's promise so flushNow can await it. Snapshot THIS call's
  // finished state BEFORE kicking any rerun (the rerun re-sets `running`, which
  // shouldn't leak into our return value).
  activeRound = runRound()
  const result = await activeRound
  activeRound = null
  if (rerunQueued) {
    rerunQueued = false
    void syncNow()
  }
  return result
}

/** One guarded sync round. Never throws — runSyncRound swallows PostgREST/network
 *  errors into a report, and any surprise here is caught and surfaced as lastError. */
async function runRound(): Promise<SyncStatus> {
  // Claim the single-flight guard BEFORE the async repo lookup — otherwise two
  // calls racing on getSession() would both slip past the `running` check and run
  // concurrent rounds against the same DB. `finally` guarantees it's released.
  running = true
  try {
    const repo = await repoFactory()
    if (!repo) {
      // Signed out or unconfigured — not an error, just nothing to do.
      signedIn = false
    } else {
      signedIn = true
      broadcastStatus() // now genuinely syncing

      let report: SyncReport | null = null
      try {
        report = await runSyncRound(getDb(), repo)
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
      if (report && report.ok) {
        lastSyncedAt = Date.now()
        lastError = null
        consecutiveFailures = 0 // healthy → poll returns to the base cadence
        // A round just push+pulled, so the local items table mirrors Postgres —
        // the one moment "is this blob still referenced?" is authoritative. Reap
        // R2 orphans in the background (best-effort; never blocks the round).
        scheduleReap()
      } else {
        // A reported failure (report.ok === false) OR an exception above: back off.
        if (report && !report.ok) lastError = report.error ?? 'Sync failed'
        consecutiveFailures += 1
      }
    }
  } finally {
    running = false
  }
  // Arm the next poll at the (possibly backed-off) cadence — this is the single
  // place the poll is (re)scheduled, so success/failure here directly sets when the
  // next automatic attempt fires. Set before broadcast so the UI sees nextRetryAt.
  scheduleNextPoll()
  broadcastStatus()
  return getStatus()
}

/**
 * Run a round and GUARANTEE any row dirty right now is pushed before resolving.
 *
 * Unlike {@link syncNow} (which bails immediately if a round is already running),
 * flushNow first waits out any in-flight round — it may have started before our
 * write and so not include our just-dirtied rows — then forces one that does.
 * This is the durability primitive behind "back up, then quit": the caller can
 * await it and know the metadata push reached the server before the app closes.
 * No-ops (nothing to flush) when sync is disabled. Never throws.
 */
export async function flushNow(): Promise<SyncStatus> {
  if (!enabled) return getStatus()
  if (activeRound) await activeRound.catch(() => {})
  return syncNow()
}

/** Debounced request for a round — the entry point for event triggers so a burst
 *  collapses into one sync. Manual "Sync now" uses {@link syncNow} directly. */
export function schedule(): void {
  if (!enabled) return
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void syncNow()
  }, DEBOUNCE_MS)
  debounceTimer.unref?.()
}

/** A local write happened → schedule a debounced push so the edit reaches the
 *  user's other devices in seconds instead of waiting out the poll. Called from the
 *  mutating IPC handlers. No-ops when sync is disabled (schedule() gates on
 *  `enabled`), so it's always safe to call unconditionally after a mutation. */
export function notifyLocalMutation(): void {
  schedule()
}

// Realtime is the push-side complement to the poll: while enabled AND signed in we
// hold a postgres_changes subscription so another device's write nudges a pull in
// seconds. Reconciled from the same two lifecycle events that flip those flags
// (setEnabled, notifyAuthChange) so it's always in step with them.
async function ensureRealtime(): Promise<void> {
  if (!(enabled && signedIn)) {
    stopRealtime(getSupabase())
    return
  }
  const supabase = isConfigured() ? getSupabase() : null
  if (!supabase) return
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return
  // Nudge a debounced pull on any server-side change (schedule() gates on enabled
  // and coalesces bursts, so an echo of our own push settles in one extra round).
  startRealtime(supabase, session.access_token, () => schedule())
}

/**
 * (Re)arm the periodic poll as a single self-rescheduling timeout whose delay grows
 * with consecutiveFailures: min(POLL_MS * 2^failures, MAX_BACKOFF_MS). Called after
 * every round (so the cadence tracks the latest success/failure) and from the
 * enable/sign-in lifecycle. Only armed while enabled AND signed in — otherwise the
 * poll would just no-op against a null repo — so nextRetryAt is nulled in that case.
 * Event triggers (schedule/syncNow) fire immediately regardless of this timer.
 */
function scheduleNextPoll(): void {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  if (!(enabled && signedIn)) {
    nextRetryAt = null
    return
  }
  const delay = Math.min(POLL_MS * 2 ** consecutiveFailures, MAX_BACKOFF_MS)
  nextRetryAt = Date.now() + delay
  pollTimer = setTimeout(() => {
    pollTimer = null
    void syncNow()
  }, delay)
  pollTimer.unref?.()
}

function stopPoll(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  nextRetryAt = null
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
}

/** Mirror the renderer's master switch. Enabling arms the poll + kicks a round;
 *  disabling stops all background work (the local data + dirty flags are untouched,
 *  so re-enabling later just resumes). */
export function setEnabled(next: boolean): void {
  if (next === enabled) return
  enabled = next
  if (enabled) {
    scheduleNextPoll()
    schedule()
  } else {
    stopPoll()
  }
  void ensureRealtime()
  broadcastStatus()
}

/**
 * Auth events call this so sign-in kicks a sync and sign-out halts the poll. The
 * `userId` (the signed-in account's auth uid, or null when signed out) also drives
 * account-identity reconciliation: sync_cursors + the per-row `dirty` flags are
 * device-global, not per-account, so signing into a DIFFERENT account on this device
 * (e.g. delete-then-recreate, or an account switch) must discard the previous
 * account's sync state and re-sync the whole local library against the new one — see
 * reconcileSyncIdentity.
 */
export function notifyAuthChange(userId: string | null): void {
  const nowSignedIn = userId != null
  signedIn = nowSignedIn
  if (nowSignedIn) {
    // Reconcile BEFORE scheduling so the round kicked below observes the reset state
    // (cleared cursors + re-dirtied rows). Runs regardless of `enabled` so a later
    // enable still sees the correct state.
    reconcileSyncIdentity(userId)
    if (enabled) {
      scheduleNextPoll()
      schedule()
    }
  } else {
    stopPoll()
  }
  void ensureRealtime()
  broadcastStatus()
}

/**
 * Compare the signed-in account against the one this device's sync state belongs to
 * and heal a mismatch. First sign-in on this device (no stored id) just records the
 * account — the fresh local library is already dirty and cursors are 0, so a normal
 * round handles it, no forced reset. A DIFFERENT account → full re-sync
 * (resetSyncStateForNewUser) so the local library backs up to the new account and no
 * stale dirty=0 row orphan-FK-fails against the new (empty) server. Same account →
 * no-op. Best-effort: a not-yet-open db (early boot / tests without a harness) is
 * skipped and reconciled on the next auth event.
 */
function reconcileSyncIdentity(userId: string): void {
  try {
    const db = getDb()
    const prev = getLastSyncedUserId(db)
    if (prev === userId) return // same account — state is already correct
    if (prev !== null) resetSyncStateForNewUser(db) // switched accounts → fresh full sync
    setLastSyncedUserId(db, userId)
  } catch {
    // db not open yet — reconcile on the next auth event.
  }
}

/** Test-only: swap the Supabase seam for a fake repo (or null to simulate
 *  signed-out). Returns a restore fn. */
export function __setRepoFactoryForTest(factory: RepoFactory): () => void {
  const prev = repoFactory
  repoFactory = factory
  return () => {
    repoFactory = prev
  }
}

/** Test-only: reset all module state between tests. */
export function __resetForTest(): void {
  stopPoll()
  stopRealtime(null)
  enabled = false
  signedIn = false
  running = false
  lastSyncedAt = null
  lastError = null
  consecutiveFailures = 0
  nextRetryAt = null
  rerunQueued = false
  activeRound = null
  repoFactory = defaultRepoFactory
}
