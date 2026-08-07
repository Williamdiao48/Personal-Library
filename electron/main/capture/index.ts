import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { app } from 'electron'
import { join, extname, basename } from 'path'
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, unlinkSync, existsSync } from 'fs'
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
import { safeContentPath } from '../security/paths'
import { assertImportFile, normalizeCoverExt } from '../security/validation'
import { assertHttpUrl, safeFetch } from '../security/net-guard'
import { resolveEpubParse, resolvePdfParse } from '../cloud/processing'
import { indexFtsText, readStoredFtsText } from '../db/ftsText'
import { computeContentHash } from '../util/contentHash'
import { computeFileHash } from './fileHash'
import { persistSourceTags, siteKeyFromUrl } from '../recommender/sourceTags'

export interface CaptureResult {
  id: string
  title: string
  author: string | null
  wordCount: number | null
  // Set when a file import matched an existing library item (same raw-file
  // sha256) and was collapsed onto it — no new item was created; `id` is the
  // existing item's. The renderer surfaces this ("Already in your library").
  duplicate?: boolean
}

// A pre-existing library item that a re-imported file collapsed onto, looked up
// by items.file_hash. Only LIVE items dedup: a byte-identical file whose item is
// in trash re-imports fresh (the user deleted it — a new copy is the intent).
//
// Cross-device: Phase-3 sync replicates items across a user's devices, so the
// matched item can be one first imported on ANOTHER device — whose bytes aren't on
// THIS device yet (content arrives via pull-on-open, and only if it was backed up
// to R2). When the matched item's local file is missing, we adopt the just-imported
// bytes into its path so the de-duped book is immediately openable here (the user
// clearly has the file — they just picked it). `importPath` is that picked file.
function resolveFileDuplicate(fileHash: string, importPath: string): CaptureResult | null {
  const dup = getDb()
    .prepare(
      `SELECT id, title, author, word_count, file_path FROM items
       WHERE file_hash = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(fileHash) as
    | {
        id: string
        title: string
        author: string | null
        word_count: number | null
        file_path: string
      }
    | undefined
  if (!dup) return null

  // Adopt the imported bytes if this device lacks the matched item's content
  // (cross-device dedup against a not-yet-downloaded book). Best-effort: a failed
  // copy must not block the dedup — the item stays as-is (pull-on-open remains an
  // option if it was backed up). dedup only matches epub/pdf items, so file_path
  // is a single content file (no multi-chapter handling).
  const localPath = safeContentPath(dup.file_path)
  if (!existsSync(localPath)) {
    try {
      copyFileSync(importPath, localPath)
    } catch {
      // leave the item's bytes unresolved; the duplicate result still stands.
    }
  }

  return {
    id: dup.id,
    title: dup.title,
    author: dup.author,
    wordCount: dup.word_count,
    duplicate: true,
  }
}

export interface ChapterRange {
  start: number
  end: number
}

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
  // Scheme allow-list at the single capture chokepoint (F10) — covers
  // capture:start, refresh, and append. Host is intentionally NOT restricted
  // here: the target is user-chosen, so localhost/LAN capture stays allowed.
  assertHttpUrl(url)
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
    title: article.title,
    author: article.byline ?? null,
    html: sanitize(article.content),
    textContent: article.textContent ?? '',
    coverUrl:
      dom.window.document.querySelector('meta[property="og:image"]')?.getAttribute('content') ??
      undefined,
  }
}

export async function captureUrl(
  url: string,
  onProgress?: (msg: string) => void,
  range?: ChapterRange,
  cloudBackup = false,
): Promise<CaptureResult> {
  const content = await dispatchCapture(url, onProgress, range)
  return saveToLibrary(url, content, content.coverUrl ?? null, onProgress, range, cloudBackup)
}

// Persists assembled content + metadata to disk and the database. `cloudBackup`
// is the per-item opt-in (Phase 2 Decision 8): it only sets the local
// items.cloud_backup flag — the uploader is what later acts on it. Defaults to
// false so every non-cloud path (protocol capture, tests) stays local-only.
async function saveToLibrary(
  sourceUrl: string,
  content: SiteContent,
  ogImageUrl: string | null = null,
  onProgress?: (msg: string) => void,
  range?: ChapterRange,
  cloudBackup = false,
): Promise<CaptureResult> {
  const { title, author, html, textContent } = content

  const id = randomUUID()
  const contentDir = getContentDir()

  // Download cover before the transaction (network I/O, fails safely)
  const coverPath = ogImageUrl ? await downloadCover(ogImageUrl, sourceUrl, contentDir, id) : null
  const wordCount = textContent.split(/\s+/).filter(Boolean).length
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

      db.prepare(
        `
        INSERT INTO items (id, title, author, source_url, content_type, file_path, cover_path, word_count, content_hash, date_saved, date_modified, chapter_start, chapter_end, cloud_backup)
        VALUES (?, ?, ?, ?, 'article', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        id,
        title,
        author,
        sourceUrl,
        filePath,
        coverPath,
        wordCount,
        contentHash,
        now,
        now,
        range?.start ?? null,
        range?.end ?? null,
        cloudBackup ? 1 : 0,
      )

      db.prepare(
        `
        INSERT INTO items_fts (rowid, title, author, content)
        SELECT rowid, title, author, ? FROM items WHERE id = ?
      `,
      ).run(textContent, id)
      // Record the exact indexed text so a later delete/refresh is exact (H1/M1).
      indexFtsText(db, id, title, author, textContent)

      // Native AO3/FFN tags + stats (F1) → recommender tables + hybrid chips (F2).
      // No-op for non-fanfic captures (content.sourceTags is undefined).
      persistSourceTags(db, id, content.sourceTags, content.sourceMeta, siteKeyFromUrl(sourceUrl))
    })()
  } catch (err) {
    // Roll back any files written before the transaction failed
    for (const f of writtenFiles) {
      try {
        unlinkSync(f)
      } catch {}
    }
    if (coverPath) {
      try {
        unlinkSync(join(app.getPath('userData'), coverPath))
      } catch {}
    }
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
  return divs.map((d) => (d as Element).outerHTML)
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
  if (hostname.includes('archiveofourown.org')) return getAo3ChapterCount(url)
  if (hostname.includes('royalroad.com')) return getRoyalRoadChapterCount(url)
  if (hostname.includes('wattpad.com')) return getWattpadChapterCount(url)
  if (hostname.includes('scribblehub.com')) return getScribbleHubChapterCount(url)
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
  getContentDir() // ensure <userData>/content exists; paths resolved via safeContentPath

  type Row = {
    rowid: number
    source_url: string | null
    file_path: string
    chapter_start: number | null
    chapter_end: number | null
    word_count: number | null
    title: string
    author: string | null
  }
  const item = db
    .prepare(
      'SELECT rowid, source_url, file_path, chapter_start, chapter_end, word_count, title, author FROM items WHERE id = ?',
    )
    .get(itemId) as Row | undefined

  if (!item) throw new Error('Item not found.')
  if (!item.source_url) throw new Error('This item has no source URL.')
  if (item.chapter_end == null) throw new Error('This item has no chapter_end — cannot append.')

  const appendStart = item.chapter_end + 1
  if (newEnd < appendStart) throw new Error(`New end (${newEnd}) must be ≥ ${appendStart}.`)

  onProgress?.(`Fetching chapters ${appendStart}–${newEnd}…`)
  const newContent = await dispatchCapture(item.source_url, onProgress, {
    start: appendStart,
    end: newEnd,
  })

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
        readFileSync(safeContentPath(`${uuidBase}-ch${chCount}.html`), 'utf8')
        chCount++
      } catch {
        break
      }
    }

    // Read existing text from all chapter files (in order) for the FTS update.
    for (let i = 0; i < chCount; i++) {
      try {
        const chHtml = readFileSync(safeContentPath(`${uuidBase}-ch${i}.html`), 'utf8')
        existingText += new JSDOM(chHtml).window.document.body?.textContent ?? ''
        existingText += ' '
      } catch {}
    }

    // Write new chapters as additional files. Track them so a failed DB
    // transaction below can roll the files back — otherwise orphaned -chN.html
    // files inflate the next append's chapter count and duplicate chapters (T1-3).
    const writtenFiles: string[] = []
    const newChapterDivs = extractChapterDivs(newContent.html)
    if (newChapterDivs.length > 0) {
      for (let i = 0; i < newChapterDivs.length; i++) {
        const p = safeContentPath(`${uuidBase}-ch${chCount + i}.html`)
        writeFileSync(p, newChapterDivs[i], 'utf8')
        writtenFiles.push(p)
      }
    } else {
      // Fallback: treat entire new HTML as a single additional chapter
      const p = safeContentPath(`${uuidBase}-ch${chCount}.html`)
      writeFileSync(p, newContent.html, 'utf8')
      writtenFiles.push(p)
    }

    const combinedText = existingText + ' ' + newContent.textContent
    newWordCount = combinedText.split(/\s+/).filter(Boolean).length

    const now = Date.now()
    // Exact old-text delete: prefer the stored index row (H1/M1); fall back to the
    // reconstructed text for a legacy item that predates the side table.
    const oldValues = readStoredFtsText(db, itemId) ?? {
      title: item.title,
      author: item.author ?? '',
      content: existingText.trim(),
    }
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO items_fts(items_fts, rowid, title, author, content) VALUES('delete', ?, ?, ?, ?)`,
        ).run(item.rowid, oldValues.title, oldValues.author, oldValues.content)

        db.prepare(`INSERT INTO items_fts(rowid, title, author, content) VALUES(?, ?, ?, ?)`).run(
          item.rowid,
          item.title,
          item.author ?? '',
          combinedText,
        )
        indexFtsText(db, itemId, item.title, item.author, combinedText)

        db.prepare(
          'UPDATE items SET chapter_end = ?, word_count = ?, date_modified = ? WHERE id = ?',
        ).run(newEnd, newWordCount, now, itemId)
      })()
    } catch (err) {
      // Roll back the newly written chapter files so a retry starts clean.
      for (const f of writtenFiles) {
        try {
          unlinkSync(f)
        } catch {}
      }
      throw err
    }

    return { id: itemId, title: item.title, author: item.author, wordCount: newWordCount }
  }

  const existingHtml = readFileSync(safeContentPath(item.file_path), 'utf8')
  existingText = new JSDOM(existingHtml).window.document.body?.textContent ?? ''

  const combinedHtml = existingHtml + '\n' + newContent.html
  const combinedText = existingText + ' ' + newContent.textContent
  newWordCount = combinedText.split(/\s+/).filter(Boolean).length

  writeFileSync(safeContentPath(item.file_path), combinedHtml, 'utf8')

  const now = Date.now()
  const oldValues = readStoredFtsText(db, itemId) ?? {
    title: item.title,
    author: item.author ?? '',
    content: existingText,
  }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO items_fts(items_fts, rowid, title, author, content) VALUES('delete', ?, ?, ?, ?)`,
    ).run(item.rowid, oldValues.title, oldValues.author, oldValues.content)

    db.prepare(`INSERT INTO items_fts(rowid, title, author, content) VALUES(?, ?, ?, ?)`).run(
      item.rowid,
      item.title,
      item.author ?? '',
      combinedText,
    )
    indexFtsText(db, itemId, item.title, item.author, combinedText)

    db.prepare(
      'UPDATE items SET chapter_end = ?, word_count = ?, date_modified = ? WHERE id = ?',
    ).run(newEnd, newWordCount, now, itemId)
  })()

  return { id: itemId, title: item.title, author: item.author, wordCount: newWordCount }
}

