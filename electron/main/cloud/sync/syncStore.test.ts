import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openTestDb, closeTestDb } from '../../../../test/db/harness'
import {
  getDeviceId,
  getCursor,
  setCursor,
  getLastSyncedUserId,
  setLastSyncedUserId,
  resetSyncStateForNewUser,
} from './syncStore'

// Pure SQLite side of the sync engine, exercised against the in-memory harness
// (real bringUpSchema, Node ABI). Focus here: the account-identity bookkeeping that
// heals a device whose sync state belongs to a now-deleted / switched-away account.

let db: ReturnType<typeof openTestDb>

beforeEach(() => {
  db = openTestDb()
})

afterEach(() => {
  closeTestDb()
})

function seedItem(id: string, dirty: 0 | 1): void {
  db.prepare(
    `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count, date_saved, date_modified, updated_at, dirty)
     VALUES (?, 'T', NULL, NULL, 'article', ?, 1, 100, 100, 100, ?)`,
  ).run(id, `${id}.html`, dirty)
}

describe('last-synced user id', () => {
  it('defaults to null before any account has synced', () => {
    expect(getLastSyncedUserId(db)).toBeNull()
  })

  it('round-trips through set/get', () => {
    setLastSyncedUserId(db, 'user-a')
    expect(getLastSyncedUserId(db)).toBe('user-a')
    setLastSyncedUserId(db, 'user-b')
    expect(getLastSyncedUserId(db)).toBe('user-b')
  })

  it('sets the id without clobbering the existing device_id', () => {
    const device = getDeviceId(db) // materializes the sync_meta row
    setLastSyncedUserId(db, 'user-a')
    expect(getDeviceId(db)).toBe(device) // same row, device_id intact
    expect(getLastSyncedUserId(db)).toBe('user-a')
  })

  it('materializes the sync_meta row when set is the first thing to touch it', () => {
    // getDeviceId hasn't run yet; set must still succeed (device_id is NOT NULL).
    setLastSyncedUserId(db, 'user-a')
    expect(getLastSyncedUserId(db)).toBe('user-a')
    expect(getDeviceId(db)).toBeTruthy()
  })
})

describe('resetSyncStateForNewUser', () => {
  it('clears every pull cursor so the next pull starts from 0', () => {
    setCursor(db, 'items', 500)
    setCursor(db, 'annotations', 42)

    resetSyncStateForNewUser(db)

    expect(getCursor(db, 'items')).toBe(0)
    expect(getCursor(db, 'annotations')).toBe(0)
  })

  it('re-dirties every synced row across tables so the whole library re-pushes', () => {
    seedItem('i1', 0) // rows that look already-synced
    seedItem('i2', 0)
    db.prepare(
      `INSERT INTO progress (item_id, status, updated_at, dirty) VALUES ('i1', 'reading', 100, 0)`,
    ).run()

    resetSyncStateForNewUser(db)

    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE dirty = 1`).get() as { n: number }).n,
    ).toBe(2)
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM progress WHERE dirty = 1`).get() as { n: number }).n,
    ).toBe(1)
  })

  it('is idempotent (a second reset is a no-op)', () => {
    seedItem('i1', 0)
    resetSyncStateForNewUser(db)
    resetSyncStateForNewUser(db)
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE dirty = 1`).get() as { n: number }).n,
    ).toBe(1)
    expect(getCursor(db, 'items')).toBe(0)
  })
})
