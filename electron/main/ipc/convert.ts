import { ipcMain, app } from 'electron'
import { join } from 'path'
import { writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
// epub-gen-memory's CJS build exports the generator at module.exports.default.
// Using require() avoids Rollup's _interopNamespaceDefault wrapping, which
// would set .default to the whole module object rather than the function.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const epub = (require('epub-gen-memory') as { default: (opts: object, chapters: object[]) => Promise<Buffer> }).default
import { get, getDb } from '../db'
import type { Item, ConvertPayload, ConvertResult } from '../../../src/types'

export function registerConvertHandlers(): void {

  ipcMain.handle('convert:pdfToEpub', async (_e, payload: ConvertPayload) => {
    const { itemId, chapters } = payload
    const db         = getDb()
    const userData   = app.getPath('userData')
    const contentDir = join(userData, 'content')
    mkdirSync(contentDir, { recursive: true })

    // Look up original PDF item for title / author / cover
    const item = get<Item>(`
      SELECT * FROM items WHERE id = ?
    `, [itemId])
    if (!item)                       throw new Error('Item not found.')
    if (item.content_type !== 'pdf') throw new Error('Item is not a PDF.')

    // Build EPUB buffer in memory
    const epubBuffer = await epub(
      { title: item.title, author: item.author ?? undefined, version: 3 },
      chapters,
    ) as Buffer

    const newId    = randomUUID()
    const epubFile = `${newId}.epub`
    const epubPath = join(contentDir, epubFile)
    const now      = Date.now()

    // Write file + insert DB row atomically
    try {
      db.transaction(() => {
        writeFileSync(epubPath, epubBuffer)

        db.prepare(`
          INSERT INTO items
            (id, title, author, source_url, content_type, file_path,
             cover_path, word_count, description, date_saved, date_modified, derived_from)
          VALUES (?, ?, ?, NULL, 'epub', ?, ?, NULL, NULL, ?, ?, ?)
        `).run(newId, item.title, item.author, epubFile, item.cover_path, now, now, itemId)

        // Update FTS index
        db.prepare(`
          INSERT INTO items_fts (rowid, title, author, content)
          SELECT rowid, title, author, '' FROM items WHERE id = ?
        `).run(newId)
      })()
    } catch (err) {
      try { unlinkSync(epubPath) } catch {}
      throw err
    }

    return { id: newId, title: item.title } as ConvertResult
  })

}
