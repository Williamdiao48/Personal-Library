import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs'
import type { SiteContent } from './fetch'

// Integration coverage for the capture ORCHESTRATOR (index.ts). The site parsers
// themselves are covered in Tier 2, so we mock them (and the network / cover /
// import-gate / epub+pdf parse boundaries) and let the real dispatch routing,
// saveToLibrary file-split + DB/FTS writes + rollback, refresh, getChapterCount
// routing, appendChapters (both file formats) and captureFile logic run against
// an in-memory SQLite DB (the shared harness) and real temp-dir file I/O.
//
// Runs in the `main` (node env) project → needs the node ABI for better-sqlite3
// (`npm run rebuild:node`), same as every electron/main/ipc/*.test.ts suite.

vi.mock('./sites/ao3', () => ({ captureAo3: vi.fn(), getAo3ChapterCount: vi.fn() }))
vi.mock('./sites/ffnet', () => ({ captureFfnet: vi.fn() }))
vi.mock('./sites/royalroad', () => ({
  captureRoyalRoad: vi.fn(),
  getRoyalRoadChapterCount: vi.fn(),
}))
vi.mock('./sites/wattpad', () => ({ captureWattpad: vi.fn(), getWattpadChapterCount: vi.fn() }))
vi.mock('./sites/scribblehub', () => ({
  captureScribbleHub: vi.fn(),
  getScribbleHubChapterCount: vi.fn(),
}))
vi.mock('./sites/forums', () => ({ captureXenForo: vi.fn(), getXenForoChapterCount: vi.fn() }))
vi.mock('./sites/universal', () => ({ captureUniversal: vi.fn() }))
vi.mock('./fetch', () => ({ fetchPage: vi.fn() }))
// Keep the scheme guard as a no-op (its own logic is covered in net-guard.test.ts
// / capture.test.ts); stub safeFetch so cover downloads never hit the network.
vi.mock('../security/net-guard', () => ({ assertHttpUrl: vi.fn(), safeFetch: vi.fn() }))
vi.mock('../security/validation', () => ({ assertImportFile: vi.fn(() => Promise.resolve()) }))
vi.mock('../workers/parse-host', () => ({ parseEpub: vi.fn() }))
// Stub the pdfjs-dist text extractor (real pdf.js is ESM + heavy; word-count
// behavior is what matters here). "pdf words extracted" → 3 words.
vi.mock('./pdfText', () => ({
  extractPdfText: vi.fn(async () => 'pdf words extracted'),
}))

import { captureUrl, refreshContent, getChapterCount, appendChapters, captureFile } from './index'
import { captureAo3, getAo3ChapterCount } from './sites/ao3'
import { captureFfnet } from './sites/ffnet'
import { captureRoyalRoad, getRoyalRoadChapterCount } from './sites/royalroad'
import { captureWattpad, getWattpadChapterCount } from './sites/wattpad'
import { captureScribbleHub, getScribbleHubChapterCount } from './sites/scribblehub'
import { captureXenForo, getXenForoChapterCount } from './sites/forums'
import { captureUniversal } from './sites/universal'
import { fetchPage } from './fetch'
import { safeFetch } from '../security/net-guard'
import { parseEpub } from '../workers/parse-host'
import * as ftsText from '../db/ftsText'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'

const USERDATA = '/tmp/pl-test-userdata' // matches test/stubs/electron.ts app.getPath('userData')
const CONTENT = join(USERDATA, 'content')
const FIX = '/tmp/pl-test-capture-fix'

let epubFixture: string
let pdfFixture: string

// A Readability-parseable article (generic-fallback path needs real prose).
const PROSE =
  'The quiet harbor town woke slowly under a pale grey sky, its narrow streets still damp ' +
  'from the night rain as fishermen hauled their nets toward the waiting boats and gulls ' +
  'wheeled overhead crying for scraps left along the weathered wooden pier. '
const articleHtml =
  `<!DOCTYPE html><html><head><title>Generic Post</title></head><body><article>` +
  `<h1>Generic Post</h1><p>${PROSE.repeat(3)}</p><p>${PROSE.repeat(3)}</p>` +
  `<p>${PROSE.repeat(2)}</p></article></body></html>`

