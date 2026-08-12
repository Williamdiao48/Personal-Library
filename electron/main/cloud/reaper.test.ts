import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../../test/stubs/electron'
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

import { reapOrphanBlobs, reapPurgedLocalFiles, __resetForTest, REAP_GRACE_MS } from './reaper'

let db: TestDb
let fetchMock: ReturnType<typeof vi.fn>

// A blob past the reap grace window — a first sweep already stamped it this long ago, so
// the current sweep is free to actually delete it. Blobs seeded without an orphaned_at
// are "not yet observed as an orphan" and only get MARKED this round, never reaped.
const PAST_GRACE = () => Date.now() - REAP_GRACE_MS - 1000

const enqueue = (
  hash: string,
  kind: 'content' | 'cover',
  state = 'synced',
  orphanedAt: number | null = null,
) =>
  db
    .prepare(
      `INSERT INTO blob_sync (content_hash, kind, state, orphaned_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(hash, kind, state, orphanedAt, 0)

const orphanedAtOf = (hash: string) =>
  (
    db.prepare(`SELECT orphaned_at FROM blob_sync WHERE content_hash = ?`).get(hash) as
      { orphaned_at: number | null } | undefined
  )?.orphaned_at ?? null

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
    enqueue('H', 'content', 'synced', PAST_GRACE()) // already observed as an orphan long enough ago

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
    enqueue('C', 'cover', 'synced', PAST_GRACE())

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
    enqueue('H', 'content', 'synced', PAST_GRACE())
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as unknown as Response)

    await expect(reapOrphanBlobs()).resolves.toBeUndefined()
    expect(ledgerCount()).toBe(1) // kept for the next sweep
  })

  it('swallows a thrown fetch (offline) and keeps the row', async () => {
    const id = seedItem(db, { deleted_at: 1000 })
    setBlob(id, { blob_hash: 'H', purged_at: 2000 })
    enqueue('H', 'content', 'synced', PAST_GRACE())
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

  // ── mark-and-sweep grace window (H1) ───────────────────────────────────────
  it('MARKS a freshly-orphaned blob instead of deleting it (first observation)', async () => {
    const id = seedItem(db, { deleted_at: 1000 })
    setBlob(id, { blob_hash: 'H', purged_at: 2000 })
    enqueue('H', 'content') // orphaned_at NULL → never seen as an orphan before

    await reapOrphanBlobs()

    // No network work this round — just stamp the clock and keep the bytes.
    expect(h.presignBlobUrl).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ledgerCount()).toBe(1)
    expect(orphanedAtOf('H')).toBeTypeOf('number') // now marked
  })

  it('does NOT reap an orphan still inside the grace window', async () => {
    const id = seedItem(db, { deleted_at: 1000 })
    setBlob(id, { blob_hash: 'H', purged_at: 2000 })
    enqueue('H', 'content', 'synced', Date.now()) // marked just now → not stable yet

    await reapOrphanBlobs()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ledgerCount()).toBe(1)
  })

  it('CLEARS the mark when the blob is referenced again (restore/re-import cancels the reap)', async () => {
    // Marked as an orphan past the grace window, but an un-purged item now references it
    // again — a cross-device restore/re-import propagated in. The reap must be cancelled.
    const id = seedItem(db)
    setBlob(id, { blob_hash: 'H', purged_at: null }) // live reference
    enqueue('H', 'content', 'synced', PAST_GRACE())

    await reapOrphanBlobs()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ledgerCount()).toBe(1)
    expect(orphanedAtOf('H')).toBeNull() // stamp cleared → no longer a reap candidate
  })
})

describe('reapPurgedLocalFiles', () => {
  // Real files under a per-test mkdtemp userData/content (the shared stub path is
  // rm'd by sibling suites → order-dependent flakes; a scoped getPath spy isolates us).
  let userData: string
  let getPathSpy: MockInstance

  const contentPath = (name: string) => join(userData, 'content', name)
  const reclaimed = (id: string) =>
    (
      db.prepare(`SELECT files_reclaimed FROM items WHERE id = ?`).get(id) as {
        files_reclaimed: number
      }
    ).files_reclaimed
  /** Seed a purged item with real content (+ optional cover) files on disk. */
  const seedPurged = (
    id: string,
    opts: {
      file?: string
      cover?: string
      purged_at?: number | null
      files_reclaimed?: number
    } = {},
  ) => {
    const file = opts.file ?? `${id}.epub`
    seedItem(db, { id, file_path: file, cover_path: opts.cover ?? null, deleted_at: 1000 })
    db.prepare(`UPDATE items SET purged_at = ?, files_reclaimed = ? WHERE id = ?`).run(
      opts.purged_at === undefined ? 2000 : opts.purged_at,
      opts.files_reclaimed ?? 0,
      id,
    )
    writeFileSync(contentPath(file), 'bytes')
    if (opts.cover) writeFileSync(contentPath(opts.cover.replace(/^content\//, '')), 'cover')
    return file
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'pl-reaper-'))
    mkdirSync(join(userData, 'content'), { recursive: true })
    getPathSpy = vi
      .spyOn(app, 'getPath')
      .mockImplementation((name: string) =>
        name === 'userData' ? userData : join('/tmp', `pl-${name}`),
      )
  })
  afterEach(() => {
    getPathSpy.mockRestore()
    rmSync(userData, { recursive: true, force: true })
  })

  it('unlinks content + cover of a purged item and marks it reclaimed', async () => {
    const file = seedPurged('a', { cover: 'content/a.jpg' })

    await reapPurgedLocalFiles()

    expect(existsSync(contentPath(file))).toBe(false)
    expect(existsSync(contentPath('a.jpg'))).toBe(false)
    expect(reclaimed('a')).toBe(1)
  })

  it('leaves a LIVE item (purged_at NULL) — files and flag untouched', async () => {
    const file = seedPurged('a', { purged_at: null })

    await reapPurgedLocalFiles()

    expect(existsSync(contentPath(file))).toBe(true)
    expect(reclaimed('a')).toBe(0)
  })

  it('skips an already-reclaimed row (bounded to one pass)', async () => {
    // Marked reclaimed but a file still (impossibly) present — proves the WHERE guard
    // skips it rather than re-unlinking every round.
    const file = seedPurged('a', { files_reclaimed: 1 })

    await reapPurgedLocalFiles()

    expect(existsSync(contentPath(file))).toBe(true) // not touched
  })

  it('treats an already-gone file as reclaimed (ENOENT is success)', async () => {
    const file = seedPurged('a')
    rmSync(contentPath(file)) // purging device already unlinked inline

    await reapPurgedLocalFiles()

    expect(reclaimed('a')).toBe(1)
  })

  it('handles a purged item with no cover (null cover_path)', async () => {
    seedPurged('a') // no cover

    await reapPurgedLocalFiles()

    expect(reclaimed('a')).toBe(1)
  })

  it('leaves the row unreclaimed when a real unlink error occurs (retry next sweep)', async () => {
    const file = seedPurged('a')
    // Make the content dir read-only so unlink fails with EPERM/EACCES (not ENOENT).
    const dir = join(userData, 'content')
    chmodSync(dir, 0o500)
    try {
      await reapPurgedLocalFiles()
      // On permissive CI (e.g. root) chmod may not block unlink; only assert the
      // retry-safety invariant when the file genuinely survived.
      if (existsSync(contentPath(file))) expect(reclaimed('a')).toBe(0)
    } finally {
      chmodSync(dir, 0o700) // restore so afterEach rmSync can clean up
    }
  })
})
