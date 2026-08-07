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
}

// How often to poll while enabled + signed in. A personal app is mostly idle, so
// this only bounds how stale a second device can get between manual syncs; the
// push side is snappier via the sign-in event + (future) post-mutation debounce.
const POLL_MS = 2 * 60_000
// Coalesce bursts of `schedule()` calls (auth event, future local-change events)
// into one round shortly after they settle.
const DEBOUNCE_MS = 4_000

let enabled = false
let signedIn = false
let running = false
let lastSyncedAt: number | null = null
let lastError: string | null = null

let pollTimer: ReturnType<typeof setInterval> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
// Set when a round is requested while one is already running, so we run exactly
// one more round afterwards (the in-flight one may have missed the newest edit).
let rerunQueued = false

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
      if (report) {
        if (report.ok) {
          lastSyncedAt = Date.now()
          lastError = null
        } else {
          lastError = report.error ?? 'Sync failed'
        }
      }
    }
  } finally {
    running = false
  }

  // Guard released → snapshot THIS call's finished state before kicking any rerun
  // (the rerun re-sets `running`, which shouldn't leak into our return value).
  broadcastStatus()
  const result = getStatus()
  if (rerunQueued) {
    rerunQueued = false
    void syncNow()
  }
  return result
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

function startPoll(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => void syncNow(), POLL_MS)
  pollTimer.unref?.()
}

function stopPoll(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
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
    startPoll()
    schedule()
  } else {
    stopPoll()
  }
  broadcastStatus()
}

/** Auth events call this so sign-in kicks a sync and sign-out halts the poll. */
export function notifyAuthChange(nowSignedIn: boolean): void {
  signedIn = nowSignedIn
  if (nowSignedIn) {
    if (enabled) {
      startPoll()
      schedule()
    }
  } else {
    stopPoll()
  }
  broadcastStatus()
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
  enabled = false
  signedIn = false
  running = false
  lastSyncedAt = null
  lastError = null
  rerunQueued = false
  repoFactory = defaultRepoFactory
}