const siteContent = (over: Partial<SiteContent> = {}): SiteContent => ({
  title: 'Fixture Title',
  author: 'Fixture Author',
  html: '<p>alpha bravo charlie</p>',
  textContent: 'alpha bravo charlie',
  coverUrl: null,
  ...over,
})

// Minimal fake Response for downloadCover (needs ok / headers.get / arrayBuffer).
const imgResponse = (contentType = 'image/png', ok = true): Response =>
  ({
    ok,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => new ArrayBuffer(8),
  }) as unknown as Response

let db: TestDb

beforeAll(() => {
  mkdirSync(FIX, { recursive: true })
  epubFixture = join(FIX, 'sample.epub')
  pdfFixture = join(FIX, 'sample.pdf')
  writeFileSync(epubFixture, 'PK\x03\x04 dummy epub bytes')
  writeFileSync(pdfFixture, '%PDF-1.4 dummy pdf bytes')
})

beforeEach(() => {
  db = openTestDb()
  vi.clearAllMocks()
  mkdirSync(CONTENT, { recursive: true })
  // Cover download fails by default (no network) → non-fatal "no cover".
  vi.mocked(safeFetch).mockRejectedValue(new Error('no network'))
})

afterEach(() => {
  closeTestDb()
  rmSync(CONTENT, { recursive: true, force: true })
})

// ── Dispatch routing ─────────────────────────────────────────────────────────
describe('captureUrl — dispatch routing', () => {
  const cases: Array<[string, ReturnType<typeof vi.fn>]> = [
    ['https://archiveofourown.org/works/1', vi.mocked(captureAo3)],
    ['https://www.fanfiction.net/s/1/1', vi.mocked(captureFfnet)],
    ['https://www.royalroad.com/fiction/1', vi.mocked(captureRoyalRoad)],
    ['https://www.wattpad.com/story/1', vi.mocked(captureWattpad)],
    ['https://www.scribblehub.com/series/1/x', vi.mocked(captureScribbleHub)],
    ['https://forums.sufficientvelocity.com/threads/1', vi.mocked(captureXenForo)],
    ['https://forums.spacebattles.com/threads/1', vi.mocked(captureXenForo)],
  ]

  it.each(cases)('routes %s to its site parser', async (url, parser) => {
    parser.mockResolvedValue(siteContent({ title: 'Routed' }))
    const res = await captureUrl(url)
    expect(parser).toHaveBeenCalledOnce()
    expect(res.title).toBe('Routed')
  })

  it('falls through to Readability when host is unknown and universal returns null', async () => {
    vi.mocked(captureUniversal).mockResolvedValue(null)
    vi.mocked(fetchPage).mockResolvedValue(articleHtml)

    const res = await captureUrl('https://unknown.example.com/post')

    expect(fetchPage).toHaveBeenCalledWith('https://unknown.example.com/post')
    expect(res.title).toBeTruthy()
    const hit = db.prepare('SELECT rowid FROM items_fts WHERE items_fts MATCH ?').get('harbor')
    expect(hit).toBeTruthy()
  })

  it('uses a universal-parser result when one is returned (no generic fetch)', async () => {
    vi.mocked(captureUniversal).mockResolvedValue(siteContent({ title: 'Serial' }))
    const res = await captureUrl('https://unknown.example.com/serial')
    expect(res.title).toBe('Serial')
    expect(fetchPage).not.toHaveBeenCalled()
  })
})

