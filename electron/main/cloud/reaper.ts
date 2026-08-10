import { unlinkSync } from 'fs'
import { getDb } from '../db'
import { getSupabase, isConfigured } from '../auth/client'
import { presignBlobUrl, type BlobKind } from './presign'
import { safeContentPath, safeUserDataPath } from '../security/paths'

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
let reapingLocal = false

// The last sweep promise, so tests can await the fire-and-forget cleanup deterministically.
let lastSweep: Promise<void> = Promise.resolve()

interface SyncedBlobRow {
  content_hash: string
  kind: BlobKind
}

interface PurgedFileRow {
  id: string
  file_path: string | null
  cover_path: string | null
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

// ─────────────────────────────────────────────────────────────────────────────
// Local-file reaper. A cross-device permanent-delete propagates `purged_at` to
// peers, but the sync-apply layer is DB-only — so a peer's on-disk content/cover
// files are never unlinked and leak on disk (the row is hidden from both Library
// and Trash, so the user can't reach it to clean up). This sweep reclaims them.
//
// The purging device already unlinks inline at purge time; its rows still pass
// through here once (the files are gone → treated as reclaimed). The NEW work is
// on devices that RECEIVED a purge via pull. `files_reclaimed` (device-local,
// migration 42) bounds the sweep to one pass per row — purged tombstones live
// forever, so an unguarded sweep would re-stat every already-gone file each round.
//
// Pure local: no session/config gate. The only new work exists after a pull, which
// only happens with sync on, so it hangs off the same post-successful-round hook.
// ─────────────────────────────────────────────────────────────────────────────

/** Unlink the local files of permanently-deleted items and mark them reclaimed.
 *  Idempotent + retry-safe: a row is marked reclaimed only once its bytes are
 *  actually gone (delete succeeded or the file was already absent); any other
 *  error (e.g. the file is open in the reader on Windows) leaves it for the next
 *  sweep. Never throws. `file_path`/`cover_path` are per-item (id-derived, no local
 *  sharing after import-dedup), so unlinking one can't strand another item's bytes. */
export async function reapPurgedLocalFiles(): Promise<void> {
  if (reapingLocal) return
  reapingLocal = true
  try {
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT id, file_path, cover_path FROM items
         WHERE purged_at IS NOT NULL AND files_reclaimed = 0`,
      )
      .all() as PurgedFileRow[]

    for (const { id, file_path, cover_path } of rows) {
      const contentGone = tryUnlink(file_path && safeContentPath(file_path))
      const coverGone = tryUnlink(cover_path && safeUserDataPath(cover_path))
      // Only settle the row when BOTH files are gone; a transient failure on either
      // leaves files_reclaimed=0 so the next sweep retries (a re-unlink of the
      // already-removed sibling just no-ops via ENOENT).
      if (contentGone && coverGone) {
        db.prepare(`UPDATE items SET files_reclaimed = 1 WHERE id = ?`).run(id)
      }
    }
  } finally {
    reapingLocal = false
  }
}

/** Delete a file, treating "already gone" (ENOENT) as success. Returns false only
 *  on a real failure (permission, busy) so the caller can retry. A null/empty path
 *  means "nothing to delete" → gone. */
function tryUnlink(absPath: string | null | false): boolean {
  if (!absPath) return true
  try {
    unlinkSync(absPath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return true
    return false // real error (EPERM/EBUSY/…) → leave unreclaimed, retry next sweep
  }
}

/** Fire-and-forget both post-round sweeps (R2 orphans + local purged files),
 *  recording the combined promise so tests can await it deterministically. */
export function scheduleReap(): void {
  lastSweep = Promise.all([reapOrphanBlobs(), reapPurgedLocalFiles()]).then(() => {})
}

/** Test-only: await the last fire-and-forget sweep (deterministic assertions). */
export function __whenReapedForTest(): Promise<void> {
  return lastSweep
}

/** Test-only: clear the single-flight guards between tests. */
export function __resetForTest(): void {
  reaping = false
  reapingLocal = false
  lastSweep = Promise.resolve()
}
