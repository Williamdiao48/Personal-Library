import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../../test/stubs/electron'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'
import { packArchive } from './blobArchive'
import { sha256Hex } from './blobHash'
import { okBytes } from '../../../test/stubs/httpResponse'

// Real archive/hash; mock only the auth + presign seams and the network.
const h = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  getSession: vi.fn(async () => ({ data: { session: { access_token: 't' } } })),
  presignBlobUrl: vi.fn(async () => 'https://r2.example/get-url'),
}))
vi.mock('../auth/client', () => ({
  isConfigured: h.isConfigured,
  getSupabase: () => ({ auth: { getSession: h.getSession } }),
}))
vi.mock('./presign', () => ({ presignBlobUrl: h.presignBlobUrl }))

import { ensureLocalContent, ensureLocalCover } from './downloader'

let db: TestDb
let userData: string
let contentPath: string
let getPathSpy: MockInstance
let fetchMock: ReturnType<typeof vi.fn>

const entry = (name: string, s: string) => ({ name, data: Buffer.from(s, 'utf8') })
/** Seed a cloud-backed item whose bytes are `archive` (sets file_path + blob_hash). */
const seedBacked = (fileP: string, archive: Buffer): string => {
  const id = seedItem(db, { file_path: fileP })
  db.prepare(`UPDATE items SET blob_hash = ? WHERE id = ?`).run(sha256Hex(archive), id)
  return id
}

beforeEach(() => {
  db = openTestDb()
  userData = mkdtempSync(join(tmpdir(), 'pl-dl-'))
  contentPath = join(userData, 'content')
  mkdirSync(contentPath, { recursive: true })
  getPathSpy = vi
    .spyOn(app, 'getPath')
    .mockImplementation((name: string) =>
      name === 'userData' ? userData : join('/tmp', `pl-test-${name}`),
    )
  vi.clearAllMocks()
  h.isConfigured.mockReturnValue(true)
  h.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  closeTestDb()
  getPathSpy.mockRestore()
  vi.unstubAllGlobals()
  rmSync(userData, { recursive: true, force: true })
})

