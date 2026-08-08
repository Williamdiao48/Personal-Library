import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BrowserWindow } from '../../../test/stubs/electron'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'

// Mock the seams so the uploader test is about the LEDGER + DRAIN logic, not file
// packing (itemBlob has its own tests) or the network (presign/fetch stubbed).
const h = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  getSession: vi.fn(async () => ({ data: { session: { access_token: 't' } } })),
  presignBlobUrl: vi.fn(async () => 'https://r2.example/put-url'),
  buildContentBlob: vi.fn(() => ({ data: Buffer.from('CONTENT'), hash: 'contenthash' })),
  buildCoverBlob: vi.fn((): { data: Buffer; hash: string } | null => null),
}))
vi.mock('../auth/client', () => ({
  isConfigured: h.isConfigured,
  getSupabase: () => ({ auth: { getSession: h.getSession } }),
}))
vi.mock('./presign', () => ({ presignBlobUrl: h.presignBlobUrl }))
vi.mock('./itemBlob', () => ({
  buildContentBlob: h.buildContentBlob,
  buildCoverBlob: h.buildCoverBlob,
}))

import { enqueueItemBackup, drainOutbox } from './uploader'

let db: TestDb
let fetchMock: ReturnType<typeof vi.fn>

const blobRow = (hash: string) =>
  db.prepare(`SELECT * FROM blob_sync WHERE content_hash = ?`).get(hash) as
    { state: string; kind: string; error: string | null } | undefined

beforeEach(() => {
  db = openTestDb()
  vi.clearAllMocks()
  h.isConfigured.mockReturnValue(true)
  h.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } })
  h.buildContentBlob.mockReturnValue({ data: Buffer.from('CONTENT'), hash: 'contenthash' })
  h.buildCoverBlob.mockReturnValue(null)
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  closeTestDb()
  vi.unstubAllGlobals()
})