// ── saveToLibrary: single-article persistence ────────────────────────────────
describe('captureUrl — single-article persistence', () => {
  it('writes one file, one items row, and an FTS row', async () => {
    vi.mocked(captureRoyalRoad).mockResolvedValue(
      siteContent({ html: '<p>alpha bravo charlie</p>', textContent: 'alpha bravo charlie' }),
    )
    const res = await captureUrl('https://www.royalroad.com/fiction/1')

    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(res.id) as any
    expect(row.content_type).toBe('article')
    expect(row.file_path).toBe(`${res.id}.html`)
    expect(row.word_count).toBe(3)
    expect(existsSync(join(CONTENT, `${res.id}.html`))).toBe(true)

    const hit = db.prepare('SELECT rowid FROM items_fts WHERE items_fts MATCH ?').get('bravo')
    expect(hit).toBeTruthy()
  })

  it('records the chapter range on the row', async () => {
    vi.mocked(captureRoyalRoad).mockResolvedValue(siteContent())
    const res = await captureUrl('https://www.royalroad.com/fiction/1', undefined, {
      start: 2,
      end: 5,
    })
    const row = db
      .prepare('SELECT chapter_start, chapter_end FROM items WHERE id = ?')
      .get(res.id) as any
    expect(row.chapter_start).toBe(2)
    expect(row.chapter_end).toBe(5)
  })
})

// ── saveToLibrary: multi-chapter split (Headline) ────────────────────────────
describe('captureUrl — multi-chapter split', () => {
  // Headline: ≥2 `<div class="chapter">` → one file per chapter; the file_path is
  // the -ch0 entry point. Exactly 1 chapter stays single-file (the >= 2 boundary,
  // mirrors HtmlReader's paged-vs-single mode selection).
  it('splits ≥2 .chapter divs into per-chapter files', async () => {
    const html = '<div class="chapter"><p>one</p></div><div class="chapter"><p>two</p></div>'
    vi.mocked(captureRoyalRoad).mockResolvedValue(siteContent({ html, textContent: 'one two' }))

    const res = await captureUrl('https://www.royalroad.com/fiction/1')

    const row = db.prepare('SELECT file_path FROM items WHERE id = ?').get(res.id) as any
    expect(row.file_path).toBe(`${res.id}-ch0.html`)
    expect(existsSync(join(CONTENT, `${res.id}-ch0.html`))).toBe(true)
    expect(existsSync(join(CONTENT, `${res.id}-ch1.html`))).toBe(true)
    expect(existsSync(join(CONTENT, `${res.id}-ch2.html`))).toBe(false)
  })

  it('keeps a single .chapter div as one file (>=2 boundary)', async () => {
    const html = '<div class="chapter"><p>only</p></div>'
    vi.mocked(captureRoyalRoad).mockResolvedValue(siteContent({ html, textContent: 'only' }))

    const res = await captureUrl('https://www.royalroad.com/fiction/1')

    const row = db.prepare('SELECT file_path FROM items WHERE id = ?').get(res.id) as any
    expect(row.file_path).toBe(`${res.id}.html`)
  })
})

// ── saveToLibrary: transactional rollback (Headline) ─────────────────────────
describe('captureUrl — rollback on DB failure', () => {
  // Headline: a NULL title violates items.title NOT NULL → the INSERT throws
  // inside the transaction after the chapter files are written. The catch must
  // unlink every written file and leave no row behind.
  it('unlinks written chapter files and inserts no row when the write fails', async () => {
    const html = '<div class="chapter"><p>one</p></div><div class="chapter"><p>two</p></div>'
    vi.mocked(captureRoyalRoad).mockResolvedValue(
      siteContent({ title: null as unknown as string, html, textContent: 'one two' }),
    )
    const before = (db.prepare('SELECT COUNT(*) c FROM items').get() as any).c

    await expect(captureUrl('https://www.royalroad.com/fiction/1')).rejects.toThrow()

    const after = (db.prepare('SELECT COUNT(*) c FROM items').get() as any).c
    expect(after).toBe(before)
    // No orphaned chapter files linger in the content dir.
    const leftover = readdirSync(CONTENT).filter((f) => f.endsWith('.html'))
    expect(leftover).toEqual([])
  })
})