// ── File import ────────────────────────────────────────────────────────────

export async function captureFile(filePath: string, cloudBackup = false): Promise<CaptureResult> {
  const ext = extname(filePath).slice(1).toLowerCase()
  if (ext === 'epub') return captureEpub(filePath, cloudBackup)
  if (ext === 'pdf') return capturePdf(filePath, cloudBackup)
  throw new Error(`Unsupported file type: .${ext}`)
}

async function captureEpub(filePath: string, cloudBackup = false): Promise<CaptureResult> {
  // Import-time gate: size cap + ZIP magic before any parse or copy (F2).
  await assertImportFile(filePath, 'epub')

  // De-dup on the raw file bytes BEFORE the expensive parse/copy/upload: an
  // identical file already in the library collapses onto that item, so a
  // re-import costs a single hash + indexed lookup, not another cloud round-trip.
  const fileHash = computeFileHash(readFileSync(filePath))
  const existing = resolveFileDuplicate(fileHash, filePath)
  if (existing) return existing

  // Parse metadata + text off-device when the user opted into cloud processing
  // (Phase 4) — the untrusted file is extracted in an isolated Cloud Run
  // container — otherwise in the sandboxed worker (F7). Either way a parse
  // crash/hang/error rejects here rather than taking down the main process; we
  // then import the (still-copied) file with fallback metadata and null word count.
  let meta: {
    title: string | null
    author: string | null
    coverBuffer: Buffer | null
    coverExt: string | null
  } = { title: null, author: null, coverBuffer: null, coverExt: null }
  let wordCount: number | null = null
  let plainText = ''
  try {
    const parsed = await resolveEpubParse(filePath)
    meta = {
      title: parsed.title,
      author: parsed.author,
      coverBuffer: parsed.coverBuffer,
      coverExt: parsed.coverExt,
    }
    plainText = parsed.plainText
    wordCount = parsed.wordCount
  } catch {
    // Worker failure is non-fatal — import the file with fallback metadata.
  }

  const id = randomUUID()
  const contentDir = getContentDir()

  const destFileName = `${id}.epub`
  const destPath = join(contentDir, destFileName)
  copyFileSync(filePath, destPath)

  let coverPath: string | null = null
  let coverFilePath: string | null = null
  if (meta.coverBuffer && meta.coverExt) {
    // coverExt is parser-supplied (untrusted — esp. the Phase-4 container's JSON
    // response), so canonicalize it to the allow-list and resolve the write via
    // safeContentPath: a hostile ext can't traverse out of content/ (SEC-4).
    const coverFile = `${id}-cover.${normalizeCoverExt(meta.coverExt)}`
    coverFilePath = safeContentPath(coverFile)
    writeFileSync(coverFilePath, meta.coverBuffer)
    coverPath = `content/${coverFile}`
  }

  const title = meta.title ?? basename(filePath, '.epub')
  const author = meta.author ?? null
  const now = Date.now()

  const db = getDb()
  try {
    db.transaction(() => {
      db.prepare(
        `
        INSERT INTO items (id, title, author, source_url, content_type, file_path, cover_path, word_count, file_hash, date_saved, date_modified, cloud_backup)
        VALUES (?, ?, ?, NULL, 'epub', ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        id,
        title,
        author,
        destFileName,
        coverPath,
        wordCount,
        fileHash,
        now,
        now,
        cloudBackup ? 1 : 0,
      )

      db.prepare(
        `
        INSERT INTO items_fts (rowid, title, author, content)
        SELECT rowid, title, author, ? FROM items WHERE id = ?
      `,
      ).run(plainText, id)
      indexFtsText(db, id, title, author, plainText) // exact-delete support (H1/M1)
    })()
  } catch (err) {
    try {
      unlinkSync(destPath)
    } catch {}
    if (coverFilePath) {
      try {
        unlinkSync(coverFilePath)
      } catch {}
    }
    throw err
  }

  return { id, title, author, wordCount }
}

async function capturePdf(filePath: string, cloudBackup = false): Promise<CaptureResult> {
  // Import-time gate: size cap + %PDF- magic before any parse or copy (F2).
  await assertImportFile(filePath, 'pdf')

  // De-dup on the raw file bytes before parse/copy/upload (see captureEpub).
  const fileHash = computeFileHash(readFileSync(filePath))
  const existing = resolveFileDuplicate(fileHash, filePath)
  if (existing) return existing

  const id = randomUUID()
  const contentDir = getContentDir()

  const destFileName = `${id}.pdf`
  const destPath = join(contentDir, destFileName)
  copyFileSync(filePath, destPath)

  const title = basename(filePath, '.pdf')
  const now = Date.now()

  // Extract text for word count and FTS off-device when the user opted into cloud
  // processing (Phase 4) — the untrusted PDF is parsed in an isolated Cloud Run
  // container — otherwise via the shared local pdf.js extractor (which runs in
  // main; pdf.js text extraction needs no F7 worker). Both paths converge on the
  // same F3-hardened extractPdf, and both are best-effort: an image-only/encrypted
  // PDF yields empty text + null word count rather than aborting the import.
  const { plainText, wordCount } = await resolvePdfParse(filePath)

  const db = getDb()
  try {
    db.transaction(() => {
      db.prepare(
        `
        INSERT INTO items (id, title, author, source_url, content_type, file_path, cover_path, word_count, file_hash, date_saved, date_modified, cloud_backup)
        VALUES (?, ?, NULL, NULL, 'pdf', ?, NULL, ?, ?, ?, ?, ?)
      `,
      ).run(id, title, destFileName, wordCount, fileHash, now, now, cloudBackup ? 1 : 0)

      db.prepare(
        `
        INSERT INTO items_fts (rowid, title, author, content)
        SELECT rowid, title, author, ? FROM items WHERE id = ?
      `,
      ).run(plainText, id)
      indexFtsText(db, id, title, null, plainText) // exact-delete support (H1/M1)
    })()
  } catch (err) {
    try {
      unlinkSync(destPath)
    } catch {}
    throw err
  }

  return { id, title, author: null, wordCount }
}

// ── Cover image download ───────────────────────────────────────────────────

async function downloadCover(
  ogImageUrl: string,
  pageUrl: string,
  contentDir: string,
  id: string,
): Promise<string | null> {
  try {
    const absoluteUrl = new URL(ogImageUrl, pageUrl).href
    if (absoluteUrl.startsWith('data:')) return null

    // og:image is page-controlled — SSRF-guard it (F4). safeFetch rejects
    // private/internal hosts and re-validates on redirects; the surrounding
    // try/catch turns any rejection into "no cover" (non-fatal).
    const res = await safeFetch(absoluteUrl, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalLibrary/1.0; personal-use)' },
    })
    if (!res.ok) return null

    const contentType = res.headers.get('content-type') ?? ''
    const ext =
      extFromContentType(contentType) ?? (extname(new URL(absoluteUrl).pathname).slice(1) || 'jpg')
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
  if (ct.includes('png')) return 'png'
  if (ct.includes('gif')) return 'gif'
  if (ct.includes('webp')) return 'webp'
  if (ct.includes('avif')) return 'avif'
  return null
}
