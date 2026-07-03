import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { app, invoke, resetIpc } from '../../../test/stubs/electron'
import { registerReaderHandlers } from './reader'
import { buildEpub } from '../../../test/fixtures/epub'

const contentDir = join(app.getPath('userData'), 'content')

beforeEach(() => {
  resetIpc()
  rmSync(contentDir, { recursive: true, force: true })
  mkdirSync(contentDir, { recursive: true })
  registerReaderHandlers()
})
afterEach(() => rmSync(contentDir, { recursive: true, force: true }))

describe('reader IPC — path-traversal guards', () => {
  it('rejects traversal on loadContent', () => {
    // loadContent is synchronous — safeContentPath throws before readFile runs.
    expect(() => invoke('reader:loadContent', '../../../etc/passwd')).toThrow(/content path/i)
  })

  it('rejects traversal on loadChapter and loadBinaryContent', async () => {
    await expect(invoke('reader:loadChapter', '../../secret.html', 0)).rejects.toThrow()
    await expect(invoke('reader:loadBinaryContent', '../../secret.pdf')).rejects.toThrow()
  })
})

describe('reader:loadContent', () => {
  it('returns the file contents as a string', async () => {
    writeFileSync(join(contentDir, 'a.html'), '<p>hello</p>', 'utf8')
    expect(await invoke('reader:loadContent', 'a.html')).toBe('<p>hello</p>')
  })
})

describe('reader:getChapterCount', () => {
  it('returns 1 for a single-file (non -chN) item', async () => {
    expect(await invoke('reader:getChapterCount', 'plain.html')).toBe(1)
  })

  it('counts consecutive -chN.html files', async () => {
    for (const n of [0, 1, 2]) writeFileSync(join(contentDir, `bk-ch${n}.html`), 'x', 'utf8')
    expect(await invoke('reader:getChapterCount', 'bk-ch0.html')).toBe(3)
  })
})

describe('reader:loadChapter', () => {
  it('returns a specific chapter by index', async () => {
    writeFileSync(join(contentDir, 'bk-ch0.html'), 'zero', 'utf8')
    writeFileSync(join(contentDir, 'bk-ch1.html'), 'one', 'utf8')
    expect(await invoke('reader:loadChapter', 'bk-ch0.html', 1)).toBe('one')
  })
})

describe('reader:loadBinaryContent', () => {
  it('returns bytes for a valid PDF (magic check passes)', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n')
    writeFileSync(join(contentDir, 'doc.pdf'), pdf)
    const out = (await invoke('reader:loadBinaryContent', 'doc.pdf')) as Buffer
    expect(Buffer.from(out).subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('rejects a file whose bytes are not a PDF', async () => {
    writeFileSync(join(contentDir, 'fake.pdf'), Buffer.from('not a pdf'))
    await expect(invoke('reader:loadBinaryContent', 'fake.pdf')).rejects.toThrow()
  })
})

describe('reader:loadEpub', () => {
  it('parses a valid EPUB into chapters', async () => {
    writeFileSync(
      join(contentDir, 'book.epub'),
      buildEpub({
        chapters: [
          { href: 'c1.xhtml', title: 'One', body: '<p>First.</p>' },
          { href: 'c2.xhtml', title: 'Two', body: '<p>Second.</p>' },
        ],
      }),
    )
    const book = (await invoke('reader:loadEpub', 'book.epub')) as { chapters: { html: string }[] }
    expect(book.chapters.length).toBe(2)
    expect(book.chapters[0].html).toContain('First.')
  })

  it('rejects a file that is not a ZIP/EPUB (magic check)', async () => {
    writeFileSync(join(contentDir, 'bad.epub'), Buffer.from('not a zip'))
    await expect(invoke('reader:loadEpub', 'bad.epub')).rejects.toThrow()
  })
})
