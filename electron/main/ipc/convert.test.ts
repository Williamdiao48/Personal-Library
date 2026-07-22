import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { invoke, resetIpc, app } from '../../../test/stubs/electron'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'
import { registerConvertHandlers } from './convert'
import type { ConvertResult } from '../../../src/types'

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>()
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) }
})

vi.mock('epub-gen-memory', () => ({
  default: vi.fn().mockResolvedValue(Buffer.from('fake epub bytes')),
}))

let db: TestDb
let userData: string
let getPathSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetIpc()
  db = openTestDb()
  // Isolate this suite's content dir. The main project runs test files in
  // parallel, and every suite shares the stub's fixed userData path — so a
  // sibling suite rmSync-ing /tmp/pl-test-userdata/content mid-write would
  // intermittently break the epub write here (a real, order-dependent flake).
  // A per-test mkdtemp userData dir removes the shared-path race entirely.
  userData = mkdtempSync(join(tmpdir(), 'pl-convert-'))
  getPathSpy = vi
    .spyOn(app, 'getPath')
    .mockImplementation((name: string) =>
      name === 'userData' ? userData : join('/tmp', `pl-test-${name}`),
    )
  registerConvertHandlers()
})
afterEach(() => {
  closeTestDb()
  // Restore ONLY this spy — a blanket vi.restoreAllMocks() would also wipe the
  // module-level crypto.randomUUID mock that later tests depend on.
  getPathSpy.mockRestore()
  rmSync(userData, { recursive: true, force: true })
})

describe('convert:pdfToEpub', () => {
  it('throws when the source item does not exist', async () => {
    await expect(invoke('convert:pdfToEpub', { itemId: 'missing', chapters: [] })).rejects.toThrow(
      'Item not found.',
    )
  })

  it('throws when the source item is not a PDF', async () => {
    const id = seedItem(db, { content_type: 'article' })
    await expect(invoke('convert:pdfToEpub', { itemId: id, chapters: [] })).rejects.toThrow(
      'Item is not a PDF.',
    )
  })

  it('writes the epub file, inserts an items row, and indexes it for FTS', async () => {
    const id = seedItem(db, { content_type: 'pdf', title: 'My Book', author: 'Jane Doe' })
    const result = (await invoke('convert:pdfToEpub', {
      itemId: id,
      chapters: [{ title: 'Ch 1', content: '<p>Hello world chapter one</p>' }],
    })) as ConvertResult

    expect(result.title).toBe('My Book')
    expect(existsSync(join(userData, 'content', `${result.id}.epub`))).toBe(true)

    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(result.id) as any
    expect(row).toMatchObject({
      title: 'My Book',
      author: 'Jane Doe',
      content_type: 'epub',
      derived_from: id,
      word_count: 4,
    })

    const hits = db.prepare('SELECT rowid FROM items_fts WHERE items_fts MATCH ?').all('hello')
    expect(hits).toHaveLength(1)
  })

  it('succeeds with zero word count for empty chapters', async () => {
    const id = seedItem(db, { content_type: 'pdf' })
    const result = (await invoke('convert:pdfToEpub', {
      itemId: id,
      chapters: [],
    })) as ConvertResult
    const row = db.prepare('SELECT word_count FROM items WHERE id = ?').get(result.id) as any
    expect(row.word_count).toBe(0)
  })

  it('rolls back and unlinks the written epub file when the DB transaction fails', async () => {
    const id = seedItem(db, { content_type: 'pdf' })
    const collidingId = 'colliding-id'
    seedItem(db, { id: collidingId }) // pre-occupies the id the handler will try to reuse
    vi.mocked(randomUUID).mockReturnValueOnce(collidingId)

    await expect(
      invoke('convert:pdfToEpub', {
        itemId: id,
        chapters: [{ title: 'Ch 1', content: 'text' }],
      }),
    ).rejects.toThrow()

    expect(existsSync(join(userData, 'content', `${collidingId}.epub`))).toBe(false)
    const count = db.prepare('SELECT COUNT(*) as n FROM items WHERE id = ?').get(collidingId) as {
      n: number
    }
    expect(count.n).toBe(1) // still just the pre-seeded row, not overwritten
  })
})
