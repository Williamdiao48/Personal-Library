import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { app } from 'electron'
import { join, extname, basename } from 'path'
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { getDb } from '../db'
import { sanitize } from './sanitizer'
import { fetchPage } from './fetch'
import type { SiteContent } from './fetch'
import { captureAo3, getAo3ChapterCount } from './sites/ao3'
import { captureFfnet } from './sites/ffnet'
import { captureRoyalRoad, getRoyalRoadChapterCount } from './sites/royalroad'
import { captureWattpad, getWattpadChapterCount } from './sites/wattpad'
import { captureScribbleHub, getScribbleHubChapterCount } from './sites/scribblehub'
import { captureXenForo, getXenForoChapterCount } from './sites/forums'
import { captureUniversal } from './sites/universal'
import { parseEpubMetadata } from './parsers/epub'

// Fast non-crypto content hash — same algorithm as in library.ts.
function computeContentHash(text: string): string {
  let h = 0
  const sample = text.length > 4000 ? text.slice(0, 2000) + text.slice(-2000) : text
  for (let i = 0; i < sample.length; i++) {
    h = Math.imul(31, h) + sample.charCodeAt(i) | 0
  }
  return `${text.length}:${h >>> 0}`
}

export interface CaptureResult {
  id: string
  title: string
  author: string | null
  wordCount: number | null
}

export interface ChapterRange { start: number; end: number }

function getContentDir(): string {
  const dir = join(app.getPath('userData'), 'content')
  mkdirSync(dir, { recursive: true })
  return dir
}

// ── URL capture ────────────────────────────────────────────────────────────

// Private helper: dispatches to the right site parser (or universal/generic fallback).
// Returns the assembled SiteContent without saving to disk or DB.
async function dispatchCapture(
  url: string,
  onProgress?: (msg: string) => void,
  range?: ChapterRange,
): Promise<SiteContent> {
  const { hostname } = new URL(url)

  if (hostname.includes('archiveofourown.org')) {
    return captureAo3(url, onProgress, range)
  }
  if (hostname.includes('fanfiction.net')) {
    return captureFfnet(url, onProgress, range)
  }
  if (hostname.includes('royalroad.com')) {
    return captureRoyalRoad(url, onProgress, range)
  }
  if (hostname.includes('wattpad.com')) {
    return captureWattpad(url, onProgress, range)
  }
  if (hostname.includes('scribblehub.com')) {
    return captureScribbleHub(url, onProgress, range)
  }
  if (hostname.includes('sufficientvelocity.com') || hostname.includes('spacebattles.com')) {
    return captureXenForo(url, onProgress, range)
  }

  // Universal serial parser (no range support — falls through to generic)
  const universal = await captureUniversal(url, onProgress)
  if (universal) return universal

  // Generic Readability path
  onProgress?.('Fetching page…')
  const html = await fetchPage(url)
  const dom = new JSDOM(html, { url })
  const article = new Readability(dom.window.document).parse()
  if (!article) throw new Error('Could not extract readable content from this page.')

  return {
    title:       article.title,
    author:      article.byline ?? null,
    html:        sanitize(article.content),
    textContent: article.textContent ?? '',
    coverUrl:    dom.window.document
      .querySelector('meta[property="og:image"]')
      ?.getAttribute('content') ?? undefined,
  }
}

export async function captureUrl(
  url: string,
  onProgress?: (msg: string) => void,
  range?: ChapterRange,
): Promise<CaptureResult> {
  const content = await dispatchCapture(url, onProgress, range)
  return saveToLibrary(url, content, content.coverUrl ?? null, onProgress, range)
}

