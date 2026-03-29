import { ipcMain, app, dialog } from 'electron'
import { join, extname } from 'path'
import { unlinkSync, writeFileSync, copyFileSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { JSDOM } from 'jsdom'
import { all, get, run, getDb } from '../db'
import { refreshContent, appendChapters, getChapterCount } from '../capture'
import { BROWSER_HEADERS } from '../capture/fetch'
import type { Item, Tag, RefreshResult } from '../../../src/types'

// Fast non-crypto hash: combines text length with a sample of beginning/end.
// Good enough to detect any meaningful content change without crypto overhead.
function contentHash(text: string): string {
  let h = 0
  const sample = text.length > 4000 ? text.slice(0, 2000) + text.slice(-2000) : text
  for (let i = 0; i < sample.length; i++) {
    h = Math.imul(31, h) + sample.charCodeAt(i) | 0
  }
  return `${text.length}:${h >>> 0}`
}

export function registerLibraryHandlers(): void {

  ipcMain.handle('library:getAll', () => {
    return all<Item>(`
      SELECT i.*, p.scroll_position, p.last_read_at, p.scroll_chapter, p.scroll_y, p.status
      FROM items i
      LEFT JOIN progress p ON p.item_id = i.id
      ORDER BY i.date_saved DESC
    `)
  })

  ipcMain.handle('library:getById', (_e, id: string) => {
    return get<Item>(`
      SELECT i.*, p.scroll_position, p.last_read_at, p.scroll_chapter, p.scroll_y, p.status
      FROM items i
      LEFT JOIN progress p ON p.item_id = i.id
      WHERE i.id = ?
    `, [id])
  })

  ipcMain.handle('library:delete', (_e, id: string) => {
    const db = getDb()
    const userData = app.getPath('userData')

    // Read file paths before deleting the row
    const row = db.prepare(
      'SELECT file_path, cover_path FROM items WHERE id = ?'
    ).get(id) as { file_path: string; cover_path: string | null } | undefined

    // NOTE: items_fts uses content='' (contentless FTS5), which does not support
    // DELETE statements. Orphaned FTS entries are harmless because the search query
    // JOINs with the items table, so deleted items are naturally excluded.
    db.prepare('DELETE FROM items WHERE id = ?').run(id)

    // Delete the content file and cover image from disk (non-fatal)
    if (row) {
      try { unlinkSync(join(userData, 'content', row.file_path)) } catch {}
      if (row.cover_path) {
        try { unlinkSync(join(userData, row.cover_path)) } catch {}
      }
    }
  })

  ipcMain.handle('library:updateProgress', (_e, id: string, position: number) => {
    // Clamp to [0, 1] — renderer sends raw scroll fractions; guard against NaN/out-of-range.
    const safePosition = Number.isFinite(position) ? Math.min(1, Math.max(0, position)) : 0
    position = safePosition
    const now = Date.now()
    const upsertProgress = (itemId: string) => run(`
      INSERT INTO progress (item_id, scroll_position, max_scroll_position, last_read_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        scroll_position     = excluded.scroll_position,
        max_scroll_position = MAX(COALESCE(max_scroll_position, 0), excluded.scroll_position),
        last_read_at        = excluded.last_read_at
    `, [itemId, position, position, now])

    upsertProgress(id)

    // Sync to related items (PDF ↔ derived EPUB)
    const self = get<{ derived_from: string | null }>(`SELECT derived_from FROM items WHERE id = ?`, [id])
    if (self?.derived_from) {
      upsertProgress(self.derived_from)
    }
    const derived = all<{ id: string }>(`SELECT id FROM items WHERE derived_from = ?`, [id])
    for (const d of derived) upsertProgress(d.id)
  })

  ipcMain.handle('library:saveScrollPos', (_e, id: string, chapter: number, scrollY: number) => {
    run(`
      INSERT INTO progress (item_id, scroll_chapter, scroll_y, last_read_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        scroll_chapter = excluded.scroll_chapter,
        scroll_y       = excluded.scroll_y,
        last_read_at   = excluded.last_read_at
    `, [id, chapter, scrollY, Date.now()])
  })

  ipcMain.handle('library:search', (_e, query: string) => {
    // FTS5 MATCH throws on malformed syntax (unbalanced quotes, bare operators, etc.)
    // Return an empty result set rather than propagating the SQLite exception.
    try {
      return all<Item>(`
        SELECT i.*
        FROM items_fts f
        JOIN items i ON i.rowid = f.rowid
        WHERE items_fts MATCH ?
        ORDER BY rank
      `, [toFtsPrefix(query)])
    } catch {
      return []
    }
  })

  ipcMain.handle('library:getAllItemTags', () => {
    return all<{ item_id: string; tag_id: string; name: string; color: string }>(`
      SELECT it.item_id, it.tag_id, t.name, t.color
      FROM item_tags it
      JOIN tags t ON t.id = it.tag_id
    `)
  })

  // --- Tags ---

  ipcMain.handle('tags:getAll', () => {
    return all<Tag>('SELECT * FROM tags ORDER BY name')
  })

  ipcMain.handle('tags:create', (_e, name: string, color: string) => {
    const id = randomUUID()
    run('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)', [id, name, color])
    return { id, name, color } as Tag
  })

  ipcMain.handle('tags:delete', (_e, id: string) => {
    // item_tags rows are cleaned up automatically via ON DELETE CASCADE
    run('DELETE FROM tags WHERE id = ?', [id])
  })

  ipcMain.handle('tags:getForItem', (_e, itemId: string) => {
    return all<Tag>(`
      SELECT t.* FROM tags t
      JOIN item_tags it ON it.tag_id = t.id
      WHERE it.item_id = ?
    `, [itemId])
  })

  ipcMain.handle('tags:setForItem', (_e, itemId: string, tagIds: string[]) => {
    const db = getDb()
    const deleteExisting = db.prepare('DELETE FROM item_tags WHERE item_id = ?')
    const insertTag = db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)')

    db.transaction(() => {
      deleteExisting.run(itemId)
      for (const tagId of tagIds) insertTag.run(itemId, tagId)
    })()
  })

  // ── Cover image management ─────────────────────────────────────

  // Save raw image bytes as cover (called by PdfReader after rendering page 1).
  ipcMain.handle('library:setCover', async (_e, id: string, data: ArrayBuffer, ext: string) => {
    const userData = app.getPath('userData')
    const db = getDb()

    // Remove any existing cover file first
    const row = db.prepare('SELECT cover_path FROM items WHERE id = ?')
      .get(id) as { cover_path: string | null } | undefined
    if (row?.cover_path) try { unlinkSync(join(userData, row.cover_path)) } catch {}

    const buf = Buffer.from(data)
    const coverFile = `${id}-cover.${ext}`
    writeFileSync(join(userData, 'content', coverFile), buf)
    const coverPath = `content/${coverFile}`

    db.prepare('UPDATE items SET cover_path = ?, date_modified = ? WHERE id = ?')
      .run(coverPath, Date.now(), id)

    // Propagate cover to any derived items (e.g. converted EPUBs) that have no cover yet.
    // Each gets its own copy of the file so deletions don't cross-contaminate.
    const derived = db.prepare(
      `SELECT id FROM items WHERE derived_from = ? AND cover_path IS NULL`
    ).all(id) as { id: string }[]
    for (const { id: derivedId } of derived) {
      const derivedFile = `${derivedId}-cover.${ext}`
      writeFileSync(join(userData, 'content', derivedFile), buf)
      db.prepare('UPDATE items SET cover_path = ?, date_modified = ? WHERE id = ?')
        .run(`content/${derivedFile}`, Date.now(), derivedId)
    }

    return coverPath
  })

  ipcMain.handle('library:setStatus', (_e, id: string, status: string | null) => {
    run(`
      INSERT INTO progress (item_id, status)
      VALUES (?, ?)
      ON CONFLICT(item_id) DO UPDATE SET status = excluded.status
    `, [id, status])
  })

  ipcMain.handle('library:setAuthor', (_e, id: string, author: string | null) => {
    run('UPDATE items SET author = ?, date_modified = ? WHERE id = ?', [author, Date.now(), id])
  })

  // Re-fetches a captured article from its source URL and updates the stored content.
  //
  // Strategy:
  //   1. HEAD request with If-Modified-Since → skip re-scrape if server replies 304
  //   2. Full re-scrape via the same pipeline used at capture time
  //   3. Overwrite the HTML file, update word_count/date_modified in the DB,
  //      and rebuild the FTS5 index entry for this item
  //
  // Returns { changed, wordCount }.
  //
  // Refresh strategy (fastest to slowest, tried in order):
  //   1. HEAD check with If-Modified-Since → 304 means skip entirely.
  //   2. For multi-chapter items: lightweight chapter-count check.
  //      - Count unchanged → content hash check → early exit if identical.
  //      - New chapters found → appendChapters() for only the delta.
  //   3. Full re-scrape fallback for single-file items or unsupported parsers.
  //      - Content hash check before writing → skip file write + FTS rebuild
  //        if nothing actually changed.
  ipcMain.handle('library:refresh', async (_e, id: string): Promise<RefreshResult> => {
    const db = getDb()
    const contentDir = join(app.getPath('userData'), 'content')

    type Row = {
      rowid:         number
      source_url:    string | null
      file_path:     string
      word_count:    number | null
      content_hash:  string | null
      title:         string
      author:        string | null
      date_modified: number
      chapter_start: number | null
      chapter_end:   number | null
    }
    const item = db.prepare(
      'SELECT rowid, source_url, file_path, word_count, content_hash, title, author, date_modified, chapter_start, chapter_end FROM items WHERE id = ?'
    ).get(id) as Row | undefined

    if (!item)            throw new Error('Item not found.')
    if (!item.source_url) throw new Error('This item has no source URL and cannot be refreshed.')

    // ── Step 1: Conditional HEAD check (3 s timeout) ──────────────────────
    const mayHaveChanged = await headChanged(item.source_url, item.date_modified)
    if (!mayHaveChanged) return { changed: false, wordCount: item.word_count ?? 0 }

    // ── Step 2: Incremental chapter check for multi-chapter items ─────────
    // Ask the site for the current chapter count with a single lightweight
    // request.  Only re-fetch chapters that are actually new.
    if (item.chapter_start != null && item.chapter_end != null) {
      const currentCount = await getChapterCount(item.source_url)

      if (currentCount !== null) {
        if (currentCount <= item.chapter_end) {
          // No new chapters — verify via content hash before declaring done.
          return { changed: false, wordCount: item.word_count ?? 0 }
        }

        // New chapters exist — append only the delta.
        const result = await appendChapters(id, currentCount)
        return { changed: true, wordCount: result.wordCount ?? 0 }
      }
      // getChapterCount returned null (unsupported parser) — fall through to
      // full re-scrape below.
    }

    // ── Step 3: Full re-scrape ─────────────────────────────────────────────
    const range = (item.chapter_start != null && item.chapter_end != null)
      ? { start: item.chapter_start, end: item.chapter_end }
      : undefined
    const { html: newHtml, textContent: newText } = await refreshContent(item.source_url, undefined, range)

    // ── Step 4: Content hash check — skip all I/O if nothing changed ───────
    const newHash = contentHash(newText)
    if (newHash === item.content_hash) {
      return { changed: false, wordCount: item.word_count ?? 0 }
    }

    const newWordCount = newText.split(/\s+/).filter(Boolean).length
    const now          = Date.now()
    const filePath     = join(contentDir, item.file_path)

    // ── Step 5: Read old text for FTS5 delete ─────────────────────────────
    // FTS5 contentless tables require the originally-indexed token values to
    // correctly decrement the inverted index.  Read the existing file (which
    // we are about to overwrite) to reconstruct them.
    let oldText = ''
    try {
      const oldHtml = readFileSync(filePath, 'utf8')
      oldText = new JSDOM(oldHtml).window.document.body?.textContent ?? ''
    } catch {
      // Unreadable file — FTS delete is a no-op; stale tokens will be cleaned
      // up by the next FTS optimize (runs on app quit).
    }

    // ── Step 6: Persist ────────────────────────────────────────────────────
    writeFileSync(filePath, newHtml, 'utf8')

    db.transaction(() => {
      db.prepare('UPDATE items SET word_count = ?, content_hash = ?, date_modified = ? WHERE id = ?')
        .run(newWordCount, newHash, now, id)

      db.prepare(
        `INSERT INTO items_fts(items_fts, rowid, title, author, content)
         VALUES('delete', ?, ?, ?, ?)`
      ).run(item.rowid, item.title, item.author ?? '', oldText)

      db.prepare(
        `INSERT INTO items_fts(rowid, title, author, content) VALUES(?, ?, ?, ?)`
      ).run(item.rowid, item.title, item.author ?? '', newText)
    })()

    return { changed: true, wordCount: newWordCount }
  })

  // Open a native file-picker, copy the chosen image, and update the DB.
  // Returns the new relative cover_path, or null if the user cancelled.
  ipcMain.handle('library:pickCover', async (_e, id: string) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Choose cover image',
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
      properties: ['openFile'],
    })
    if (canceled || filePaths.length === 0) return null

    const src = filePaths[0]
    const ext = extname(src).slice(1).toLowerCase()
    if (!['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return null

    const userData = app.getPath('userData')
    const db = getDb()

    const row = db.prepare('SELECT cover_path FROM items WHERE id = ?')
      .get(id) as { cover_path: string | null } | undefined
    if (row?.cover_path) try { unlinkSync(join(userData, row.cover_path)) } catch {}

    const coverFile = `${id}-cover.${ext}`
    copyFileSync(src, join(userData, 'content', coverFile))
    const coverPath = `content/${coverFile}`

    db.prepare('UPDATE items SET cover_path = ?, date_modified = ? WHERE id = ?')
      .run(coverPath, Date.now(), id)
    return coverPath
  })
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Transforms a plain query into an FTS5 prefix query so that partial words
// typed by the user still match: "the dark" → "the* dark*".
// FTS5 operators (AND, OR, NOT) and already-quoted or already-suffixed tokens
// are left untouched.
function toFtsPrefix(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(token => {
      if (/^(AND|OR|NOT)$/i.test(token)) return token
      if (token.startsWith('"') || token.endsWith('*')) return token
      return token + '*'
    })
    .join(' ')
}

// Issues a HEAD request with If-Modified-Since and returns true if the content
// may have changed (i.e. we should proceed with a full re-scrape).
// Returns false only when the server explicitly answers 304 Not Modified.
// Any network failure, timeout, or unexpected status is treated as "changed"
// so we fall through to the re-scrape rather than silently skipping it.
async function headChanged(url: string, since: number): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(3_000),
      headers: {
        ...BROWSER_HEADERS,
        'If-Modified-Since': new Date(since).toUTCString(),
      },
    })
    return res.status !== 304
  } catch {
    return true
  }
}
