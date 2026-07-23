import { ipcMain, app } from 'electron'
import { join, extname } from 'path'
import { writeFileSync, unlinkSync, mkdirSync, copyFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { safeUserDataPath, safeContentPath } from '../security/paths'
// epub-gen-memory's CJS build exports the generator at module.exports.default.
// Using require() avoids Rollup's _interopNamespaceDefault wrapping, which
// would set .default to the whole module object rather than the function.
type EpubGen = (opts: object, chapters: object[]) => Promise<Buffer>
// eslint-disable-next-line @typescript-eslint/no-require-imports
const epub = (require('epub-gen-memory') as { default: EpubGen }).default
import { get, getDb } from '../db'
import { indexFtsText } from '../db/ftsText'
import type { Item, ConvertPayload, ConvertResult } from '../../../src/types'

export function registerConvertHandlers(): void {
  ipcMain.handle('convert:pdfToEpub', async (_e, payload: ConvertPayload) => {
    const { itemId, chapters } = payload
    const db = getDb()
    const userData = app.getPath('userData')
    const contentDir = join(userData, 'content')
    mkdirSync(contentDir, { recursive: true })

    // Look up original PDF item for title / author / cover
    const item = get<Item>(
      `
      SELECT * FROM items WHERE id = ?
    `,
      [itemId],
    )
    if (!item) throw new Error('Item not found.')
    if (item.content_type !== 'pdf') throw new Error('Item is not a PDF.')

    // Extract plain text from chapter HTML for FTS indexing and word count
    const plainText = chapters
      .map((ch) =>
        ch.content
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .join(' ')
    const wordCount = plainText.split(/\s+/).filter(Boolean).length

    // Build EPUB buffer in memory
    const epubBuffer = (await epub(
      { title: item.title, author: item.author ?? undefined, version: 3 },
      chapters,
    )) as Buffer

    const newId = randomUUID()
    const epubFile = `${newId}.epub`
    const epubPath = join(contentDir, epubFile)
    const now = Date.now()

    // L1 — give the converted EPUB its OWN copy of the cover file. Inheriting the
    // PDF's cover_path string verbatim shares one file between two items, so
    // deleting either item (or re-covering one) unlinks the other's cover too. Copy
    // it under the new id; if the source is missing/unreadable the EPUB just starts
    // coverless (the reader can set one later).
    let coverPath: string | null = null
    if (item.cover_path) {
      const ext = extname(item.cover_path).slice(1).toLowerCase() || 'jpg'
      const coverFile = `${newId}-cover.${ext}`
      try {
        copyFileSync(safeUserDataPath(item.cover_path), safeContentPath(coverFile))
        coverPath = `content/${coverFile}`
      } catch {
        coverPath = null
      }
    }

    // Write file + insert DB row atomically
    try {
      db.transaction(() => {
        writeFileSync(epubPath, epubBuffer)

        db.prepare(
          `
          INSERT INTO items
            (id, title, author, source_url, content_type, file_path,
             cover_path, word_count, description, date_saved, date_modified, derived_from)
          VALUES (?, ?, ?, NULL, 'epub', ?, ?, ?, NULL, ?, ?, ?)
        `,
        ).run(newId, item.title, item.author, epubFile, coverPath, wordCount, now, now, itemId)

        // Update FTS index with chapter plain text so converted EPUBs appear in search
        db.prepare(
          `
          INSERT INTO items_fts (rowid, title, author, content)
          SELECT rowid, title, author, ? FROM items WHERE id = ?
        `,
        ).run(plainText, newId)
        indexFtsText(db, newId, item.title, item.author, plainText) // exact-delete support (H1/M1)
      })()
    } catch (err) {
      try {
        unlinkSync(epubPath)
      } catch {}
      if (coverPath)
        try {
          unlinkSync(safeContentPath(coverPath.replace(/^content\//, '')))
        } catch {}
      throw err
    }

    return { id: newId, title: item.title } as ConvertResult
  })
}