// ── Cover download ───────────────────────────────────────────────────────────
describe('captureUrl — cover download', () => {
  it('downloads a cover via safeFetch and records cover_path', async () => {
    vi.mocked(safeFetch).mockResolvedValue(imgResponse('image/png'))
    vi.mocked(captureRoyalRoad).mockResolvedValue(
      siteContent({ coverUrl: 'https://img.test/c.png' }),
    )
    const res = await captureUrl('https://www.royalroad.com/fiction/1')

    const row = db.prepare('SELECT cover_path FROM items WHERE id = ?').get(res.id) as any
    expect(row.cover_path).toBe(`content/${res.id}-cover.png`)
    expect(existsSync(join(CONTENT, `${res.id}-cover.png`))).toBe(true)
  })

  it('skips a disallowed cover content-type but still saves the item', async () => {
    vi.mocked(safeFetch).mockResolvedValue(imgResponse('application/pdf'))
    vi.mocked(captureRoyalRoad).mockResolvedValue(
      siteContent({ coverUrl: 'https://img.test/c.pdf' }),
    )
    const res = await captureUrl('https://www.royalroad.com/fiction/1')

    const row = db.prepare('SELECT cover_path FROM items WHERE id = ?').get(res.id) as any
    expect(row.cover_path).toBeNull()
  })

  it('never fetches a data: cover URL', async () => {
    vi.mocked(captureRoyalRoad).mockResolvedValue(
      siteContent({ coverUrl: 'data:image/png;base64,AAAA' }),
    )
    const res = await captureUrl('https://www.royalroad.com/fiction/1')

    expect(safeFetch).not.toHaveBeenCalled()
    const row = db.prepare('SELECT cover_path FROM items WHERE id = ?').get(res.id) as any
    expect(row.cover_path).toBeNull()
  })
})

// ── getChapterCount routing ──────────────────────────────────────────────────
describe('getChapterCount — routing', () => {
  it('returns the site count for supported hosts', async () => {
    vi.mocked(getAo3ChapterCount).mockResolvedValue(7)
    vi.mocked(getRoyalRoadChapterCount).mockResolvedValue(12)
    vi.mocked(getWattpadChapterCount).mockResolvedValue(3)
    vi.mocked(getScribbleHubChapterCount).mockResolvedValue(9)
    vi.mocked(getXenForoChapterCount).mockResolvedValue(4)

    expect(await getChapterCount('https://archiveofourown.org/works/1')).toBe(7)
    expect(await getChapterCount('https://www.royalroad.com/fiction/1')).toBe(12)
    expect(await getChapterCount('https://www.wattpad.com/story/1')).toBe(3)
    expect(await getChapterCount('https://www.scribblehub.com/series/1/x')).toBe(9)
    expect(await getChapterCount('https://forums.spacebattles.com/threads/1')).toBe(4)
  })

  it('returns null for fanfiction.net and unknown hosts', async () => {
    expect(await getChapterCount('https://www.fanfiction.net/s/1/1')).toBeNull()
    expect(await getChapterCount('https://unknown.example.com/x')).toBeNull()
  })
})

// ── refreshContent ───────────────────────────────────────────────────────────
describe('refreshContent', () => {
  it('returns re-parsed content without writing files or rows', async () => {
    vi.mocked(captureRoyalRoad).mockResolvedValue(
      siteContent({ html: '<p>fresh</p>', textContent: 'fresh' }),
    )
    const before = (db.prepare('SELECT COUNT(*) c FROM items').get() as any).c

    const out = await refreshContent('https://www.royalroad.com/fiction/1')

    expect(out).toEqual({ html: '<p>fresh</p>', textContent: 'fresh' })
    const after = (db.prepare('SELECT COUNT(*) c FROM items').get() as any).c
    expect(after).toBe(before)
  })
})

