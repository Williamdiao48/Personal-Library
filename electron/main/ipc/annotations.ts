import { ipcMain, dialog } from 'electron'
import { randomUUID } from 'crypto'
import { writeFileSync } from 'fs'
import { all, get, run, getDb } from '../db'
import type {
  Annotation,
  AnnotationTheme,
  AnnotationWithSource,
  CreateAnnotationPayload,
  ExportQuoteRow,
} from '../../../src/types'

// ── Theme attachment ────────────────────────────────────────────────────────

/** Mutates each row, populating `.themes` from annotation_theme_links. One query
 *  for the whole batch (annotation volume is small). */
function attachThemes(rows: Array<Annotation & { themes?: AnnotationTheme[] }>): void {
  for (const r of rows) r.themes = []
  if (rows.length === 0) return
  const placeholders = rows.map(() => '?').join(',')
  const links = all<{ annotation_id: string; id: string; name: string; created_at: number }>(
    `SELECT l.annotation_id, t.id, t.name, t.created_at
       FROM annotation_theme_links l
       JOIN annotation_themes t ON t.id = l.theme_id
      WHERE l.annotation_id IN (${placeholders})
      ORDER BY t.name`,
    rows.map((r) => r.id),
  )
  const byAnnotation = new Map<string, AnnotationTheme[]>()
  for (const link of links) {
    const arr = byAnnotation.get(link.annotation_id) ?? []
    arr.push({ id: link.id, name: link.name, created_at: link.created_at })
    byAnnotation.set(link.annotation_id, arr)
  }
  for (const r of rows) r.themes = byAnnotation.get(r.id) ?? []
}

// ── Export formatting (pure — exported for tests) ───────────────────────────

function citation(r: ExportQuoteRow): string {
  return [r.title ? `*${r.title}*` : null, r.author, r.chapterLabel].filter(Boolean).join(', ')
}

function tags(r: ExportQuoteRow): string {
  const parts: string[] = []
  if (r.category) parts.push(`[${r.category}]`)
  for (const t of r.themes) parts.push(`#${t.trim().replace(/\s+/g, '-')}`)
  return parts.join(' ')
}

export function toMarkdown(rows: ExportQuoteRow[]): string {
  return rows
    .map((r) => {
      const lines: string[] = []
      if (r.text) lines.push(`> ${r.text.replace(/\n/g, '\n> ')}`)
      const meta = [citation(r), tags(r)].filter(Boolean).join('  ')
      if (meta) lines.push(`— ${meta}`)
      if (r.note) lines.push(`\n${r.note}`)
      return lines.join('\n')
    })
    .join('\n\n')
    .concat('\n')
}

export function toPlainText(rows: ExportQuoteRow[]): string {
  return rows
    .map((r) => {
      const lines: string[] = []
      if (r.text) lines.push(`"${r.text}"`)
      const meta = [citation(r).replace(/\*/g, ''), tags(r)].filter(Boolean).join('  ')
      if (meta) lines.push(`  — ${meta}`)
      if (r.note) lines.push(`  Note: ${r.note}`)
      return lines.join('\n')
    })
    .join('\n\n')
    .concat('\n')
}

// ── Handlers ────────────────────────────────────────────────────────────────

