import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BrowserWindow } from '../../../test/stubs/electron'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'

// Mock the seams so the uploader test is about the LEDGER + DRAIN logic, not file
// packing (itemBlob has its own tests) or the network (presign/fetch stubbed).
const h = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  getSession: vi.fn(async () => ({ data: { session: { access_token: 't' } } })),
  presignBlobUrl: vi.fn(async () => 'https://r2.example/put-url'),
  buildContentBlob: vi.fn((_item: { id: string }) => ({
    data: Buffer.from('CONTENT'),
    hash: 'contenthash',
  })),
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

import { enqueueItemBackup, drainOutbox, recordItemBlobs, refreshItemBackup } from './uploader'

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

describe('blobState broadcast on enqueue', () => {
  it('emits a pending blobState when a backup is newly queued (drives the status pill)', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const winSpy = vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([
      {
        webContents: {
          send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
        },
      },
    ] as unknown as BrowserWindow[])
    try {
      const id = seedItem(db, { file_path: 'a.epub' })
      await enqueueItemBackup(id)
      // The insert broadcasts pending up front (before the drain flips it to synced),
      // so the pill can show "Backing up…" without awaiting the upload.
      expect(sent).toContainEqual({
        channel: 'cloud:blobState',
        payload: { hash: 'contenthash', state: 'pending' },
      })
    } finally {
      winSpy.mockRestore()
    }
  })
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

  it('DROPS the dead row when the source item is gone by drain time (no false permanent failure)', async () => {
    const id = seedItem(db, { file_path: 'a.epub' })
    // Enqueue while signed out so the row stays pending and no upload happens…
    h.getSession.mockResolvedValue({ data: { session: null } } as never)
    await enqueueItemBackup(id)
    // …then the item is hard-deleted, and a later drain (now signed in) finds no source.
    db.prepare(`DELETE FROM items WHERE id = ?`).run(id)
    h.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } })
    await drainOutbox()

    // The row is DROPPED, not parked in 'error' forever — otherwise it would re-fail
    // every drain and (via getBackupCounts) falsely read as "Backup failed" with no
    // card to retry from. Nothing was uploaded.
    expect(blobRow('contenthash')).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does NOT drop a genuine upload failure — the source still exists, so it stays retriable', async () => {
    const id = seedItem(db, { file_path: 'a.epub' })
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as unknown as Response)
    await enqueueItemBackup(id)

    // Real R2 failure with the item still present → kept as 'error' (card shows Retry).
    expect(blobRow('contenthash')).toMatchObject({ state: 'error' })
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

// regression CLO-7: blobs are content-addressed, so bytes that change after their hash
// was recorded (append / re-scrape / new cover) must get a NEW address — never be
// uploaded under the old one, where every peer's integrity check would reject them.
describe('content changes after the hash was recorded (CLO-7)', () => {
  const signedOut = () => h.getSession.mockResolvedValue({ data: { session: null } } as never)
  const signedIn = () =>
    h.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } })
  const itemRow = (id: string) =>
    db.prepare(`SELECT blob_hash, dirty FROM items WHERE id = ?`).get(id) as {
      blob_hash: string | null
      dirty: number
    }
  const putHashes = () =>
    h.presignBlobUrl.mock.calls.map((c) => (c as unknown as unknown[])[2] as string)

  it('a pending upload whose bytes changed is re-addressed, never PUT under the old hash', async () => {
    const id = seedItem(db, { file_path: 'a.html' })
    signedOut()
    await enqueueItemBackup(id) // recorded as contenthash, still pending
    // The item is appended to before the drain runs: its files now pack differently.
    h.buildContentBlob.mockReturnValue({ data: Buffer.from('CONTENT+CH2'), hash: 'newhash' })
    db.prepare(`UPDATE items SET dirty = 0 WHERE id = ?`).run(id)
    signedIn()

    await drainOutbox()

    expect(putHashes()).not.toContain('contenthash')
    expect(h.presignBlobUrl).toHaveBeenCalledWith('put', 'content', 'newhash', 11)
    expect(blobRow('contenthash')).toBeUndefined() // stale row dropped
    expect(blobRow('newhash')).toMatchObject({ state: 'synced' }) // uploaded in the same drain
    expect(itemRow(id)).toMatchObject({ blob_hash: 'newhash', dirty: 1 }) // pointer re-pushes
  })

  it('still uploads the old hash from an unchanged item that shares those bytes', async () => {
    const a = seedItem(db, { id: 'a', file_path: 'a.html' })
    const b = seedItem(db, { id: 'b', file_path: 'b.html' })
    signedOut()
    await enqueueItemBackup(a)
    await enqueueItemBackup(b) // identical bytes → same contenthash, one ledger row
    // Only `a` changes. `b` still holds bytes that genuinely hash to contenthash.
    h.buildContentBlob.mockImplementation((item: { id: string }) =>
      item.id === 'a'
        ? { data: Buffer.from('CHANGED'), hash: 'ahash' }
        : { data: Buffer.from('CONTENT'), hash: 'contenthash' },
    )
    signedIn()

    await drainOutbox()

    expect(blobRow('contenthash')).toMatchObject({ state: 'synced' })
    expect(itemRow(b).blob_hash).toBe('contenthash')
    // `a` was not re-addressed by the drain (a sibling satisfied the hash); its own
    // change is re-addressed by the writer via refreshItemBackup.
    expect(itemRow(a).blob_hash).toBe('contenthash')
  })

  it('drops the row (no upload) when the drifted item cannot be re-packed', async () => {
    const id = seedItem(db, { file_path: 'a-ch0.html' })
    signedOut()
    await enqueueItemBackup(id)
    let calls = 0
    h.buildContentBlob.mockImplementation(() => {
      // 1st call (drain resolve): bytes drifted. 2nd (re-address): incomplete chapters.
      if (calls++ === 0) return { data: Buffer.from('X'), hash: 'drifted' }
      throw new Error('incomplete chapter files locally (missing ch0)')
    })
    signedIn()

    await drainOutbox()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(blobRow('contenthash')).toBeUndefined()
    expect(itemRow(id).blob_hash).toBe('contenthash') // stale but intact pointer kept
  })
})

