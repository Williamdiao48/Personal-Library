import { ipcMain } from 'electron'
import { getDb } from '../db'
import { enqueueItemBackup } from '../cloud/uploader'

// Renderer-facing seam for the Phase 2 per-item cloud actions. "Back up this
// book" is the counterpart to the capture-time opt-in (Decision 8) for items
// that already live in the library: it computes + enqueues the item's blobs and
// then flips its cloud_backup gate on. The uploader drains the queue (best-effort,
// retryable), so this stays safe when signed out or offline — the bytes simply
// upload on the next drain (e.g. after sign-in).

interface BackupResult {
  ok: boolean
  state?: 'pending' | 'synced' | 'error'
  error?: string
}

export function registerCloudHandlers(): void {
  ipcMain.handle('cloud:backupItem', async (_e, id: string): Promise<BackupResult> => {
    const db = getDb()
    const item = db.prepare(`SELECT id FROM items WHERE id = ? AND deleted_at IS NULL`).get(id) as
      { id: string } | undefined
    if (!item) return { ok: false, error: 'Item not found.' }

    // Compute hashes + enqueue first (this also records blob_hash/cover_hash on
    // the item and awaits a drain). Only flip the privacy gate once that succeeds,
    // so an item that couldn't be packaged never shows as backed-up.
    try {
      await enqueueItemBackup(id)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    // cloud_backup is intent ("keep this backed up") — set it even if the upload
    // failed, so a failed item shows "Backup failed — Retry" rather than reverting.
    db.prepare(`UPDATE items SET cloud_backup = 1 WHERE id = ?`).run(id)

    // enqueueItemBackup awaited the drain, so the content blob's ledger row now
    // reflects the real outcome. Report it so the card renders truth immediately.
    const row = db
      .prepare(
        `SELECT bs.state AS state, bs.error AS error
         FROM items i LEFT JOIN blob_sync bs ON bs.content_hash = i.blob_hash
         WHERE i.id = ?`,
      )
      .get(id) as { state?: 'pending' | 'synced' | 'error'; error?: string | null } | undefined
    const state = row?.state
    if (state === 'error') return { ok: false, state, error: row?.error ?? 'Upload failed.' }
    return { ok: true, state: state ?? 'pending' }
  })
}
