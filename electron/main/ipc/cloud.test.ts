import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { invoke, resetIpc } from '../../../test/stubs/electron'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'

// enqueueItemBackup computes hashes off local files + kicks a network drain — mock
// it so this suite stays focused on the handler's DB behaviour (gate flip + guards).
const h = vi.hoisted(() => ({ enqueueItemBackup: vi.fn(() => Promise.resolve()) }))
vi.mock('../cloud/uploader', () => ({ enqueueItemBackup: h.enqueueItemBackup }))

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

    expect(res).toEqual({ ok: true })
    expect(h.enqueueItemBackup).toHaveBeenCalledWith(id)
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

    expect(res.ok).toBe(false)
    expect(h.enqueueItemBackup).not.toHaveBeenCalled()
  })

  it('surfaces the error and leaves the gate off when enqueue fails', async () => {
    const id = seedItem(db, { file_path: 'a.html' })
    h.enqueueItemBackup.mockRejectedValueOnce(new Error('no local source'))

    const res = await invoke('cloud:backupItem', id)

    expect(res).toEqual({ ok: false, error: 'no local source' })
    // Gate must stay off so the item never reads as "backed up" when it isn't.
    expect(cloudBackupOf(id)).toBe(0)
  })
})