// ── appendChapters: legacy single-file (Headline) ────────────────────────────
describe('appendChapters — legacy single-file format', () => {
  function seedLegacy(over: { chapter_end?: number | null; source_url?: string | null } = {}) {
    const id = seedItem(db, {
      title: 'Ongoing',
      source_url:
        over.source_url === undefined ? 'https://www.royalroad.com/fiction/1' : over.source_url,
      file_path: 'legacy.html',
    })
    if (over.chapter_end !== undefined) {
      db.prepare('UPDATE items SET chapter_start = 1, chapter_end = ? WHERE id = ?').run(
        over.chapter_end,
        id,
      )
    }
    return id
  }

  it('concatenates the file, updates the row, and re-indexes FTS', async () => {
    const id = seedLegacy({ chapter_end: 2 })
    writeFileSync(join(CONTENT, 'legacy.html'), '<p>existing words</p>', 'utf8')
    db.prepare(
      'INSERT INTO items_fts (rowid, title, author, content) SELECT rowid, title, author, ? FROM items WHERE id = ?',
    ).run('existing words', id)

    vi.mocked(captureRoyalRoad).mockResolvedValue(
      siteContent({ html: '<p>new words</p>', textContent: 'new words' }),
    )

    const res = await appendChapters(id, 4)

    const row = db.prepare('SELECT chapter_end, word_count FROM items WHERE id = ?').get(id) as any
    expect(row.chapter_end).toBe(4)
    expect(row.word_count).toBe(4) // "existing words new words"
    expect(res.wordCount).toBe(4)

    const file = readFileSync(join(CONTENT, 'legacy.html'), 'utf8')
    expect(file).toContain('new words')

    const hit = db.prepare('SELECT rowid FROM items_fts WHERE items_fts MATCH ?').get('new')
    expect(hit).toBeTruthy()
  })

  it('rejects when the item is missing', async () => {
    await expect(appendChapters('does-not-exist', 5)).rejects.toThrow('Item not found')
  })

  it('rejects when the item has no source URL', async () => {
    const id = seedLegacy({ chapter_end: 2, source_url: null })
    await expect(appendChapters(id, 5)).rejects.toThrow('no source URL')
  })

  it('rejects when the item has no chapter_end', async () => {
    const id = seedLegacy({}) // chapter_end stays NULL
    await expect(appendChapters(id, 5)).rejects.toThrow('cannot append')
  })

  it('rejects when newEnd is below the next chapter', async () => {
    const id = seedLegacy({ chapter_end: 5 })
    await expect(appendChapters(id, 3)).rejects.toThrow('must be ≥ 6')
  })
})

// ── appendChapters: per-chapter file format (Headline) ───────────────────────
describe('appendChapters — per-chapter file format', () => {
  it('writes new chapter files at the next index and updates the row', async () => {
    const id = seedItem(db, {
      title: 'Serial',
      source_url: 'https://www.royalroad.com/fiction/1',
      file_path: `${'serialbase'}-ch0.html`,
    })
    db.prepare('UPDATE items SET chapter_start = 1, chapter_end = 2 WHERE id = ?').run(id)
    // Two existing per-chapter files.
    writeFileSync(
      join(CONTENT, 'serialbase-ch0.html'),
      '<div class="chapter"><p>chapter zero words</p></div>',
      'utf8',
    )
    writeFileSync(
      join(CONTENT, 'serialbase-ch1.html'),
      '<div class="chapter"><p>chapter one words</p></div>',
      'utf8',
    )
    db.prepare(
      'INSERT INTO items_fts (rowid, title, author, content) SELECT rowid, title, author, ? FROM items WHERE id = ?',
    ).run('chapter zero words chapter one words', id)

    vi.mocked(captureRoyalRoad).mockResolvedValue(
      siteContent({
        html:
          '<div class="chapter"><p>chapter two words</p></div>' +
          '<div class="chapter"><p>chapter three words</p></div>',
        textContent: 'chapter two words chapter three words',
      }),
    )

    const res = await appendChapters(id, 4)

    expect(existsSync(join(CONTENT, 'serialbase-ch2.html'))).toBe(true)
    expect(existsSync(join(CONTENT, 'serialbase-ch3.html'))).toBe(true)
    expect(existsSync(join(CONTENT, 'serialbase-ch4.html'))).toBe(false)

    const row = db.prepare('SELECT chapter_end FROM items WHERE id = ?').get(id) as any
    expect(row.chapter_end).toBe(4)
    expect(res.wordCount).toBeGreaterThan(4)

    const hit = db.prepare('SELECT rowid FROM items_fts WHERE items_fts MATCH ?').get('three')
    expect(hit).toBeTruthy()
  })

  // T1-3 regression: the new chapter files are written before the DB transaction,
  // so a txn failure must roll them back — otherwise orphaned -chN.html files
  // inflate the next append's chapter count and duplicate chapters. Force the txn
  // to throw (via indexFtsText) after the files are written.
  it('rolls back newly written chapter files when the append transaction fails', async () => {
    const id = seedItem(db, {
      title: 'Serial',
      source_url: 'https://www.royalroad.com/fiction/1',
      file_path: 'rbbase-ch0.html',
    })
    db.prepare('UPDATE items SET chapter_start = 1, chapter_end = 2 WHERE id = ?').run(id)
    writeFileSync(
      join(CONTENT, 'rbbase-ch0.html'),
      '<div class="chapter"><p>zero</p></div>',
      'utf8',
    )
    writeFileSync(join(CONTENT, 'rbbase-ch1.html'), '<div class="chapter"><p>one</p></div>', 'utf8')
    db.prepare(
      'INSERT INTO items_fts (rowid, title, author, content) SELECT rowid, title, author, ? FROM items WHERE id = ?',
    ).run('zero one', id)

    vi.mocked(captureRoyalRoad).mockResolvedValue(
      siteContent({
        html: '<div class="chapter"><p>two</p></div>',
        textContent: 'two',
      }),
    )

    // Make the transaction throw AFTER the -ch2 file is written.
    const spy = vi.spyOn(ftsText, 'indexFtsText').mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(appendChapters(id, 3)).rejects.toThrow('boom')
    spy.mockRestore()

    // The newly written chapter file was rolled back…
    expect(existsSync(join(CONTENT, 'rbbase-ch2.html'))).toBe(false)
    // …the pre-existing chapter files are untouched…
    expect(existsSync(join(CONTENT, 'rbbase-ch0.html'))).toBe(true)
    expect(existsSync(join(CONTENT, 'rbbase-ch1.html'))).toBe(true)
    // …and the DB rolled back (chapter_end unchanged), so a retry starts clean.
    const row = db.prepare('SELECT chapter_end FROM items WHERE id = ?').get(id) as any
    expect(row.chapter_end).toBe(2)
  })
})