export function registerAnnotationHandlers(): void {
  ipcMain.handle('annotations:getForItem', (_e, itemId: string) => {
    const rows = all<Annotation>(
      `
      SELECT * FROM annotations
      WHERE item_id = ?
      ORDER BY sort_order ASC NULLS LAST, chapter_index NULLS FIRST, position ASC, created_at ASC
    `,
      [itemId],
    )
    attachThemes(rows)
    return rows
  })

  // Every highlight/note across the (non-trashed) library, joined with its book,
  // for the cross-book Annotations hub. Bookmarks are excluded (they have no text).
  ipcMain.handle('annotations:getAll', () => {
    const rows = all<AnnotationWithSource>(
      `
      SELECT a.*, i.title AS item_title, i.author AS item_author, i.content_type AS content_type
        FROM annotations a
        JOIN items i ON i.id = a.item_id
       WHERE a.type IN ('highlight', 'note')
         AND i.deleted_at IS NULL
       ORDER BY i.title COLLATE NOCASE, a.chapter_index NULLS FIRST, a.position ASC
    `,
    )
    attachThemes(rows)
    return rows
  })

  ipcMain.handle('annotations:create', (_e, payload: CreateAnnotationPayload) => {
    const id = randomUUID()
    const now = Date.now()
    const maxRow = get<{ max_order: number | null }>(
      `SELECT MAX(sort_order) AS max_order FROM annotations WHERE item_id = ?`,
      [payload.item_id],
    )
    const sortOrder = (maxRow?.max_order ?? 0) + 1
    run(
      `
      INSERT INTO annotations
        (id, item_id, type, chapter_index, position, selected_text, context_before, context_after, note_text, color, rects, book_fraction, created_at, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        id,
        payload.item_id,
        payload.type,
        payload.chapter_index ?? null,
        payload.position,
        payload.selected_text ?? null,
        payload.context_before ?? null,
        payload.context_after ?? null,
        payload.note_text ?? null,
        payload.color ?? null,
        payload.rects ?? null,
        payload.book_fraction ?? null,
        now,
        sortOrder,
      ],
    )
    const row = get<Annotation>('SELECT * FROM annotations WHERE id = ?', [id])
    // A fresh annotation has no themes yet.
    return row ? { ...row, themes: [] } : row
  })

  ipcMain.handle('annotations:updateNote', (_e, id: string, noteText: string | null) => {
    run('UPDATE annotations SET note_text = ? WHERE id = ?', [noteText, id])
  })

  ipcMain.handle('annotations:setColor', (_e, id: string, color: string | null) => {
    run('UPDATE annotations SET color = ? WHERE id = ?', [color, id])
  })

  ipcMain.handle('annotations:setThemes', (_e, annotationId: string, themeIds: string[]) => {
    getDb().transaction(() => {
      run('DELETE FROM annotation_theme_links WHERE annotation_id = ?', [annotationId])
      for (const themeId of themeIds) {
        run(
          'INSERT OR IGNORE INTO annotation_theme_links (annotation_id, theme_id) VALUES (?, ?)',
          [annotationId, themeId],
        )
      }
    })()
  })

  ipcMain.handle('annotations:delete', (_e, id: string) => {
    run('DELETE FROM annotations WHERE id = ?', [id])
  })

  ipcMain.handle('annotations:swapSortOrder', (_e, id1: string, id2: string) => {
    getDb().transaction(() => {
      const a = get<{ sort_order: number | null }>(
        'SELECT sort_order FROM annotations WHERE id = ?',
        [id1],
      )
      const b = get<{ sort_order: number | null }>(
        'SELECT sort_order FROM annotations WHERE id = ?',
        [id2],
      )
      if (!a || !b) return
      run('UPDATE annotations SET sort_order = ? WHERE id = ?', [b.sort_order, id1])
      run('UPDATE annotations SET sort_order = ? WHERE id = ?', [a.sort_order, id2])
    })()
  })

  ipcMain.handle('annotations:exportQuotes', async (_e, rows: ExportQuoteRow[], format: string) => {
    const ext = format === 'txt' ? 'txt' : 'md'
    const content = ext === 'txt' ? toPlainText(rows) : toMarkdown(rows)
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Export annotations',
      defaultPath: `annotations.${ext}`,
      filters: [{ name: ext === 'txt' ? 'Text' : 'Markdown', extensions: [ext] }],
    })
    if (canceled || !filePath) return null
    writeFileSync(filePath, content, 'utf8')
    return filePath
  })

  // ── Theme vocabulary CRUD ─────────────────────────────────────────────────

  ipcMain.handle('annotationThemes:list', () => {
    return all<AnnotationTheme>('SELECT * FROM annotation_themes ORDER BY name COLLATE NOCASE')
  })

  ipcMain.handle('annotationThemes:create', (_e, name: string) => {
    const trimmed = name.trim()
    // Names are UNIQUE — reuse an existing theme rather than erroring.
    const existing = get<AnnotationTheme>(
      'SELECT * FROM annotation_themes WHERE name = ? COLLATE NOCASE',
      [trimmed],
    )
    if (existing) return existing
    const id = randomUUID()
    run('INSERT INTO annotation_themes (id, name, created_at) VALUES (?, ?, ?)', [
      id,
      trimmed,
      Date.now(),
    ])
    return get<AnnotationTheme>('SELECT * FROM annotation_themes WHERE id = ?', [id])
  })

  ipcMain.handle('annotationThemes:rename', (_e, id: string, name: string) => {
    run('UPDATE annotation_themes SET name = ? WHERE id = ?', [name.trim(), id])
  })

  ipcMain.handle('annotationThemes:delete', (_e, id: string) => {
    // annotation_theme_links cascade-deletes via the FK.
    run('DELETE FROM annotation_themes WHERE id = ?', [id])
  })
}