describe('enqueueItemBackup', () => {
  it('records blob_hash on the item, enqueues, and uploads the content blob', async () => {
    const id = seedItem(db, { file_path: 'a.epub' })
    await enqueueItemBackup(id)

    // item now carries the R2 address
    expect(db.prepare(`SELECT blob_hash FROM items WHERE id = ?`).get(id)).toMatchObject({
      blob_hash: 'contenthash',
    })
    // ledger row synced, PUT issued with the bytes
    expect(blobRow('contenthash')).toMatchObject({ kind: 'content', state: 'synced' })
    expect(h.presignBlobUrl).toHaveBeenCalledWith('put', 'content', 'contenthash', 7) // 'CONTENT'
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://r2.example/put-url')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT' })
  })

  it('also uploads a cover blob when the item has one', async () => {
    h.buildCoverBlob.mockReturnValue({ data: Buffer.from('JPEG'), hash: 'coverhash' })
    const id = seedItem(db, { file_path: 'a.epub', cover_path: 'content/a-cover.jpg' })
    await enqueueItemBackup(id)

    expect(db.prepare(`SELECT cover_hash FROM items WHERE id = ?`).get(id)).toMatchObject({
      cover_hash: 'coverhash',
    })
    expect(blobRow('coverhash')).toMatchObject({ kind: 'cover', state: 'synced' })
    expect(fetchMock).toHaveBeenCalledTimes(2) // content + cover
  })

  it('re-dirties the item so a backup finishing AFTER metadata sync still propagates', async () => {
    // Regression: blob_hash/cover_hash are synced columns, but backup usually
    // completes AFTER the item's metadata has pushed (which clears dirty). If the
    // hash update doesn't re-dirty the row, it never reaches other devices → their
    // pull-on-open ENOENTs the book forever.
    h.buildCoverBlob.mockReturnValue({ data: Buffer.from('JPEG'), hash: 'coverhash' })
    const id = seedItem(db, { file_path: 'a.epub', cover_path: 'content/a-cover.jpg' })
    // Simulate the row having already synced (the sync engine clears dirty on push).
    db.prepare(`UPDATE items SET dirty = 0 WHERE id = ?`).run(id)

    await enqueueItemBackup(id)

    expect(
      db.prepare(`SELECT dirty, blob_hash, cover_hash FROM items WHERE id = ?`).get(id),
    ).toMatchObject({ dirty: 1, blob_hash: 'contenthash', cover_hash: 'coverhash' })
  })

  it('does nothing for a missing/deleted item', async () => {
    await enqueueItemBackup('nope')
    expect(db.prepare(`SELECT COUNT(*) n FROM blob_sync`).get()).toMatchObject({ n: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('dedupes identical bytes across items — one ledger row, one upload', async () => {
    const a = seedItem(db, { id: 'a', file_path: 'a.epub' })
    const b = seedItem(db, { id: 'b', file_path: 'b.epub' })
    await enqueueItemBackup(a) // uploads contenthash
    await enqueueItemBackup(b) // same hash → already synced, upsert leaves it be

    expect(db.prepare(`SELECT COUNT(*) n FROM blob_sync`).get()).toMatchObject({ n: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('revives an errored row on re-enqueue so a manual retry uploads immediately', async () => {
    const id = seedItem(db, { file_path: 'a.epub' })
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 } as unknown as Response)
    await enqueueItemBackup(id) // first attempt fails → errored
    expect(blobRow('contenthash')?.state).toBe('error')

    // Re-enqueue: upsert revives error→pending, drain picks it up now (no backoff).
    await enqueueItemBackup(id)
    expect(blobRow('contenthash')).toMatchObject({ state: 'synced' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('broadcasts a cloud:blobState event to the renderer when a blob syncs', async () => {
    const send = vi.fn()
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([{ webContents: { send } }] as never)
    const id = seedItem(db, { file_path: 'a.epub' })
    await enqueueItemBackup(id)

    expect(send).toHaveBeenCalledWith('cloud:blobState', { hash: 'contenthash', state: 'synced' })
  })
})

describe('drainOutbox', () => {
  it('no-ops when signed out (session null) — row stays pending', async () => {
    const id = seedItem(db, { file_path: 'a.epub' })
    h.getSession.mockResolvedValue({ data: { session: null } } as never)
    await enqueueItemBackup(id)

    expect(blobRow('contenthash')).toMatchObject({ state: 'pending' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('no-ops when cloud is not configured', async () => {
    const id = seedItem(db, { file_path: 'a.epub' })
    h.isConfigured.mockReturnValue(false)
    await enqueueItemBackup(id)
    expect(blobRow('contenthash')).toMatchObject({ state: 'pending' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('marks the blob errored (retriable) on a failed PUT', async () => {
    const id = seedItem(db, { file_path: 'a.epub' })
    fetchMock.mockResolvedValue({ ok: false, status: 403 } as unknown as Response)
    await enqueueItemBackup(id)

    const row = blobRow('contenthash')
    expect(row?.state).toBe('error')
    expect(row?.error).toMatch(/403/)
  })

  it('errors when the source item is gone by drain time (nothing to upload)', async () => {
    const id = seedItem(db, { file_path: 'a.epub' })
    // Enqueue while signed out so the row stays pending and no upload happens…
    h.getSession.mockResolvedValue({ data: { session: null } } as never)
    await enqueueItemBackup(id)
    // …then the item is hard-deleted, and a later drain (now signed in) finds no source.
    db.prepare(`DELETE FROM items WHERE id = ?`).run(id)
    h.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } })
    await drainOutbox()

    const row = blobRow('contenthash')
    expect(row?.state).toBe('error')
    expect(row?.error).toMatch(/no local source/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries a pending row on a subsequent drain', async () => {
    const id = seedItem(db, { file_path: 'a.epub' })
    h.getSession.mockResolvedValue({ data: { session: null } } as never)
    await enqueueItemBackup(id) // stays pending (signed out)
    expect(fetchMock).not.toHaveBeenCalled()

    h.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } })
    await drainOutbox() // now signed in → uploads
    expect(blobRow('contenthash')).toMatchObject({ state: 'synced' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