// ── captureFile ──────────────────────────────────────────────────────────────
describe('captureFile', () => {
  it('imports an .epub via parseEpub → epub row + copied file', async () => {
    vi.mocked(parseEpub).mockResolvedValue({
      title: 'My Epub',
      author: 'Auth',
      coverBuffer: null,
      coverExt: null,
      plainText: 'epub text here',
      wordCount: 3,
    })

    const res = await captureFile(epubFixture)

    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(res.id) as any
    expect(row.content_type).toBe('epub')
    expect(row.title).toBe('My Epub')
    expect(row.word_count).toBe(3)
    expect(existsSync(join(CONTENT, `${res.id}.epub`))).toBe(true)
  })

  it('writes a cover file when the epub carries one', async () => {
    vi.mocked(parseEpub).mockResolvedValue({
      title: 'Cover Epub',
      author: null,
      coverBuffer: Buffer.from([1, 2, 3]),
      coverExt: 'jpg',
      plainText: 'text',
      wordCount: 1,
    })

    const res = await captureFile(epubFixture)

    const row = db.prepare('SELECT cover_path FROM items WHERE id = ?').get(res.id) as any
    expect(row.cover_path).toBe(`content/${res.id}-cover.jpg`)
    expect(existsSync(join(CONTENT, `${res.id}-cover.jpg`))).toBe(true)
  })

  it('imports the epub with fallback metadata when the parse worker fails', async () => {
    vi.mocked(parseEpub).mockRejectedValue(new Error('worker crashed'))

    const res = await captureFile(epubFixture)

    const row = db.prepare('SELECT title, word_count FROM items WHERE id = ?').get(res.id) as any
    expect(row.title).toBe('sample') // basename(fixture, '.epub')
    expect(row.word_count).toBeNull()
  })

  it('imports a .pdf, extracting text for word count', async () => {
    const res = await captureFile(pdfFixture)

    const row = db
      .prepare('SELECT content_type, word_count FROM items WHERE id = ?')
      .get(res.id) as any
    expect(row.content_type).toBe('pdf')
    expect(row.word_count).toBe(3) // "pdf words extracted"
    expect(existsSync(join(CONTENT, `${res.id}.pdf`))).toBe(true)
  })

  it('rejects an unsupported extension', async () => {
    await expect(captureFile('/tmp/whatever.txt')).rejects.toThrow('Unsupported file type')
  })
})
