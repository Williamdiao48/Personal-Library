import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../../test/stubs/electron'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'

// The legacy EPUB/PDF reconstruction lazy-imports these; mock them so the async
// resolver is testable without the parse worker / pdfjs.
vi.mock('../workers/parse-host', () => ({ parseEpub: vi.fn() }))
vi.mock('../capture/pdfText', () => ({ extractPdfText: vi.fn() }))

import { parseEpub } from '../workers/parse-host'
import { extractPdfText } from '../capture/pdfText'
import {
  indexFtsText,
  readStoredFtsText,
  ftsDeleteValuesSync,
  ftsDeleteValuesAsync,
  removeFtsIndex,
  type FtsItem,
} from './ftsText'

let db: TestDb
let userData: string
let contentDir: string
let getPathSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  db = openTestDb()
  userData = mkdtempSync(join(tmpdir(), 'pl-fts-'))
  contentDir = join(userData, 'content')
  mkdirSync(contentDir, { recursive: true })
  getPathSpy = vi
    .spyOn(app, 'getPath')
    .mockImplementation((name: string) =>
      name === 'userData' ? userData : join('/tmp', `pl-test-${name}`),
    )
  vi.mocked(parseEpub).mockReset()
  vi.mocked(extractPdfText).mockReset()
})
afterEach(() => {
  closeTestDb()
  getPathSpy.mockRestore()
  rmSync(userData, { recursive: true, force: true })
})

/** Seed an item + its items_fts posting (no side-table row = "legacy"). */
function seedIndexed(over: Parameters<typeof seedItem>[1], content: string): FtsItem {
  const id = seedItem(db, over)
  const row = db
    .prepare('SELECT rowid, id, title, author, content_type, file_path FROM items WHERE id = ?')
    .get(id) as FtsItem & { rowid: number }
  db.prepare('INSERT INTO items_fts(rowid, title, author, content) VALUES(?, ?, ?, ?)').run(
    row.rowid,
    row.title,
    row.author ?? '',
    content,
  )
  return row
}

describe('indexFtsText + readStoredFtsText', () => {
  it('upserts the exact values and reads them back', () => {
    const id = seedItem(db, { title: 'T', author: 'A' })
    indexFtsText(db, id, 'T', 'A', 'hello world')
    expect(readStoredFtsText(db, id)).toEqual({ title: 'T', author: 'A', content: 'hello world' })

    // ON CONFLICT updates in place (refresh/append rewrite the same item).
    indexFtsText(db, id, 'T2', null, 'new text')
    expect(readStoredFtsText(db, id)).toEqual({ title: 'T2', author: '', content: 'new text' })
  })

  it('returns undefined for a legacy item with no side-table row', () => {
    const id = seedItem(db, {})
    expect(readStoredFtsText(db, id)).toBeUndefined()
  })
})

describe('ftsDeleteValuesSync', () => {
  it('returns the stored row verbatim when present', () => {
    const id = seedItem(db, { title: 'S' })
    indexFtsText(db, id, 'S', null, 'stored content')
    const item = { id, title: 'S', author: null, content_type: 'article', file_path: `${id}.html` }
    expect(ftsDeleteValuesSync(db, item).content).toBe('stored content')
  })

  it('reconstructs a legacy single-file HTML item from disk', () => {
    const item = seedIndexed({ title: 'H', file_path: 'a.html' }, 'wolverine')
    writeFileSync(join(contentDir, 'a.html'), '<html><body><p>wolverine badger</p></body></html>')
    const vals = ftsDeleteValuesSync(db, item)
    expect(vals.content).toContain('wolverine')
    expect(vals.title).toBe('H')
  })

  it('reconstructs a legacy multi-chapter HTML item by concatenating chapters', () => {
    const item = seedIndexed({ title: 'M', file_path: 'm-ch0.html' }, 'alpha beta')
    writeFileSync(join(contentDir, 'm-ch0.html'), '<body>alpha</body>')
    writeFileSync(join(contentDir, 'm-ch1.html'), '<body>beta</body>')
    const vals = ftsDeleteValuesSync(db, item)
    expect(vals.content).toContain('alpha')
    expect(vals.content).toContain('beta')
  })

  it('legacy EPUB/PDF fall back to empty content (no sync binary re-parse)', () => {
    const item = { id: 'e', title: 'E', author: null, content_type: 'epub', file_path: 'e.epub' }
    expect(ftsDeleteValuesSync(db, item).content).toBe('')
  })
})

describe('ftsDeleteValuesAsync', () => {
  it('re-parses a legacy EPUB to recover exact text', async () => {
    vi.mocked(parseEpub).mockResolvedValue({ plainText: 'epub body text' } as never)
    writeFileSync(join(contentDir, 'e.epub'), 'binary')
    const item = { id: 'e', title: 'E', author: null, content_type: 'epub', file_path: 'e.epub' }
    const vals = await ftsDeleteValuesAsync(db, item)
    expect(vals.content).toBe('epub body text')
    expect(parseEpub).toHaveBeenCalledOnce()
  })

  it('re-extracts a legacy PDF to recover exact text', async () => {
    vi.mocked(extractPdfText).mockResolvedValue('pdf body text')
    writeFileSync(join(contentDir, 'p.pdf'), 'binary')
    const item = { id: 'p', title: 'P', author: null, content_type: 'pdf', file_path: 'p.pdf' }
    const vals = await ftsDeleteValuesAsync(db, item)
    expect(vals.content).toBe('pdf body text')
  })

  it('degrades to empty content when the binary re-parse throws', async () => {
    vi.mocked(parseEpub).mockRejectedValue(new Error('corrupt'))
    writeFileSync(join(contentDir, 'e.epub'), 'binary')
    const item = { id: 'e', title: 'E', author: null, content_type: 'epub', file_path: 'e.epub' }
    expect((await ftsDeleteValuesAsync(db, item)).content).toBe('')
  })

  it('prefers the stored row over any reconstruction', async () => {
    const id = seedItem(db, { content_type: 'epub' })
    indexFtsText(db, id, 'T', null, 'stored')
    const item = { id, title: 'T', author: null, content_type: 'epub', file_path: `${id}.epub` }
    expect((await ftsDeleteValuesAsync(db, item)).content).toBe('stored')
    expect(parseEpub).not.toHaveBeenCalled()
  })
})

describe('removeFtsIndex', () => {
  it('removes the posting when the rowid is indexed and drops the side-table row', () => {
    const item = seedIndexed({ title: 'R' }, 'rhino')
    indexFtsText(db, item.id, 'R', null, 'rhino')
    removeFtsIndex(db, (item as FtsItem & { rowid: number }).rowid, item.id, {
      title: 'R',
      author: '',
      content: 'rhino',
    })
    expect(db.prepare('SELECT COUNT(*) n FROM items_fts').get()).toEqual({ n: 0 })
    expect(readStoredFtsText(db, item.id)).toBeUndefined()
  })

  it('is a safe no-op on the FTS index when the rowid was never indexed', () => {
    // No items_fts posting for this rowid — the guard must skip the 'delete' so the
    // contentless index is never over-decremented.
    const id = seedItem(db, { title: 'U' })
    const { rowid } = db.prepare('SELECT rowid FROM items WHERE id = ?').get(id) as {
      rowid: number
    }
    expect(() =>
      removeFtsIndex(db, rowid, id, { title: 'U', author: '', content: 'never indexed' }),
    ).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) n FROM items_fts').get()).toEqual({ n: 0 })
  })
})
