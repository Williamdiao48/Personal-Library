import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

import { ensureLocalContent } from './downloader'

let db: TestDb
let userData: string
let contentPath: string
let getPathSpy: ReturnType<typeof vi.spyOn>
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
    const archive = packArchive([entry('bk-ch0.html', 'zero'), entry('bk-ch1.html', 'one')])
    seedBacked('bk-ch0.html', archive)
    fetchMock.mockResolvedValue(okBytes(archive))

    await ensureLocalContent('bk-ch0.html')

    expect(h.presignBlobUrl).toHaveBeenCalledWith('get', 'content', sha256Hex(archive))
    expect(readFileSync(join(contentPath, 'bk-ch0.html'), 'utf8')).toBe('zero')
    expect(readFileSync(join(contentPath, 'bk-ch1.html'), 'utf8')).toBe('one')
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
    // A tampered blob whose hash still matches: the traversal guard must catch it.
    const evil = packArchive([entry('../evil.html', 'pwned')])
    seedBacked('a.epub', evil)
    fetchMock.mockResolvedValue(okBytes(evil))
    await expect(ensureLocalContent('a.epub')).rejects.toThrow(/content path/i)
    expect(existsSync(join(userData, 'evil.html'))).toBe(false)
  })
})
