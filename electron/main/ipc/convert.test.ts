import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { invoke, resetIpc } from '../../../test/stubs/electron'
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

const CONTENT_DIR = '/tmp/pl-test-userdata/content'

let db: TestDb

beforeEach(() => {
  resetIpc()
  db = openTestDb()
  registerConvertHandlers()
})
afterEach(() => closeTestDb())

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
    expect(existsSync(join(CONTENT_DIR, `${result.id}.epub`))).toBe(true)

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

    expect(existsSync(join(CONTENT_DIR, `${collidingId}.epub`))).toBe(false)
    const count = db.prepare('SELECT COUNT(*) as n FROM items WHERE id = ?').get(collidingId) as {
      n: number
    }
    expect(count.n).toBe(1) // still just the pre-seeded row, not overwritten
  })
})
