import { BrowserWindow } from 'electron'
import { getDb } from '../db'
import { getSupabase, isConfigured } from '../auth/client'
import { buildContentBlob, buildCoverBlob, type ItemBlobRow } from './itemBlob'
import { presignBlobUrl, type BlobKind } from './presign'

// The Phase 2 outbox uploader. On an opted-in capture we compute an item's blob
// hashes and enqueue them in the local `blob_sync` ledger; a background drain
// presigns a PUT (Decision 7) and ships the bytes direct to R2. Everything is
// best-effort + retryable: capture/reading never block on it, and a signed-out or
// local-only user does nothing here (the cloud_backup gate is applied upstream at
// capture time — the flag lives on the item).

// Don't hammer a persistently-failing blob: an errored row waits this long before
// the next attempt. Pending rows always attempt immediately.
const RETRY_BACKOFF_MS = 60_000

// Guards against overlapping drains (startup + a fresh capture) double-uploading.
let draining = false

interface BlobSyncRow {
  content_hash: string
  kind: BlobKind
}

// ── blob_sync ledger ─────────────────────────────────────────────────────────

/** Insert a pending ledger row if absent. Never re-uploads an already-'synced'
 *  row — identical bytes across items share one hash → one row → dedupe — but
 *  DOES revive an 'error' row back to 'pending' so a re-enqueue (e.g. a manual
 *  Retry) uploads immediately instead of waiting out the retry backoff. */
function enqueueBlob(hash: string, kind: BlobKind): void {
  getDb()
    .prepare(
      `INSERT INTO blob_sync (content_hash, kind, state, updated_at)
       VALUES (?, ?, 'pending', ?)
       ON CONFLICT(content_hash) DO UPDATE SET state = 'pending', updated_at = excluded.updated_at
         WHERE blob_sync.state = 'error'`,
    )
    .run(hash, kind, Date.now())
}

/** Notify the renderer a blob's sync state changed so cards driven by
 *  `blob_sync.state` (via items.blob_hash) update live — covers the fire-and-forget
 *  capture path and background drains, which don't await an IPC round-trip. */
function broadcastBlobState(hash: string, state: 'synced' | 'error'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('cloud:blobState', { hash, state })
  }
}

function markState(hash: string, state: 'synced' | 'error', error: string | null = null): void {
  const now = Date.now()
  getDb()
    .prepare(
      `UPDATE blob_sync SET state = ?, error = ?, last_attempt_at = ?, updated_at = ?
       WHERE content_hash = ?`,
    )
    .run(state, error, now, now, hash)
  broadcastBlobState(hash, state)
}

// ── enqueue on capture ───────────────────────────────────────────────────────

/**
 * Compute an item's content (+ cover) blob hashes, record them on the item, and
 * enqueue them for upload, then kick a drain. Called after a capture the user
 * opted into cloud backup for. Safe to call more than once (idempotent).
 */
export async function enqueueItemBackup(itemId: string): Promise<void> {
  const db = getDb()
  const item = db
    .prepare(`SELECT id, file_path, cover_path FROM items WHERE id = ? AND deleted_at IS NULL`)
    .get(itemId) as ItemBlobRow | undefined
  if (!item) return

  const content = buildContentBlob(item)
  db.prepare(`UPDATE items SET blob_hash = ? WHERE id = ?`).run(content.hash, itemId)
  enqueueBlob(content.hash, 'content')

  const cover = buildCoverBlob(item)
  if (cover) {
    db.prepare(`UPDATE items SET cover_hash = ? WHERE id = ?`).run(cover.hash, itemId)
    enqueueBlob(cover.hash, 'cover')
  }

  await drainOutbox()
}

// ── drain ────────────────────────────────────────────────────────────────────

/** Rebuild a blob's bytes from whichever live item carries that hash (any item
 *  with identical bytes yields the same blob — content-addressing). */
function resolveBlobBytes(hash: string, kind: BlobKind): Buffer | null {
  const col = kind === 'content' ? 'blob_hash' : 'cover_hash'
  const item = getDb()
    .prepare(
      `SELECT id, file_path, cover_path FROM items WHERE ${col} = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(hash) as ItemBlobRow | undefined
  if (!item) return null
  return kind === 'content' ? buildContentBlob(item).data : (buildCoverBlob(item)?.data ?? null)
}

async function uploadBlob(hash: string, kind: BlobKind): Promise<void> {
  const data = resolveBlobBytes(hash, kind)
  // The source item was deleted before we drained — nothing to upload.
  if (!data) throw new Error(`no local source for ${kind} blob ${hash.slice(0, 12)}`)
  const url = await presignBlobUrl('put', kind, hash, data.length)
  const res = await fetch(url, { method: 'PUT', body: data })
  if (!res.ok) {
    // R2/S3 returns an XML body (<Code>…</Code>) explaining a 4xx; surface a
    // slice of it so failures are diagnosable instead of an opaque status. Guard
    // the body read (via a then-chain, so even a synchronous throw is caught).
    const detail = await Promise.resolve()
      .then(() => res.text())
      .catch(() => '')
    throw new Error(`R2 PUT failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }
}

/**
 * Drain pending (and retry-eligible errored) blobs to R2. No-ops when cloud is
 * unconfigured or no one is signed in, so it's always safe to call (startup,
 * after a capture, on sign-in). Serialized via the `draining` guard.
 */
export async function drainOutbox(): Promise<void> {
  if (draining || !isConfigured()) return
  const supabase = getSupabase()
  if (!supabase) return
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return // signed out → nothing to upload

  draining = true
  try {
    const cutoff = Date.now() - RETRY_BACKOFF_MS
    const rows = getDb()
      .prepare(
        `SELECT content_hash, kind FROM blob_sync
         WHERE state = 'pending'
            OR (state = 'error' AND (last_attempt_at IS NULL OR last_attempt_at < ?))
         ORDER BY updated_at ASC`,
      )
      .all(cutoff) as BlobSyncRow[]

    for (const row of rows) {
      try {
        await uploadBlob(row.content_hash, row.kind)
        markState(row.content_hash, 'synced')
      } catch (err) {
        markState(row.content_hash, 'error', err instanceof Error ? err.message : String(err))
      }
    }
  } finally {
    draining = false
  }
}