describe('refreshItemBackup', () => {
  const itemRow = (id: string) =>
    db.prepare(`SELECT blob_hash, dirty FROM items WHERE id = ?`).get(id) as {
      blob_hash: string | null
      dirty: number
    }
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('re-addresses and uploads an already-synced backup whose bytes changed', async () => {
    const id = seedItem(db, { file_path: 'a.html' })
    await enqueueItemBackup(id)
    expect(blobRow('contenthash')).toMatchObject({ state: 'synced' })
    db.prepare(`UPDATE items SET dirty = 0 WHERE id = ?`).run(id)

    h.buildContentBlob.mockReturnValue({ data: Buffer.from('CONTENT+CH2'), hash: 'newhash' })
    refreshItemBackup(id)
    // The pointer moves synchronously, so the caller's notifyLocalMutation pushes it.
    expect(itemRow(id)).toMatchObject({ blob_hash: 'newhash', dirty: 1 })
    await flush()
    expect(blobRow('newhash')).toMatchObject({ state: 'synced' })
  })

  it('acts on an item backed up by ANOTHER device (blob_hash set, cloud_backup = 0 here)', () => {
    const id = seedItem(db, { file_path: 'a.html' })
    db.prepare(`UPDATE items SET blob_hash = 'peerhash', cloud_backup = 0 WHERE id = ?`).run(id)
    refreshItemBackup(id)
    expect(itemRow(id).blob_hash).toBe('contenthash')
  })

  it('is a no-op for an item that was never backed up', () => {
    const id = seedItem(db, { file_path: 'a.html' })
    refreshItemBackup(id)
    expect(itemRow(id).blob_hash).toBeNull()
    expect(db.prepare(`SELECT COUNT(*) n FROM blob_sync`).get()).toMatchObject({ n: 0 })
  })

  it('never throws, and keeps the old pointer, when the item cannot be packed', () => {
    const id = seedItem(db, { file_path: 'a.html' })
    db.prepare(`UPDATE items SET blob_hash = 'oldhash', cloud_backup = 1 WHERE id = ?`).run(id)
    h.buildContentBlob.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => refreshItemBackup(id)).not.toThrow()
    expect(itemRow(id).blob_hash).toBe('oldhash')
    warn.mockRestore()
  })
})

describe('drainOutbox serialization', () => {
  it('runs a follow-up drain for a request made while one was in flight', async () => {
    const a = seedItem(db, { id: 'a', file_path: 'a.html' })
    const b = seedItem(db, { id: 'b', file_path: 'b.html' })
    h.buildContentBlob.mockImplementation((item: { id: string }) => ({
      data: Buffer.from(item.id),
      hash: `${item.id}hash`,
    }))
    let release!: () => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          release = () => r({ ok: true, status: 200 } as unknown as Response)
        }),
    )
    recordItemBlobs(a)
    const first = drainOutbox() // blocks on a's PUT
    await new Promise((r) => setTimeout(r, 0))
    recordItemBlobs(b) // enqueued after the first drain already selected its rows
    await drainOutbox() // in flight → only requests a follow-up
    release()
    await first

    expect(blobRow('ahash')).toMatchObject({ state: 'synced' })
    expect(blobRow('bhash')).toMatchObject({ state: 'synced' })
  })
})
