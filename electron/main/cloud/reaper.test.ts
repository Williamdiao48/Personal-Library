import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'

// Mock the seams so the test is about the LEDGER + REF-COUNT logic, not the network
// (presign/fetch stubbed) or auth (config/session stubbed).
const h = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  getSession: vi.fn(async () => ({ data: { session: { access_token: 't' } } })),
  presignBlobUrl: vi.fn(async () => 'https://r2.example/delete-url'),
}))
vi.mock('../auth/client', () => ({
  isConfigured: h.isConfigured,
  getSupabase: () => ({ auth: { getSession: h.getSession } }),
}))
vi.mock('./presign', () => ({ presignBlobUrl: h.presignBlobUrl }))

import { reapOrphanBlobs, __resetForTest } from './reaper'

let db: TestDb
let fetchMock: ReturnType<typeof vi.fn>

const enqueue = (hash: string, kind: 'content' | 'cover', state = 'synced') =>
  db
    .prepare(`INSERT INTO blob_sync (content_hash, kind, state, updated_at) VALUES (?, ?, ?, ?)`)
    .run(hash, kind, state, 0)

const setBlob = (
  id: string,
  cols: { blob_hash?: string; cover_hash?: string; purged_at?: number | null },
) =>
  db
    .prepare(`UPDATE items SET blob_hash = ?, cover_hash = ?, purged_at = ? WHERE id = ?`)
    .run(cols.blob_hash ?? null, cols.cover_hash ?? null, cols.purged_at ?? null, id)

const ledgerCount = () => (db.prepare(`SELECT COUNT(*) n FROM blob_sync`).get() as { n: number }).n

beforeEach(() => {
  db = openTestDb()
  __resetForTest()
  vi.clearAllMocks()
  h.isConfigured.mockReturnValue(true)
  h.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } })
  fetchMock = vi.fn(async () => ({ ok: true, status: 204 }) as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  closeTestDb()
  vi.unstubAllGlobals()
})

describe('reapOrphanBlobs', () => {
  it('reaps a synced blob whose only referencing item is purged', async () => {
    const id = seedItem(db, { deleted_at: 1000 })
    setBlob(id, { blob_hash: 'H', purged_at: 2000 })
    enqueue('H', 'content')

    await reapOrphanBlobs()

    expect(h.presignBlobUrl).toHaveBeenCalledWith('delete', 'content', 'H')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://r2.example/delete-url')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' })
    expect(ledgerCount()).toBe(0) // ledger row dropped after a successful delete
  })

  it('keeps a blob still referenced by a LIVE item (purged_at NULL)', async () => {
    const id = seedItem(db)
    setBlob(id, { blob_hash: 'H', purged_at: null })
    enqueue('H', 'content')

    await reapOrphanBlobs()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ledgerCount()).toBe(1)
  })

  it('keeps a blob referenced by a merely-TRASHED (restorable) item — trash is not purge', async () => {
    // deleted_at set (in Trash) but purged_at NULL → still restorable → keep bytes.
    const id = seedItem(db, { deleted_at: 1000 })
    setBlob(id, { blob_hash: 'H', purged_at: null })
    enqueue('H', 'content')

    await reapOrphanBlobs()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ledgerCount()).toBe(1)
  })

  it('keeps a deduped blob when a SIBLING item still references it un-purged', async () => {
    const x = seedItem(db, { id: 'x', deleted_at: 1000 })
    const y = seedItem(db, { id: 'y' })
    setBlob(x, { blob_hash: 'H', purged_at: 2000 }) // purged
    setBlob(y, { blob_hash: 'H', purged_at: null }) // still live → shared hash wanted
    enqueue('H', 'content')

    await reapOrphanBlobs()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ledgerCount()).toBe(1)
  })

  it('reaps a cover blob via the cover_hash column', async () => {
    const id = seedItem(db, { deleted_at: 1000 })
    setBlob(id, { cover_hash: 'C', purged_at: 2000 })
    enqueue('C', 'cover')

    await reapOrphanBlobs()

    expect(h.presignBlobUrl).toHaveBeenCalledWith('delete', 'cover', 'C')
    expect(ledgerCount()).toBe(0)
  })

  it('ignores a not-yet-uploaded (pending) ledger row', async () => {
    const id = seedItem(db, { deleted_at: 1000 })
    setBlob(id, { blob_hash: 'H', purged_at: 2000 })
    enqueue('H', 'content', 'pending')

    await reapOrphanBlobs()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ledgerCount()).toBe(1)
  })

  it('keeps the ledger row on a failed DELETE (retriable), never throws', async () => {
    const id = seedItem(db, { deleted_at: 1000 })
    setBlob(id, { blob_hash: 'H', purged_at: 2000 })
    enqueue('H', 'content')
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as unknown as Response)

    await expect(reapOrphanBlobs()).resolves.toBeUndefined()
    expect(ledgerCount()).toBe(1) // kept for the next sweep
  })

  it('swallows a thrown fetch (offline) and keeps the row', async () => {
    const id = seedItem(db, { deleted_at: 1000 })
    setBlob(id, { blob_hash: 'H', purged_at: 2000 })
    enqueue('H', 'content')
    fetchMock.mockRejectedValue(new Error('network down'))

    await expect(reapOrphanBlobs()).resolves.toBeUndefined()
    expect(ledgerCount()).toBe(1)
  })

  it('no-ops when signed out (session null)', async () => {
    const id = seedItem(db, { deleted_at: 1000 })
    setBlob(id, { blob_hash: 'H', purged_at: 2000 })
    enqueue('H', 'content')
    h.getSession.mockResolvedValue({ data: { session: null } } as never)

    await reapOrphanBlobs()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ledgerCount()).toBe(1)
  })

  it('no-ops when cloud is not configured', async () => {
    const id = seedItem(db, { deleted_at: 1000 })
    setBlob(id, { blob_hash: 'H', purged_at: 2000 })
    enqueue('H', 'content')
    h.isConfigured.mockReturnValue(false)

    await reapOrphanBlobs()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ledgerCount()).toBe(1)
  })
})