// Persists assembled content + metadata to disk and the database.
async function saveToLibrary(
  sourceUrl: string,
  content: SiteContent,
  ogImageUrl: string | null = null,
  onProgress?: (msg: string) => void,
  range?: ChapterRange,
): Promise<CaptureResult> {
  const { title, author, html, textContent } = content

  const id = randomUUID()
  const contentDir = getContentDir()

  // Download cover before the transaction (network I/O, fails safely)
  const coverPath = ogImageUrl ? await downloadCover(ogImageUrl, sourceUrl, contentDir, id) : null
  const wordCount   = textContent.split(/\s+/).filter(Boolean).length
  const contentHash = computeContentHash(textContent)
  const now = Date.now()

  onProgress?.('Saving to library…')
  const db = getDb()

  // Detect multi-chapter format: HTML contains ≥2 <div class="chapter"> elements
  const chapterDivs = extractChapterDivs(html)
  const isMultiChapter = chapterDivs.length >= 2

  const filePath = isMultiChapter ? `${id}-ch0.html` : `${id}.html`
  const writtenFiles: string[] = []

  try {
    db.transaction(() => {
      if (isMultiChapter) {
        // Write each chapter as a separate file: {uuid}-ch0.html, {uuid}-ch1.html, …
        for (let i = 0; i < chapterDivs.length; i++) {
          const chFile = join(contentDir, `${id}-ch${i}.html`)
          writeFileSync(chFile, chapterDivs[i], 'utf8')
          writtenFiles.push(chFile)
        }
      } else {
        writeFileSync(join(contentDir, filePath), html, 'utf8')
        writtenFiles.push(join(contentDir, filePath))
      }

      db.prepare(`
        INSERT INTO items (id, title, author, source_url, content_type, file_path, cover_path, word_count, content_hash, date_saved, date_modified, chapter_start, chapter_end)
        VALUES (?, ?, ?, ?, 'article', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, title, author, sourceUrl, filePath, coverPath, wordCount, contentHash, now, now, range?.start ?? null, range?.end ?? null)

      db.prepare(`
        INSERT INTO items_fts (rowid, title, author, content)
        SELECT rowid, title, author, ? FROM items WHERE id = ?
      `).run(textContent, id)
    })()
  } catch (err) {
    // Roll back any files written before the transaction failed
    for (const f of writtenFiles) { try { unlinkSync(f) } catch {} }
    if (coverPath) { try { unlinkSync(join(app.getPath('userData'), coverPath)) } catch {} }
    throw err
  }

  return { id, title, author, wordCount }
}

// Extracts individual <div class="chapter"> outer HTML strings from a combined HTML document.
// Returns an empty array if no chapter divs are found (single-article format).
function extractChapterDivs(html: string): string[] {
  const dom = new JSDOM(html)
  const divs = Array.from(dom.window.document.querySelectorAll('div.chapter'))
  if (divs.length === 0) return []
  return divs.map(d => (d as Element).outerHTML)
}

// ── In-place refresh ───────────────────────────────────────────────────────

// Re-fetches and re-parses a URL through the same pipeline used at capture time,
// but returns the content without touching the database or creating a new entry.
// Used by library:refresh for in-place updates of existing items.
export async function refreshContent(
  url: string,
  onProgress?: (msg: string) => void,
  range?: ChapterRange,
): Promise<{ html: string; textContent: string }> {
  const content = await dispatchCapture(url, onProgress, range)
  return { html: content.html, textContent: content.textContent }
}

// ── Lightweight chapter-count check ────────────────────────────────────────

// Returns the current total chapter count from the site using the cheapest
// available request (index page / API call — no chapter body fetches).
// Returns null for unsupported parsers (ffnet, universal, generic).
export async function getChapterCount(url: string): Promise<number | null> {
  const { hostname } = new URL(url)
  if (hostname.includes('archiveofourown.org'))  return getAo3ChapterCount(url)
  if (hostname.includes('royalroad.com'))        return getRoyalRoadChapterCount(url)
  if (hostname.includes('wattpad.com'))          return getWattpadChapterCount(url)
  if (hostname.includes('scribblehub.com'))      return getScribbleHubChapterCount(url)
  if (hostname.includes('sufficientvelocity.com') || hostname.includes('spacebattles.com'))
                                                 return getXenForoChapterCount(url)
  return null // ffnet requires a BrowserWindow — not worth it for a count check
}

// ── Append chapters ────────────────────────────────────────────────────────

// Fetches new chapters beyond the current chapter_end and appends them to
// the existing HTML file, then updates the DB and FTS5 index in one transaction.
export async function appendChapters(
  itemId: string,
  newEnd: number,
  onProgress?: (msg: string) => void,
): Promise<CaptureResult> {
  const db = getDb()
  const contentDir = getContentDir()

  type Row = {
    rowid:         number
    source_url:    string | null
    file_path:     string
    chapter_start: number | null
    chapter_end:   number | null
    word_count:    number | null
    title:         string
    author:        string | null
  }
  const item = db.prepare(
    'SELECT rowid, source_url, file_path, chapter_start, chapter_end, word_count, title, author FROM items WHERE id = ?'
  ).get(itemId) as Row | undefined

  if (!item) throw new Error('Item not found.')
  if (!item.source_url) throw new Error('This item has no source URL.')
  if (item.chapter_end == null) throw new Error('This item has no chapter_end — cannot append.')

  const appendStart = item.chapter_end + 1
  if (newEnd < appendStart) throw new Error(`New end (${newEnd}) must be ≥ ${appendStart}.`)

  onProgress?.(`Fetching chapters ${appendStart}–${newEnd}…`)
  const newContent = await dispatchCapture(
    item.source_url,
    onProgress,
    { start: appendStart, end: newEnd },
  )

  // Determine whether this item uses the new per-chapter file format
  const isMultiChapterFormat = item.file_path.match(/-ch(\d+)\.html$/) !== null

  let existingText = ''
  let newWordCount: number

  if (isMultiChapterFormat) {
    // Count existing chapter files to determine the next index
    const uuidBase = item.file_path.replace(/-ch\d+\.html$/, '')
    let chCount = 0
    while (true) {
      try {
        readFileSync(join(contentDir, `${uuidBase}-ch${chCount}.html`), 'utf8')
        chCount++
      } catch { break }
    }

    // Read existing text from all chapter files for FTS update
    for (let i = 0; i < chCount; i++) {
      try {
        const chHtml = readFileSync(join(contentDir, `${uuidBase}-ch${chCount - 1 - i}.html`), 'utf8')
        existingText += new JSDOM(chHtml).window.document.body?.textContent ?? ''
        existingText += ' '
      } catch {}
    }

    // Write new chapters as additional files
    const newChapterDivs = extractChapterDivs(newContent.html)
    if (newChapterDivs.length > 0) {
      for (let i = 0; i < newChapterDivs.length; i++) {
        writeFileSync(join(contentDir, `${uuidBase}-ch${chCount + i}.html`), newChapterDivs[i], 'utf8')
      }
    } else {
      // Fallback: treat entire new HTML as a single additional chapter
      writeFileSync(join(contentDir, `${uuidBase}-ch${chCount}.html`), newContent.html, 'utf8')
    }

    const combinedText = existingText + ' ' + newContent.textContent
    newWordCount = combinedText.split(/\s+/).filter(Boolean).length

    const now = Date.now()
    db.transaction(() => {
      db.prepare(
        `INSERT INTO items_fts(items_fts, rowid, title, author, content) VALUES('delete', ?, ?, ?, ?)`
      ).run(item.rowid, item.title, item.author ?? '', existingText.trim())

      db.prepare(
        `INSERT INTO items_fts(rowid, title, author, content) VALUES(?, ?, ?, ?)`
      ).run(item.rowid, item.title, item.author ?? '', combinedText)

      db.prepare(
        'UPDATE items SET chapter_end = ?, word_count = ?, date_modified = ? WHERE id = ?'
      ).run(newEnd, newWordCount, now, itemId)
    })()

    return { id: itemId, title: item.title, author: item.author, wordCount: newWordCount }
  }

  const existingHtml = readFileSync(join(contentDir, item.file_path), 'utf8')
  existingText = new JSDOM(existingHtml).window.document.body?.textContent ?? ''

  const combinedHtml = existingHtml + '\n' + newContent.html
  const combinedText = existingText + ' ' + newContent.textContent
  newWordCount = combinedText.split(/\s+/).filter(Boolean).length

  writeFileSync(join(contentDir, item.file_path), combinedHtml, 'utf8')

  const now = Date.now()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO items_fts(items_fts, rowid, title, author, content) VALUES('delete', ?, ?, ?, ?)`
    ).run(item.rowid, item.title, item.author ?? '', existingText)

    db.prepare(
      `INSERT INTO items_fts(rowid, title, author, content) VALUES(?, ?, ?, ?)`
    ).run(item.rowid, item.title, item.author ?? '', combinedText)

    db.prepare(
      'UPDATE items SET chapter_end = ?, word_count = ?, date_modified = ? WHERE id = ?'
    ).run(newEnd, newWordCount, now, itemId)
  })()

  return { id: itemId, title: item.title, author: item.author, wordCount: newWordCount }
}

// ── File import ────────────────────────────────────────────────────────────

export async function captureFile(filePath: string): Promise<CaptureResult> {
  const ext = extname(filePath).slice(1).toLowerCase()
  if (ext === 'epub') return captureEpub(filePath)
  if (ext === 'pdf')  return capturePdf(filePath)
  throw new Error(`Unsupported file type: .${ext}`)
}

function captureEpub(filePath: string): CaptureResult {
  const meta = parseEpubMetadata(filePath)

  const id = randomUUID()
  const contentDir = getContentDir()

  const destFileName = `${id}.epub`
  const destPath = join(contentDir, destFileName)
  copyFileSync(filePath, destPath)

  let coverPath: string | null = null
  let coverFilePath: string | null = null
  if (meta.coverBuffer && meta.coverExt) {
    const coverFile = `${id}-cover.${meta.coverExt}`
    coverFilePath = join(contentDir, coverFile)
    writeFileSync(coverFilePath, meta.coverBuffer)
    coverPath = `content/${coverFile}`
  }

  const title = meta.title ?? basename(filePath, '.epub')
  const author = meta.author ?? null
  const now = Date.now()

  const db = getDb()
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO items (id, title, author, source_url, content_type, file_path, cover_path, word_count, date_saved, date_modified)
        VALUES (?, ?, ?, NULL, 'epub', ?, ?, NULL, ?, ?)
      `).run(id, title, author, destFileName, coverPath, now, now)

      db.prepare(`
        INSERT INTO items_fts (rowid, title, author, content)
        SELECT rowid, title, author, '' FROM items WHERE id = ?
      `).run(id)
    })()
  } catch (err) {
    try { unlinkSync(destPath) } catch {}
    if (coverFilePath) { try { unlinkSync(coverFilePath) } catch {} }
    throw err
  }

  return { id, title, author, wordCount: null }
}

function capturePdf(filePath: string): CaptureResult {
  const id = randomUUID()
  const contentDir = getContentDir()

  const destFileName = `${id}.pdf`
  const destPath = join(contentDir, destFileName)
  copyFileSync(filePath, destPath)

  const title = basename(filePath, '.pdf')
  const now = Date.now()

  const db = getDb()
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO items (id, title, author, source_url, content_type, file_path, cover_path, word_count, date_saved, date_modified)
        VALUES (?, ?, NULL, NULL, 'pdf', ?, NULL, NULL, ?, ?)
      `).run(id, title, destFileName, now, now)

      db.prepare(`
        INSERT INTO items_fts (rowid, title, author, content)
        SELECT rowid, title, author, '' FROM items WHERE id = ?
      `).run(id)
    })()
  } catch (err) {
    try { unlinkSync(destPath) } catch {}
    throw err
  }

  return { id, title, author: null, wordCount: null }
}

// ── Cover image download ───────────────────────────────────────────────────

async function downloadCover(
  ogImageUrl: string,
  pageUrl: string,
  contentDir: string,
  id: string
): Promise<string | null> {
  try {
    const absoluteUrl = new URL(ogImageUrl, pageUrl).href
    if (absoluteUrl.startsWith('data:')) return null

    const res = await fetch(absoluteUrl, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalLibrary/1.0; personal-use)' }
    })
    if (!res.ok) return null

    const contentType = res.headers.get('content-type') ?? ''
    const ext = extFromContentType(contentType) ?? (extname(new URL(absoluteUrl).pathname).slice(1) || 'jpg')
    const allowedExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'])
    if (!allowedExts.has(ext)) return null

    const buffer = Buffer.from(await res.arrayBuffer())
    const coverPath = `${id}-cover.${ext}`
    writeFileSync(join(contentDir, coverPath), buffer)
    return `content/${coverPath}`
  } catch {
    return null
  }
}

function extFromContentType(ct: string): string | null {
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg'
  if (ct.includes('png'))  return 'png'
  if (ct.includes('gif'))  return 'gif'
  if (ct.includes('webp')) return 'webp'
  if (ct.includes('avif')) return 'avif'
  return null
}

