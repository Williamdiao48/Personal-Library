import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { invoke, resetIpc } from '../../../test/stubs/electron'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'

// enqueueItemBackup computes hashes off local files + kicks a network drain — mock
// it so this suite stays focused on the handler's DB behaviour (gate flip + guards).
const h = vi.hoisted(() => ({
  enqueueItemBackup: vi.fn(() => Promise.resolve()),
  flushNow: vi.fn(() => Promise.resolve()),
}))
vi.mock('../cloud/uploader', () => ({ enqueueItemBackup: h.enqueueItemBackup }))
// The backup handler AWAITS a durable sync push so blob_hash/cover_hash reach the
// user's other devices before the call returns (durable "fire and forget" — the
// user can quit immediately after). Mock the seam.
vi.mock('../cloud/sync/syncService', () => ({ flushNow: h.flushNow }))

import { registerCloudHandlers } from './cloud'

let db: TestDb

beforeEach(() => {
  resetIpc()
  vi.clearAllMocks()
  db = openTestDb()
  registerCloudHandlers()
})
afterEach(() => closeTestDb())

const cloudBackupOf = (id: string): number =>
  (db.prepare(`SELECT cloud_backup FROM items WHERE id = ?`).get(id) as { cloud_backup: number })
    .cloud_backup

describe('cloud:backupItem', () => {
  it('enqueues the item then flips its cloud_backup gate on', async () => {
    const id = seedItem(db, { file_path: 'a.html' }) // cloud_backup defaults to 0
    expect(cloudBackupOf(id)).toBe(0)

    const res = await invoke('cloud:backupItem', id)

    // Mocked enqueue records no blob_hash/ledger row, so the real state is unknown
    // yet → reported as still-pending. The gate flips on regardless (intent).
    expect(res).toEqual({ ok: true, state: 'pending' })
    expect(h.enqueueItemBackup).toHaveBeenCalledWith(id)
    expect(cloudBackupOf(id)).toBe(1)
    // A successful backup awaits a durable push so the new blob_hash pointer is in
    // Postgres before the call returns (survives an immediate quit).
    expect(h.flushNow).toHaveBeenCalledTimes(1)
  })

  it('reports state:synced from the ledger when the blob uploaded', async () => {
    const id = seedItem(db, { file_path: 'a.html' })
    // Simulate the uploader: stamp the item's content hash + a synced ledger row.
    h.enqueueItemBackup.mockImplementationOnce(async () => {
      db.prepare(`UPDATE items SET blob_hash = 'hh' WHERE id = ?`).run(id)
      db.prepare(
        `INSERT INTO blob_sync (content_hash, kind, state, updated_at) VALUES ('hh','content','synced',0)`,
      ).run()
    })

    const res = await invoke('cloud:backupItem', id)

    expect(res).toEqual({ ok: true, state: 'synced' })
    expect(cloudBackupOf(id)).toBe(1)
  })

  it('reports ok:false + state:error (with the ledger error) when upload failed', async () => {
    const id = seedItem(db, { file_path: 'a.html' })
    h.enqueueItemBackup.mockImplementationOnce(async () => {
      db.prepare(`UPDATE items SET blob_hash = 'hh' WHERE id = ?`).run(id)
      db.prepare(
        `INSERT INTO blob_sync (content_hash, kind, state, error, updated_at) VALUES ('hh','content','error','R2 PUT failed (400)',0)`,
      ).run()
    })

    const res = await invoke('cloud:backupItem', id)

    expect(res).toEqual({ ok: false, state: 'error', error: 'R2 PUT failed (400)' })
    // Gate still flips on — intent to back up persists so the card shows Retry.
    expect(cloudBackupOf(id)).toBe(1)
  })

  it('returns an error and never touches the DB for an unknown id', async () => {
    const res = await invoke('cloud:backupItem', 'does-not-exist')
    expect(res).toEqual({ ok: false, error: 'Item not found.' })
    expect(h.enqueueItemBackup).not.toHaveBeenCalled()
  })

  it('ignores a soft-deleted item (treated as not found)', async () => {
    const id = seedItem(db, { file_path: 'a.html' })
    db.prepare(`UPDATE items SET deleted_at = ? WHERE id = ?`).run(Date.now(), id)

    const res = await invoke('cloud:backupItem', id)

    expect((res as { ok: boolean }).ok).toBe(false)
    expect(h.enqueueItemBackup).not.toHaveBeenCalled()
  })

  it('surfaces the error and leaves the gate off when enqueue fails', async () => {
    const id = seedItem(db, { file_path: 'a.html' })
    h.enqueueItemBackup.mockRejectedValueOnce(new Error('no local source'))

    const res = await invoke('cloud:backupItem', id)

    expect(res).toEqual({ ok: false, error: 'no local source' })
    // Gate must stay off so the item never reads as "backed up" when it isn't.
    expect(cloudBackupOf(id)).toBe(0)
    // Nothing was stamped/uploaded → no sync to flush.
    expect(h.flushNow).not.toHaveBeenCalled()
  })
})

describe('cloud:getBackupCounts', () => {
  const setLedger = (hash: string, state: 'pending' | 'synced' | 'error') =>
    db
      .prepare(
        `INSERT INTO blob_sync (content_hash, kind, state, updated_at) VALUES (?, 'content', ?, 0)`,
      )
      .run(hash, state)

  it('tallies pending + error blob_sync rows (ignores synced)', async () => {
    setLedger('a', 'pending')
    setLedger('b', 'pending')
    setLedger('c', 'error')
    setLedger('d', 'synced')

    expect(await invoke('cloud:getBackupCounts')).toEqual({ pending: 2, error: 1 })
  })

  it('returns zeros for an empty ledger', async () => {
    expect(await invoke('cloud:getBackupCounts')).toEqual({ pending: 0, error: 0 })
  })

  // Regression (Wave 3 / L3): the status pill polls this on blobState nudges; a poll
  // can land in the window where backup:import has closed the DB before relaunch.
  // It must report zeros, not reject the IPC with "Database not initialized".
  it('returns zeros (no throw) when the DB is closed mid-import', async () => {
    closeTestDb() // simulate the import swap having nulled the singleton
    expect(await invoke('cloud:getBackupCounts')).toEqual({ pending: 0, error: 0 })
  })
})
