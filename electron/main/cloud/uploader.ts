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
// A drain requested while one was running. Honoured by one follow-up pass once the
// current drain finishes, so a blob enqueued mid-drain (e.g. a re-address after a
// content change) doesn't wait for the next unrelated trigger.
let drainRequested = false

// A drain re-addresses items whose bytes drifted under a pending hash (see
// resolveBlobBytes), which enqueues new rows. Re-select at most this many times so
// those uploads happen in the same drain, without risking an unbounded loop.
const MAX_DRAIN_PASSES = 3

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
  const info = getDb()
    .prepare(
      `INSERT INTO blob_sync (content_hash, kind, state, updated_at)
       VALUES (?, ?, 'pending', ?)
       ON CONFLICT(content_hash) DO UPDATE SET state = 'pending', updated_at = excluded.updated_at
         WHERE blob_sync.state = 'error'`,
    )
    .run(hash, kind, Date.now())
  // A fresh insert or an error→pending revive actually queued a backup — tell the
  // renderer so the status pill shows "Backing up…" immediately. changes === 0 means
  // the row was already pending/synced (nothing new), so stay quiet.
  if (info.changes > 0) broadcastBlobState(hash, 'pending')
}

/** Notify the renderer a blob's sync state changed so cards driven by
 *  `blob_sync.state` (via items.blob_hash) update live — covers the fire-and-forget
 *  capture path and background drains, which don't await an IPC round-trip. The
 *  status pill also listens, refetching the authoritative counts on each event. */
