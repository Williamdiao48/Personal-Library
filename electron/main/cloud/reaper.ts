import { getDb } from '../db'
import { getSupabase, isConfigured } from '../auth/client'
import { presignBlobUrl, type BlobKind } from './presign'

// ─────────────────────────────────────────────────────────────────────────────
// R2 orphan reaper (Cloud Tier 1 #4). Permanent-delete cascades globally (purged_at
// is a synced column), so once NO un-purged item references a content/cover blob,
// its R2 object is dead weight. This sweep deletes those orphans and drops their
// local `blob_sync` ledger rows.
//
// Authority is LOCAL but gated on a FRESH SYNC: the caller runs it only right after
// a successful sync round (syncService.runRound), so the local `items` table
// mirrors Postgres and "is any un-purged item still referencing this hash?" is a
// globally-consistent question (deleted_at/purged_at/blob_hash all sync, LWW).
//
// The predicate keys on `purged_at IS NULL`, NOT `deleted_at`: a merely-trashed item
// is restorable and must keep its bytes. Only a permanently-deleted (purged) item
// frees them. Dedup siblings (a hash shared by another still-un-purged item) are
// protected by the same check.
//
// Everything is best-effort and idempotent: a DELETE against an already-gone key is
// a 2xx, so a double sweep — or two devices reaping the same hash — is harmless. A
// failed reap leaves the ledger row for the next sweep to retry.
// ─────────────────────────────────────────────────────────────────────────────

// Bound a single DELETE so an unreachable R2/network can't wedge the sweep. Matches
// processing.ts's source-reap timeout.
const REAP_TIMEOUT_MS = 30_000

// Guards against overlapping sweeps (e.g. two rounds finishing close together).
let reaping = false

// The last sweep promise, so tests can await the fire-and-forget cleanup deterministically.
let lastSweep: Promise<void> = Promise.resolve()

interface SyncedBlobRow {
  content_hash: string
  kind: BlobKind
}

/** Delete R2 blobs no un-purged item references, and drop their ledger rows. No-ops
 *  when cloud is unconfigured or no one is signed in, so it's always safe to call.
 *  Never throws — a failed delete just leaves the ledger row for a later sweep. */
export async function reapOrphanBlobs(): Promise<void> {
  if (reaping || !isConfigured()) return
  const supabase = getSupabase()
  if (!supabase) return
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return // signed out → nothing to reap

  reaping = true
  try {
    const db = getDb()
    // Only blobs we actually uploaded (state='synced') are candidates; a 'pending'/
    // 'error' row hasn't reached R2 yet, so there's nothing to delete.
    const rows = db
      .prepare(`SELECT content_hash, kind FROM blob_sync WHERE state = 'synced'`)
      .all() as SyncedBlobRow[]

    for (const { content_hash, kind } of rows) {
      // A tombstone (deleted_at set) still carries its blob_hash, so filter on
      // purged_at — the "reclaimed everywhere" signal — not deleted_at.
      const col = kind === 'cover' ? 'cover_hash' : 'blob_hash'
      const wanted = db
        .prepare(`SELECT 1 FROM items WHERE ${col} = ? AND purged_at IS NULL LIMIT 1`)
        .get(content_hash)
      if (wanted) continue // still referenced by a live/restorable item → keep the bytes

      try {
        const url = await presignBlobUrl('delete', kind, content_hash)
        const res = await fetch(url, {
          method: 'DELETE',
          signal: AbortSignal.timeout(REAP_TIMEOUT_MS),
        })
        // R2 DELETE is idempotent (2xx even if the key is already gone). Only drop
        // the ledger row on success; a non-ok/throw leaves it for the next sweep.
        if (res.ok) db.prepare(`DELETE FROM blob_sync WHERE content_hash = ?`).run(content_hash)
      } catch {
        // Opportunistic cleanup — swallow (offline, expired URL, R2 hiccup, …).
      }
    }
  } finally {
    reaping = false
  }
}

/** Fire-and-forget the sweep, recording the promise so tests can await it. */
export function scheduleReap(): void {
  lastSweep = reapOrphanBlobs()
}

/** Test-only: await the last fire-and-forget sweep (deterministic assertions). */
export function __whenReapedForTest(): Promise<void> {
  return lastSweep
}

/** Test-only: clear the single-flight guard between tests. */
export function __resetForTest(): void {
  reaping = false
  lastSweep = Promise.resolve()
}
