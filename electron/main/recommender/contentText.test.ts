import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeEpubFile, cleanupTempEpubs } from '../../../test/fixtures/epub'

// safeContentPath → identity so we can point file_path at absolute temp files.
// (The path-traversal guard has its own tests; here we exercise extraction.)
vi.mock('../security/paths', () => ({ safeContentPath: (p: string) => p }))

// Mock pdf-parse: real pdf.js needs DOM globals a node test env lacks, and it's
// heavy. We drive getText() per-test to cover the happy + scanned paths.
const { mockGetText } = vi.hoisted(() => ({ mockGetText: vi.fn() }))
vi.mock('pdf-parse', () => ({
  PDFParse: class {
    constructor(_opts: unknown) {}
    getText() {
      return mockGetText()
    }
    destroy() {
      return Promise.resolve()
    }
  },
}))

import { extractPlainText, hasUsableContent, MIN_CONTENT_CHARS } from './contentText'

// Prose long enough to clear MIN_CONTENT_CHARS.
const LONG = 'The quiet archive held ten thousand forgotten stories, each waiting. '.repeat(6)

let TMP: string
beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'pl-contenttext-'))
})
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
  cleanupTempEpubs()
})

function writeHtml(name: string, body: string): string {
  const p = join(TMP, name)
  writeFileSync(p, `<!doctype html><html><body>${body}</body></html>`)
  return p
}

describe('extractPlainText — article', () => {
  it('strips tags and collapses whitespace from a single-file article', async () => {
    const p = writeHtml('single.html', `<h1>Title</h1>\n\n  <p>${LONG}</p>`)
    const text = await extractPlainText({ content_type: 'article', file_path: p })
    expect(text).toContain('quiet archive')
    expect(text).not.toContain('<p>')
    expect(text).not.toMatch(/\s{2,}/) // collapsed
  })

  it('concatenates all -ch{N}.html chapters in order', async () => {
    // base path shared; probe starts at ch0 and stops at the first gap.
    const base = join(TMP, 'multi')
    writeFileSync(`${base}-ch0.html`, '<html><body><p>Alpha chapter body.</p></body></html>')
    writeFileSync(`${base}-ch1.html`, '<html><body><p>Bravo chapter body.</p></body></html>')
    writeFileSync(`${base}-ch2.html`, '<html><body><p>Charlie chapter body.</p></body></html>')
    const text = await extractPlainText({ content_type: 'article', file_path: `${base}-ch0.html` })
    expect(text).toContain('Alpha')
    expect(text).toContain('Bravo')
    expect(text).toContain('Charlie')
    // ordering preserved
    expect(text.indexOf('Alpha')).toBeLessThan(text.indexOf('Bravo'))
    expect(text.indexOf('Bravo')).toBeLessThan(text.indexOf('Charlie'))
  })

  it('stops at the first missing chapter (no infinite probe)', async () => {
    const base = join(TMP, 'gap')
    writeFileSync(`${base}-ch0.html`, '<html><body><p>Only chapter.</p></body></html>')
    // ch1 intentionally absent; ch2 present but must NOT be reached.
    writeFileSync(`${base}-ch2.html`, '<html><body><p>Unreachable.</p></body></html>')
    const text = await extractPlainText({ content_type: 'article', file_path: `${base}-ch0.html` })
    expect(text).toContain('Only chapter')
    expect(text).not.toContain('Unreachable')
  })
})

describe('extractPlainText — epub', () => {
  it('extracts text across chapters via the real epub extractor', async () => {
    const epubPath = makeEpubFile({
      chapters: [
        { href: 'c1.xhtml', title: 'One', body: '<p>Wolves crossed the frozen river.</p>' },
        { href: 'c2.xhtml', title: 'Two', body: '<p>Spring thawed the northern pass.</p>' },
      ],
    })
    const text = await extractPlainText({ content_type: 'epub', file_path: epubPath })
    expect(text).toContain('Wolves crossed the frozen river')
    expect(text).toContain('Spring thawed the northern pass')
    expect(text).not.toContain('<p>')
  })
})

describe('extractPlainText — pdf', () => {
  it('returns collapsed text on a successful parse', async () => {
    const p = join(TMP, 'doc.pdf')
    writeFileSync(p, Buffer.from('%PDF-1.4 dummy'))
    mockGetText.mockResolvedValueOnce({ text: `  ${LONG}  ` })
    const text = await extractPlainText({ content_type: 'pdf', file_path: p })
    expect(text).toContain('quiet archive')
    expect(text.startsWith(' ')).toBe(false)
  })

  it('returns "" for a scanned/unparseable PDF (getText throws)', async () => {
    const p = join(TMP, 'scanned.pdf')
    writeFileSync(p, Buffer.from('%PDF-1.4 image only'))
    mockGetText.mockRejectedValueOnce(new Error('no text layer'))
    const text = await extractPlainText({ content_type: 'pdf', file_path: p })
    expect(text).toBe('')
    expect(hasUsableContent(text)).toBe(false)
  })
})

describe('hasUsableContent', () => {
  it('gates at MIN_CONTENT_CHARS', () => {
    expect(hasUsableContent('x'.repeat(MIN_CONTENT_CHARS - 1))).toBe(false)
    expect(hasUsableContent('x'.repeat(MIN_CONTENT_CHARS))).toBe(true)
  })
})