function broadcastBlobState(hash: string, state: 'pending' | 'synced' | 'error'): void {
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
 * enqueue them in the ledger — WITHOUT draining. The caller is responsible for a
 * subsequent `drainOutbox()`. Split out from `enqueueItemBackup` so a bulk backup
 * can record every item first and then drain the whole outbox in a single pass,
 * rather than one full drain per item. Safe to call more than once (idempotent).
 */
export function recordItemBlobs(itemId: string): void {
  const db = getDb()
  const item = db
    .prepare(`SELECT id, file_path, cover_path FROM items WHERE id = ? AND deleted_at IS NULL`)
    .get(itemId) as ItemBlobRow | undefined
  if (!item) return

  // Re-dirty the row (dirty = 1): backup usually completes AFTER the item's
  // metadata has already synced (which clears dirty), and blob_hash/cover_hash ARE
  // synced columns. Without re-dirtying, the freshly-recorded hash never pushes, so
  // another device keeps blob_hash = NULL and pull-on-open ENOENTs the book forever.
  // Same reasoning as backfillFileHashes; the server restamps updated_at on push.
  const content = buildContentBlob(item)
  db.prepare(`UPDATE items SET blob_hash = ?, dirty = 1 WHERE id = ?`).run(content.hash, itemId)
  enqueueBlob(content.hash, 'content')

  const cover = buildCoverBlob(item)
  if (cover) {
    db.prepare(`UPDATE items SET cover_hash = ?, dirty = 1 WHERE id = ?`).run(cover.hash, itemId)
    enqueueBlob(cover.hash, 'cover')
  }
}

/**
 * Re-address a backed-up item's blobs after its on-disk bytes changed (appended
 * chapters, a re-scrape, a new cover). Blobs are content-addressed, so changed bytes
 * need a NEW hash: without this, blob_hash keeps pointing at the old archive (peers
 * restore stale content) and a still-pending upload would ship the new bytes under
 * the old key.
 *
 * "Backed up" is cloud_backup = 1 (this device's intent) OR a blob_hash (another
 * device backed it up — cloud_backup is device-local, the pointer is synced).
 * Synchronous up to the hash update, so a caller's following notifyLocalMutation()
 * pushes the new pointer in the same round; the upload drains in the background.
 * Never throws: a failure leaves the previous (stale but intact) backup in place.
 */
export function refreshItemBackup(itemId: string): void {
  const row = getDb()
    .prepare(`SELECT cloud_backup, blob_hash FROM items WHERE id = ? AND deleted_at IS NULL`)
    .get(itemId) as { cloud_backup: number; blob_hash: string | null } | undefined
  if (!row || (row.cloud_backup !== 1 && !row.blob_hash)) return
  try {
    recordItemBlobs(itemId)
  } catch (err) {
    console.warn(
      `[uploader] couldn't re-address backup for ${itemId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return
  }
  void drainOutbox().catch(() => {})
}

/**
 * Compute an item's content (+ cover) blob hashes, record them on the item, and
 * enqueue them for upload, then kick a drain. Called after a capture the user
 * opted into cloud backup for. Safe to call more than once (idempotent).
 */
export async function enqueueItemBackup(itemId: string): Promise<void> {
  recordItemBlobs(itemId)
  await drainOutbox()
}

// ── drain ────────────────────────────────────────────────────────────────────

/**
 * Rebuild a blob's bytes from a live item that carries that hash (any item with
 * identical bytes yields the same blob — content-addressing).
 *
 * The bytes are re-packed from the CURRENT files, which may have changed since the
 * hash was recorded (an append/re-scrape/new cover racing a pending upload).
 * Uploading them under the old key would plant bytes that fail every peer's
 * integrity check forever, so a hash mismatch is never uploaded: each drifted item
 * is re-addressed (a fresh hash + ledger row) and the stale row is dropped.
 */
function resolveBlobBytes(hash: string, kind: BlobKind): Buffer {
  const col = kind === 'content' ? 'blob_hash' : 'cover_hash'
  const items = getDb()
    .prepare(`SELECT id, file_path, cover_path FROM items WHERE ${col} = ? AND deleted_at IS NULL`)
    .all(hash) as ItemBlobRow[]
  // The source item was deleted before we drained — nothing to upload.
  if (!items.length)
    throw new NoSourceError(`no local source for ${kind} blob ${hash.slice(0, 12)}`)

  const drifted: string[] = []
  let firstError: unknown = null
  for (const item of items) {
    try {
      const blob = kind === 'content' ? buildContentBlob(item) : buildCoverBlob(item)
      if (blob && blob.hash === hash) return blob.data
      drifted.push(item.id)
    } catch (err) {
      firstError ??= err // e.g. a file missing on disk — another item may still match
    }
  }
  if (!drifted.length) throw firstError

  for (const id of drifted) {
    try {
      recordItemBlobs(id)
    } catch {
      // Unpackable now (e.g. incomplete chapters) — the item keeps its stale pointer.
    }
  }
  throw new StaleSourceError(`${kind} blob ${hash.slice(0, 12)} no longer matches its source`)
}

/** The blob's source item is gone (permanently deleted) — there's nothing to upload
 *  and no card to retry from, so the drain drops the dead ledger row rather than
 *  parking it in 'error' forever (which would falsely read as "backup failed"). */
class NoSourceError extends Error {}

/** Every item that carried the hash now has different bytes and was re-addressed —
 *  the hash no longer names anything to upload, so its row is dropped like NoSource. */
class StaleSourceError extends Error {}

async function uploadBlob(hash: string, kind: BlobKind): Promise<void> {
  const data = resolveBlobBytes(hash, kind)
  const url = await presignBlobUrl('put', kind, hash, data.length)
  // Buffer isn't in fetch's BodyInit union; hand it a plain Uint8Array view over
  // the same bytes (no copy). A Node Buffer is always ArrayBuffer-backed (never
  // SharedArrayBuffer), so the cast is safe and keeps the view typed correctly.
  const body = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
  const res = await fetch(url, { method: 'PUT', body })
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
 * after a capture, on sign-in). Serialized via the `draining` guard; a call made
 * while a drain is running is honoured by one follow-up drain when it finishes.
 */
export async function drainOutbox(): Promise<void> {
  if (draining) {
    drainRequested = true
    return
  }
  if (!isConfigured()) return
  const supabase = getSupabase()
  if (!supabase) return
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return // signed out → nothing to upload

  draining = true
  drainRequested = false
  try {
    for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
      let readdressed = false
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
          if (err instanceof NoSourceError || err instanceof StaleSourceError) {
            // Dead row — the item it came from was permanently deleted, or its bytes
            // changed and it was re-addressed under a new hash. Drop it so it stops
            // re-failing every drain and no longer counts as a failed backup.
            getDb().prepare(`DELETE FROM blob_sync WHERE content_hash = ?`).run(row.content_hash)
            broadcastBlobState(row.content_hash, 'synced') // nudge the pill to refetch (no live card matches this orphan hash)
            if (err instanceof StaleSourceError) readdressed = true
          } else {
            markState(row.content_hash, 'error', err instanceof Error ? err.message : String(err))
          }
        }
      }
      // Re-addressing enqueued fresh rows — upload them now rather than next drain.
      if (!readdressed) break
    }
  } finally {
    draining = false
  }
  if (drainRequested) await drainOutbox()
}
