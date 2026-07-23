// H1/M1 (bug overhaul 2026-07-23) — exact FTS5 delete support.
//
// items_fts is a CONTENTLESS FTS5 table (content=''), so removing a row's postings
// requires re-supplying the EXACT indexed (title, author, content); there is no
// "delete by rowid" primitive. Historically the hard-delete paths skipped FTS
// cleanup entirely (orphaned postings + rowid reuse → wrong search hits, H1), and
// refresh/append reconstructed the old text from the sanitized HTML file, which
// doesn't token-match what capture indexed (M1).
//
// Fix: `item_fts_index` mirrors exactly what was last written to items_fts. Every
// insert site records it (indexFtsText); every delete/refresh reads it back for an
// exact 'delete'. Items captured before the side table existed have no row, so the
// resolvers below reconstruct their text on demand — HTML from the stored file(s)
// (near-exact), EPUB/PDF by re-parsing the stored binary (deterministic ⇒ exact).

import type { Database } from 'better-sqlite3'
import { readFileSync } from 'fs'
import { JSDOM } from 'jsdom'
import { safeContentPath } from '../security/paths'

export interface FtsValues {
  title: string
  author: string
  content: string
}

/** The item columns the resolvers need. A subset of the `items` row. */
export interface FtsItem {
  id: string
  title: string | null
  author: string | null
  content_type: string
  file_path: string
}

/**
 * Write-side: record the exact (title, author, content) just written to items_fts,
 * so a later delete/refresh can issue an exact FTS5 'delete'. Call right after every
 * items_fts insert (capture html/epub/pdf, convert, refresh, append).
 */
export function indexFtsText(
  db: Database,
  id: string,
  title: string,
  author: string | null,
  content: string,
): void {
  db.prepare(
    `INSERT INTO item_fts_index (item_id, title, author, content)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       title = excluded.title, author = excluded.author, content = excluded.content`,
  ).run(id, title, author ?? '', content)
}

/** The exact stored index values, or undefined for a legacy item (indexed before
 *  the side table existed). */
export function readStoredFtsText(db: Database, id: string): FtsValues | undefined {
  return db
    .prepare('SELECT title, author, content FROM item_fts_index WHERE item_id = ?')
    .get(id) as FtsValues | undefined
}

/** Reconstruct a legacy HTML item's indexed text from its stored file(s). Sync
 *  (JSDOM). Near-exact vs. the original `article.textContent` (a small
 *  sanitization delta); unreadable files degrade to ''. */
function reconstructHtmlText(item: FtsItem): string {
  const isMultiChapter = /-ch\d+\.html$/.test(item.file_path)
  if (!isMultiChapter) {
    try {
      const html = readFileSync(safeContentPath(item.file_path), 'utf8')
      return new JSDOM(html).window.document.body?.textContent ?? ''
    } catch {
      return ''
    }
  }
  // Multi-chapter: concatenate every {base}-chN.html, mirroring capture/append.
  const base = item.file_path.replace(/-ch\d+\.html$/, '')
  let text = ''
  for (let i = 0; ; i++) {
    try {
      const html = readFileSync(safeContentPath(`${base}-ch${i}.html`), 'utf8')
      text += (new JSDOM(html).window.document.body?.textContent ?? '') + ' '
    } catch {
      break
    }
  }
  return text
}

/**
 * Resolve the values for an FTS 'delete', SYNC. Returns the stored row when present;
 * otherwise reconstructs HTML text from the file. Legacy EPUB/PDF (no stored row)
 * fall back to content:'' — their content postings can't be recovered synchronously.
 * Used only by the startup 30-day purge, where a rare residual is acceptable; the
 * interactive delete paths use the async resolver, which is exact for all types.
 */
export function ftsDeleteValuesSync(db: Database, item: FtsItem): FtsValues {
  const stored = readStoredFtsText(db, item.id)
  if (stored) return stored
  const content = item.content_type === 'article' ? reconstructHtmlText(item) : ''
  return { title: item.title ?? '', author: item.author ?? '', content }
}

/**
 * Resolve the values for an FTS 'delete', ASYNC and exact for ALL content types.
 * Stored row when present; else reconstruct — HTML via JSDOM, EPUB/PDF by re-parsing
 * the stored binary (deterministic, so it reproduces the originally-indexed text).
 * Parsers are lazy-imported so a legacy binary is only ever re-parsed on its (rare)
 * delete. Any failure degrades to content:'' rather than blocking the delete.
 */
export async function ftsDeleteValuesAsync(db: Database, item: FtsItem): Promise<FtsValues> {
  const stored = readStoredFtsText(db, item.id)
  if (stored) return stored
  let content = ''
  try {
    if (item.content_type === 'article') {
      content = reconstructHtmlText(item)
    } else if (item.content_type === 'epub') {
      const { parseEpub } = await import('../workers/parse-host')
      content = (await parseEpub(safeContentPath(item.file_path))).plainText
    } else if (item.content_type === 'pdf') {
      const { extractPdfText } = await import('../capture/pdfText')
      content = await extractPdfText(readFileSync(safeContentPath(item.file_path)))
    }
  } catch {
    content = '' // best-effort: an unrecoverable file still lets the delete proceed
  }
  return { title: item.title ?? '', author: item.author ?? '', content }
}

/**
 * Remove an item's postings from items_fts and drop its side-table row. Call inside
 * the same transaction as `DELETE FROM items`, after resolving `values`.
 */
export function removeFtsIndex(db: Database, rowid: number, id: string, values: FtsValues): void {
  // Only decrement postings that actually exist. A contentless-FTS 'delete' for a
  // rowid that was never indexed over-decrements the inverted index (undefined
  // behaviour per SQLite) — guard against items that failed to index at capture.
  const indexed = db.prepare('SELECT 1 FROM items_fts WHERE rowid = ?').get(rowid)
  if (indexed) {
    db.prepare(
      `INSERT INTO items_fts(items_fts, rowid, title, author, content) VALUES('delete', ?, ?, ?, ?)`,
    ).run(rowid, values.title, values.author, values.content)
  }
  db.prepare('DELETE FROM item_fts_index WHERE item_id = ?').run(id)
}