describe('ensureLocalContent — fast path & no-ops', () => {
  it('does nothing when the file is already local', async () => {
    writeFileSync(join(contentPath, 'a.html'), 'local')
    await ensureLocalContent('a.html')
    expect(h.presignBlobUrl).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does nothing for a missing but non-cloud-backed item (no blob_hash)', async () => {
    seedItem(db, { file_path: 'a.html' }) // blob_hash stays NULL
    await ensureLocalContent('a.html')
    expect(h.presignBlobUrl).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a path-traversal relativePath before any DB/network work', async () => {
    await expect(ensureLocalContent('../../../etc/passwd')).rejects.toThrow(/content path/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('ensureLocalContent — pull', () => {
  it('downloads, verifies, and unpacks every file of a multi-chapter item', async () => {
    // Content files are `<id>`-prefixed at capture time; the pull binds entry names
    // to the item's id, so the archive must use the seeded item's real id.
    const id = seedItem(db, { file_path: 'placeholder' })
    const archive = packArchive([entry(`${id}-ch0.html`, 'zero'), entry(`${id}-ch1.html`, 'one')])
    db.prepare(`UPDATE items SET file_path = ?, blob_hash = ? WHERE id = ?`).run(
      `${id}-ch0.html`,
      sha256Hex(archive),
      id,
    )
    fetchMock.mockResolvedValue(okBytes(archive))

    await ensureLocalContent(`${id}-ch0.html`)

    expect(h.presignBlobUrl).toHaveBeenCalledWith('get', 'content', sha256Hex(archive))
    expect(readFileSync(join(contentPath, `${id}-ch0.html`), 'utf8')).toBe('zero')
    expect(readFileSync(join(contentPath, `${id}-ch1.html`), 'utf8')).toBe('one')
  })

  it('restores a single-file item (1-entry archive)', async () => {
    const archive = packArchive([entry('a.epub', 'EPUBBYTES')])
    seedBacked('a.epub', archive)
    fetchMock.mockResolvedValue(okBytes(archive))

    await ensureLocalContent('a.epub')
    expect(readFileSync(join(contentPath, 'a.epub'), 'utf8')).toBe('EPUBBYTES')
  })

  it('throws a sign-in prompt when the item is cloud-backed but signed out', async () => {
    seedBacked('a.epub', packArchive([entry('a.epub', 'x')]))
    h.getSession.mockResolvedValue({ data: { session: null } } as never)
    await expect(ensureLocalContent('a.epub')).rejects.toThrow(/sign in/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects bytes that fail the content-hash integrity check', async () => {
    const archive = packArchive([entry('a.epub', 'REAL')])
    seedBacked('a.epub', archive) // blob_hash = hash of REAL archive
    fetchMock.mockResolvedValue(okBytes(packArchive([entry('a.epub', 'TAMPERED')])))
    await expect(ensureLocalContent('a.epub')).rejects.toThrow(/integrity/i)
    expect(existsSync(join(contentPath, 'a.epub'))).toBe(false)
  })

  it('surfaces a retriable error on a failed GET', async () => {
    seedBacked('a.epub', packArchive([entry('a.epub', 'x')]))
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Response)
    await expect(ensureLocalContent('a.epub')).rejects.toThrow(/download this book/i)
  })

  it('surfaces a connection error when fetch itself throws (offline)', async () => {
    seedBacked('a.epub', packArchive([entry('a.epub', 'x')]))
    fetchMock.mockRejectedValue(new Error('ENOTFOUND'))
    await expect(ensureLocalContent('a.epub')).rejects.toThrow(/check your connection/i)
  })

  it('refuses to write an archive entry that escapes the content dir', async () => {
    // A tampered blob whose hash still matches: the name-binding guard catches the
    // traversal entry (it isn't one of the item's own `<id>`-prefixed files) before
    // any write, ahead of the safeContentPath defence-in-depth on the write itself.
    const evil = packArchive([entry('../evil.html', 'pwned')])
    seedBacked('a.epub', evil)
    fetchMock.mockResolvedValue(okBytes(evil))
    await expect(ensureLocalContent('a.epub')).rejects.toThrow(/unexpected file/i)
    expect(existsSync(join(userData, 'evil.html'))).toBe(false)
  })

  // SEC-1: the integrity check proves bytes↔hash, but a rogue device on the same
  // account (shared R2 prefix) could name a valid-hashing archive's entries after
  // ANOTHER of the victim's items to overwrite it. Names must bind to THIS item.
  it('rejects an archive naming a different item, writing nothing', async () => {
    const victimId = seedItem(db, { file_path: 'victim.epub' })
    writeFileSync(join(contentPath, 'victim.epub'), 'ORIGINAL')
    // Attacker's item + blob: hashes correctly, but its entry targets victim.epub.
    const evil = packArchive([entry('victim.epub', 'PWNED')])
    seedBacked('attacker.epub', evil)
    fetchMock.mockResolvedValue(okBytes(evil))

    await expect(ensureLocalContent('attacker.epub')).rejects.toThrow(/unexpected file/i)
    // The victim's real file is untouched, and no attacker file was written.
    expect(readFileSync(join(contentPath, 'victim.epub'), 'utf8')).toBe('ORIGINAL')
    expect(existsSync(join(contentPath, 'attacker.epub'))).toBe(false)
    expect(victimId).toBeTruthy()
  })

  it('rejects a multi-entry archive if ANY entry is not bound to the item (no partial write)', async () => {
    const id = seedItem(db, { file_path: 'placeholder' })
    // First entry is legit for this item; second is a foreign name.
    const evil = packArchive([
      entry(`${id}-ch0.html`, 'ok'),
      entry('other-item-ch0.html', 'sneaky'),
    ])
    db.prepare(`UPDATE items SET file_path = ?, blob_hash = ? WHERE id = ?`).run(
      `${id}-ch0.html`,
      sha256Hex(evil),
      id,
    )
    fetchMock.mockResolvedValue(okBytes(evil))

    await expect(ensureLocalContent(`${id}-ch0.html`)).rejects.toThrow(/unexpected file/i)
    // Fail-closed: the legit first entry must NOT have been written either.
    expect(existsSync(join(contentPath, `${id}-ch0.html`))).toBe(false)
  })

  // SEC-2: a tampered/oversized blob in the shared prefix must not exhaust memory.
  it('rejects a download whose Content-Length exceeds the size cap', async () => {
    const archive = packArchive([entry('a.epub', 'x')])
    seedBacked('a.epub', archive)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n === 'content-length' ? String(400 * 1024 * 1024) : null) },
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response)

    await expect(ensureLocalContent('a.epub')).rejects.toThrow(/too large/i)
    expect(existsSync(join(contentPath, 'a.epub'))).toBe(false)
  })

  // Regression: a device that received this item purely via metadata sync never
  // captured/imported locally, so <userData>/content does not exist. The pull must
  // create it before writing — otherwise writeFileSync throws a parent-missing
  // ENOENT byte-identical to the reader's own missing-file error (the original bug).
  it('creates the content dir when it does not exist yet (metadata-only device)', async () => {
    const archive = packArchive([entry('a.epub', 'EPUBBYTES')])
    seedBacked('a.epub', archive)
    fetchMock.mockResolvedValue(okBytes(archive))
    rmSync(contentPath, { recursive: true, force: true }) // device never created content/
    expect(existsSync(contentPath)).toBe(false)

    await ensureLocalContent('a.epub')

    expect(readFileSync(join(contentPath, 'a.epub'), 'utf8')).toBe('EPUBBYTES')
  })
})

describe('ensureLocalCover', () => {
  /** Seed an item with a cloud-backed cover (sets cover_path + cover_hash). */
  const seedCover = (coverRel: string, bytes: Buffer): string => {
    const id = seedItem(db, {})
    db.prepare(`UPDATE items SET cover_path = ?, cover_hash = ? WHERE id = ?`).run(
      coverRel,
      sha256Hex(bytes),
      id,
    )
    return id
  }

  it('does nothing when the cover is already local', async () => {
    writeFileSync(join(contentPath, 'c-cover.jpg'), 'local')
    await ensureLocalCover('content/c-cover.jpg')
    expect(h.presignBlobUrl).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does nothing for an item with no backed-up cover (no cover_hash)', async () => {
    const id = seedItem(db, {})
    db.prepare(`UPDATE items SET cover_path = ? WHERE id = ?`).run('content/c-cover.jpg', id)
    await ensureLocalCover('content/c-cover.jpg')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('downloads, verifies, and writes the cover, creating content/ if absent', async () => {
    const bytes = Buffer.from('JPEGBYTES', 'utf8')
    seedCover('content/c-cover.jpg', bytes)
    fetchMock.mockResolvedValue(okBytes(bytes))
    rmSync(contentPath, { recursive: true, force: true }) // metadata-only device
    expect(existsSync(contentPath)).toBe(false)

    await ensureLocalCover('content/c-cover.jpg')

    expect(h.presignBlobUrl).toHaveBeenCalledWith('get', 'cover', sha256Hex(bytes))
    expect(readFileSync(join(contentPath, 'c-cover.jpg'), 'utf8')).toBe('JPEGBYTES')
  })

  it('never throws and writes nothing when signed out (covers are non-critical)', async () => {
    const bytes = Buffer.from('JPEGBYTES', 'utf8')
    seedCover('content/c-cover.jpg', bytes)
    h.getSession.mockResolvedValue({ data: { session: null } } as never)

    await expect(ensureLocalCover('content/c-cover.jpg')).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(existsSync(join(contentPath, 'c-cover.jpg'))).toBe(false)
  })

  it('drops bytes that fail the cover-hash integrity check (no write, no throw)', async () => {
    seedCover('content/c-cover.jpg', Buffer.from('REAL', 'utf8'))
    fetchMock.mockResolvedValue(okBytes(Buffer.from('TAMPERED', 'utf8')))

    await expect(ensureLocalCover('content/c-cover.jpg')).resolves.toBeUndefined()
    expect(existsSync(join(contentPath, 'c-cover.jpg'))).toBe(false)
  })

  it('swallows a failed GET without throwing', async () => {
    seedCover('content/c-cover.jpg', Buffer.from('x', 'utf8'))
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Response)
    await expect(ensureLocalCover('content/c-cover.jpg')).resolves.toBeUndefined()
    expect(existsSync(join(contentPath, 'c-cover.jpg'))).toBe(false)
  })

  it('returns quietly on a traversal path without touching the DB or network', async () => {
    await expect(ensureLocalCover('content/../../../etc/passwd')).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// CLO-14: a local file existing isn't enough — it must be the version the synced
// pointer names. `local_blob_hash` records which hash the on-disk bytes came from.
describe('ensureLocalContent — freshness (CLO-14)', () => {
  const marker = (id: string) =>
    (
      db.prepare('SELECT local_blob_hash FROM items WHERE id = ?').get(id) as {
        local_blob_hash: string | null
      }
    ).local_blob_hash

  /** A serial whose local copy is `local` chapters at hash `old`, and whose synced
   *  pointer now names `archive`. */
  const seedStale = (local: string[], remote: string[]) => {
    const id = seedItem(db, { file_path: 'placeholder' })
    const file_path = `${id}-ch0.html`
    local.forEach((s, i) => writeFileSync(join(contentPath, `${id}-ch${i}.html`), s))
    const archive = packArchive(remote.map((s, i) => entry(`${id}-ch${i}.html`, s)))
    db.prepare(
      `UPDATE items SET file_path = ?, blob_hash = ?, local_blob_hash = 'old' WHERE id = ?`,
    ).run(file_path, sha256Hex(archive), id)
    return { id, file_path, archive }
  }
  const chapters = (id: string) =>
    [0, 1, 2, 3, 4]
      .map((n) => join(contentPath, `${id}-ch${n}.html`))
      .filter(existsSync)
      .map((p) => readFileSync(p, 'utf8'))

  it('fast path: local copy at the current hash → no network', async () => {
    const archive = packArchive([entry('a.epub', 'X')])
    const id = seedBacked('a.epub', archive)
    db.prepare('UPDATE items SET local_blob_hash = blob_hash WHERE id = ?').run(id)
    writeFileSync(join(contentPath, 'a.epub'), 'X')

    await ensureLocalContent('a.epub')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('adopts a local copy with no marker (pre-tracking / dedup adoption) without downloading', async () => {
    const archive = packArchive([entry('a.epub', 'X')])
    const id = seedBacked('a.epub', archive) // local_blob_hash NULL
    writeFileSync(join(contentPath, 'a.epub'), 'X')

    await ensureLocalContent('a.epub')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(marker(id)).toBe(sha256Hex(archive))
  })

  it('a first download records the marker', async () => {
    const archive = packArchive([entry('a.epub', 'X')])
    const id = seedBacked('a.epub', archive)
    fetchMock.mockResolvedValue(okBytes(archive))

    await ensureLocalContent('a.epub')
    expect(marker(id)).toBe(sha256Hex(archive))
  })

  it('refreshes a stale local copy to the newer version and records its hash', async () => {
    const { id, file_path, archive } = seedStale(['zero', 'one'], ['zero', 'one', 'two'])
    fetchMock.mockResolvedValue(okBytes(archive))

    await ensureLocalContent(file_path)
    expect(h.presignBlobUrl).toHaveBeenCalledWith('get', 'content', sha256Hex(archive))
    expect(chapters(id)).toEqual(['zero', 'one', 'two'])
    expect(marker(id)).toBe(sha256Hex(archive))
  })

  it('removes chapter files the newer version no longer has (re-scrape shrink)', async () => {
    const { id, file_path, archive } = seedStale(['a', 'b', 'c', 'd'], ['A', 'B'])
    fetchMock.mockResolvedValue(okBytes(archive))

    await ensureLocalContent(file_path)
    expect(chapters(id)).toEqual(['A', 'B'])
  })

  it.each([
    ['offline', () => fetchMock.mockRejectedValue(new Error('offline'))],
    [
      'not uploaded yet (404)',
      () => fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Response),
    ],
    ['integrity mismatch', () => fetchMock.mockResolvedValue(okBytes(Buffer.from('nope')))],
    ['signed out', () => h.getSession.mockResolvedValue({ data: { session: null } } as never)],
  ])(
    'a failed refresh (%s) keeps the local copy, keeps the marker, and does not throw',
    async (_, fail) => {
      const { id, file_path } = seedStale(['zero', 'one'], ['zero', 'one', 'two'])
      fail()

      await expect(ensureLocalContent(file_path)).resolves.toBeUndefined()
      expect(chapters(id)).toEqual(['zero', 'one'])
      expect(marker(id)).toBe('old') // still stale → the next open retries
    },
  )

  it('a first download still throws when it fails (nothing local to fall back to)', async () => {
    seedBacked('a.epub', packArchive([entry('a.epub', 'X')]))
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Response)
    await expect(ensureLocalContent('a.epub')).rejects.toThrow(/R2 404/)
  })

  it('concurrent opens share one download', async () => {
    const { id, file_path, archive } = seedStale(['zero'], ['zero', 'one'])
    fetchMock.mockResolvedValue(okBytes(archive))

    await Promise.all([ensureLocalContent(file_path), ensureLocalContent(file_path)])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(chapters(id)).toEqual(['zero', 'one'])
  })

  it('refreshes a single-file item (EPUB) in place', async () => {
    const id = seedItem(db, { file_path: 'b.epub' })
    writeFileSync(join(contentPath, 'b.epub'), 'OLD')
    const archive = packArchive([entry('b.epub', 'NEW')])
    db.prepare(`UPDATE items SET blob_hash = ?, local_blob_hash = 'old' WHERE id = ?`).run(
      sha256Hex(archive),
      id,
    )
    fetchMock.mockResolvedValue(okBytes(archive))

    await ensureLocalContent('b.epub')
    expect(readFileSync(join(contentPath, 'b.epub'), 'utf8')).toBe('NEW')
    expect(marker(id)).toBe(sha256Hex(archive))
  })

  // SEC-1 must hold on the refresh path too: a rogue archive is rejected before
  // ANY write, so neither this item's copy nor another item's files change.
  it('a refresh whose archive names another item writes nothing and keeps the local copy', async () => {
    writeFileSync(join(contentPath, 'victim.epub'), 'ORIGINAL')
    seedItem(db, { file_path: 'victim.epub' })
    const { id, file_path } = seedStale(['zero'], ['zero'])
    const evil = packArchive([entry(`${id}-ch0.html`, 'X'), entry('victim.epub', 'PWNED')])
    db.prepare('UPDATE items SET blob_hash = ? WHERE id = ?').run(sha256Hex(evil), id)
    fetchMock.mockResolvedValue(okBytes(evil))

    await ensureLocalContent(file_path) // reader: falls back, no throw
    expect(readFileSync(join(contentPath, 'victim.epub'), 'utf8')).toBe('ORIGINAL')
    expect(chapters(id)).toEqual(['zero'])
    expect(marker(id)).toBe('old')
  })

  it("the shrink cleanup never touches another item's chapter files", async () => {
    const other = seedItem(db, { file_path: 'placeholder' })
    writeFileSync(join(contentPath, `${other}-ch0.html`), 'theirs-0')
    writeFileSync(join(contentPath, `${other}-ch1.html`), 'theirs-1')
    const { file_path, archive } = seedStale(['a', 'b', 'c'], ['A'])
    fetchMock.mockResolvedValue(okBytes(archive))

    await ensureLocalContent(file_path)
    expect(chapters(other)).toEqual(['theirs-0', 'theirs-1'])
  })

  it('a non-cloud item with a local file is left alone: no network, no marker', async () => {
    const id = seedItem(db, { file_path: 'local-ch0.html' }) // blob_hash NULL
    writeFileSync(join(contentPath, 'local-ch0.html'), 'mine')

    await ensureLocalContent('local-ch0.html', { requireCurrent: true })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(marker(id)).toBeNull()
  })
})

// A copy that's older than the synced pointer is fine to READ, not to WRITE on
// (appending chapters numbers them after the stale files). Writers ask for
// requireCurrent and must get an error instead of the fallback.
describe('ensureLocalContent — requireCurrent (for writers)', () => {
  const staleSerial = (local: string[], remote: string[]) => {
    const id = seedItem(db, { file_path: 'placeholder' })
    const file_path = `${id}-ch0.html`
    local.forEach((s, i) => writeFileSync(join(contentPath, `${id}-ch${i}.html`), s))
    const archive = packArchive(remote.map((s, i) => entry(`${id}-ch${i}.html`, s)))
    db.prepare(
      `UPDATE items SET file_path = ?, blob_hash = ?, local_blob_hash = 'old' WHERE id = ?`,
    ).run(file_path, sha256Hex(archive), id)
    return { id, file_path, archive }
  }

  it('throws when the refresh fails, leaving the local copy untouched', async () => {
    const { id, file_path } = staleSerial(['zero'], ['zero', 'one'])
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Response)

    await expect(ensureLocalContent(file_path, { requireCurrent: true })).rejects.toThrow(
      /updated on another device/,
    )
    expect(readFileSync(join(contentPath, `${id}-ch0.html`), 'utf8')).toBe('zero')
    expect(existsSync(join(contentPath, `${id}-ch1.html`))).toBe(false)
  })

  it("still throws when it joined a reader's in-flight refresh that failed", async () => {
    const { file_path } = staleSerial(['zero'], ['zero', 'one'])
    fetchMock.mockRejectedValue(new Error('offline'))

    const [reader, writer] = await Promise.allSettled([
      ensureLocalContent(file_path),
      ensureLocalContent(file_path, { requireCurrent: true }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1) // they shared one attempt
    expect(reader.status).toBe('fulfilled')
    expect(writer.status).toBe('rejected')
  })

  it('succeeds once the refresh succeeds', async () => {
    const { file_path, archive } = staleSerial(['zero'], ['zero', 'one'])
    fetchMock.mockResolvedValue(okBytes(archive))
    await expect(ensureLocalContent(file_path, { requireCurrent: true })).resolves.toBeUndefined()
  })

  it('does not block a current or unmarked local copy', async () => {
    const archive = packArchive([entry('a.epub', 'X')])
    const id = seedBacked('a.epub', archive)
    writeFileSync(join(contentPath, 'a.epub'), 'X')

    await ensureLocalContent('a.epub', { requireCurrent: true }) // unmarked → adopt
    await ensureLocalContent('a.epub', { requireCurrent: true }) // now current
    expect(fetchMock).not.toHaveBeenCalled()
    expect(id).toBeTruthy()
  })
})

describe('ensureLocalCover — freshness (CLO-14)', () => {
  const seedStaleCover = (local: string, remote: Buffer) => {
    const id = seedItem(db, {})
    writeFileSync(join(contentPath, 'c-cover.jpg'), local)
    db.prepare(
      `UPDATE items SET cover_path = 'content/c-cover.jpg', cover_hash = ?,
         local_cover_hash = 'old' WHERE id = ?`,
    ).run(sha256Hex(remote), id)
    return id
  }
  const coverMarker = (id: string) =>
    (
      db.prepare('SELECT local_cover_hash FROM items WHERE id = ?').get(id) as {
        local_cover_hash: string | null
      }
    ).local_cover_hash

  it('replaces a stale cover with the current one and records its hash', async () => {
    const remote = Buffer.from('NEW')
    const id = seedStaleCover('OLD', remote)
    fetchMock.mockResolvedValue(okBytes(remote))

    await ensureLocalCover('content/c-cover.jpg')
    expect(readFileSync(join(contentPath, 'c-cover.jpg'), 'utf8')).toBe('NEW')
    expect(coverMarker(id)).toBe(sha256Hex(remote))
  })

  it('keeps the old cover when the refresh fails', async () => {
    const id = seedStaleCover('OLD', Buffer.from('NEW'))
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Response)

    await ensureLocalCover('content/c-cover.jpg')
    expect(readFileSync(join(contentPath, 'c-cover.jpg'), 'utf8')).toBe('OLD')
    expect(coverMarker(id)).toBe('old')
  })

  it('adopts an unmarked local cover without downloading', async () => {
    const remote = Buffer.from('X')
    const id = seedStaleCover('X', remote)
    db.prepare('UPDATE items SET local_cover_hash = NULL WHERE id = ?').run(id)

    await ensureLocalCover('content/c-cover.jpg')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(coverMarker(id)).toBe(sha256Hex(remote))
  })
})
