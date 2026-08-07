import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { app } from 'electron'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeFileHash, backfillFileHashes } from './fileHash'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'

// DB suite → needs the node ABI for better-sqlite3 (`npm run rebuild:node`).
// Each test gets its OWN mkdtemp userData via a scoped app.getPath spy so the
// backfill's disk reads never collide with the shared /tmp/pl-test-userdata used
// by sibling suites (the known shared-content-dir race).

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'pl-filehash-'))
  mkdirSync(join(userData, 'content'), { recursive: true })
  const real = app.getPath.bind(app)
  vi.spyOn(app, 'getPath').mockImplementation((name: Parameters<typeof app.getPath>[0]) =>
    name === 'userData' ? userData : real(name),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  closeTestDb()
  rmSync(userData, { recursive: true, force: true })
})

function writeContent(name: string, bytes: string): void {
  writeFileSync(join(userData, 'content', name), bytes)
}

describe('computeFileHash', () => {
  it('is a stable 64-hex sha256 of the bytes', () => {
    const h = computeFileHash(Buffer.from('hello'))
    expect(h).toBe(computeFileHash(Buffer.from('hello')))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(computeFileHash(Buffer.from('world'))).not.toBe(h)
  })
})

describe('backfillFileHashes', () => {
  it('fills file_hash for epub/pdf items that lack one', () => {
    const db: TestDb = openTestDb()
    const e = seedItem(db, { content_type: 'epub', file_path: 'a.epub' })
    const p = seedItem(db, { content_type: 'pdf', file_path: 'b.pdf' })
    writeContent('a.epub', 'PK epub bytes')
    writeContent('b.pdf', '%PDF pdf bytes')

    expect(backfillFileHashes(db)).toBe(2)

    const er = db.prepare('SELECT file_hash FROM items WHERE id=?').get(e) as { file_hash: string }
    const pr = db.prepare('SELECT file_hash FROM items WHERE id=?').get(p) as { file_hash: string }
    expect(er.file_hash).toBe(computeFileHash(Buffer.from('PK epub bytes')))
    expect(pr.file_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(pr.file_hash).not.toBe(er.file_hash)
  })

  it('skips html items and already-hashed rows', () => {
    const db = openTestDb()
    const html = seedItem(db, { content_type: 'article', file_path: 'x.html' })
    writeContent('x.html', '<p>hi</p>')
    const epub = seedItem(db, { content_type: 'epub', file_path: 'done.epub' })
    writeContent('done.epub', 'PK bytes')
    db.prepare('UPDATE items SET file_hash = ? WHERE id = ?').run('deadbeef', epub)

    expect(backfillFileHashes(db)).toBe(0)
    const hr = db.prepare('SELECT file_hash FROM items WHERE id=?').get(html) as {
      file_hash: string | null
    }
    expect(hr.file_hash).toBeNull() // html isn't deduped in v1
    const ur = db.prepare('SELECT file_hash FROM items WHERE id=?').get(epub) as {
      file_hash: string
    }
    expect(ur.file_hash).toBe('deadbeef') // pre-hashed row untouched
  })

  it('leaves an item NULL (without throwing) when its file is missing', () => {
    const db = openTestDb()
    const missing = seedItem(db, { content_type: 'epub', file_path: 'gone.epub' }) // no file
    const present = seedItem(db, { content_type: 'pdf', file_path: 'here.pdf' })
    writeContent('here.pdf', '%PDF here')

    expect(backfillFileHashes(db)).toBe(1)
    const mr = db.prepare('SELECT file_hash FROM items WHERE id=?').get(missing) as {
      file_hash: string | null
    }
    expect(mr.file_hash).toBeNull()
    const pr = db.prepare('SELECT file_hash FROM items WHERE id=?').get(present) as {
      file_hash: string | null
    }
    expect(pr.file_hash).not.toBeNull()
  })

  it('is idempotent — a second run fills nothing new', () => {
    const db = openTestDb()
    seedItem(db, { content_type: 'epub', file_path: 'z.epub' })
    writeContent('z.epub', 'PK z')
    expect(backfillFileHashes(db)).toBe(1)
    expect(backfillFileHashes(db)).toBe(0)
  })

  it('marks each filled row dirty so the hash pushes on the next sync (cross-device dedup)', () => {
    const db = openTestDb()
    const e = seedItem(db, { content_type: 'epub', file_path: 'sync.epub' })
    writeContent('sync.epub', 'PK sync bytes')
    // Simulate a pre-existing, already-synced (clean) row that predates the column.
    db.prepare('UPDATE items SET dirty = 0 WHERE id = ?').run(e)

    expect(backfillFileHashes(db)).toBe(1)

    const row = db.prepare('SELECT dirty, file_hash FROM items WHERE id = ?').get(e) as {
      dirty: number
      file_hash: string | null
    }
    expect(row.file_hash).not.toBeNull()
    expect(row.dirty).toBe(1) // re-dirtied so Phase-3 sync carries file_hash to other devices
  })
})
