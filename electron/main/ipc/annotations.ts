import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { all, get, run, getDb } from '../db'
import type { Annotation, CreateAnnotationPayload } from '../../../src/types'

export function registerAnnotationHandlers(): void {

  ipcMain.handle('annotations:getForItem', (_e, itemId: string) => {
    return all<Annotation>(`
      SELECT * FROM annotations
      WHERE item_id = ?
      ORDER BY sort_order ASC NULLS LAST, chapter_index NULLS FIRST, position ASC, created_at ASC
    `, [itemId])
  })

  ipcMain.handle('annotations:create', (_e, payload: CreateAnnotationPayload) => {
    const id  = randomUUID()
    const now = Date.now()
    const maxRow = get<{ max_order: number | null }>(
      `SELECT MAX(sort_order) AS max_order FROM annotations WHERE item_id = ?`,
      [payload.item_id],
    )
    const sortOrder = (maxRow?.max_order ?? 0) + 1
    run(`
      INSERT INTO annotations
        (id, item_id, type, chapter_index, position, selected_text, context_before, context_after, note_text, created_at, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      payload.item_id,
      payload.type,
      payload.chapter_index ?? null,
      payload.position,
      payload.selected_text ?? null,
      payload.context_before ?? null,
      payload.context_after ?? null,
      payload.note_text ?? null,
      now,
      sortOrder,
    ])
    return get<Annotation>('SELECT * FROM annotations WHERE id = ?', [id])
  })

  ipcMain.handle('annotations:updateNote', (_e, id: string, noteText: string | null) => {
    run('UPDATE annotations SET note_text = ? WHERE id = ?', [noteText, id])
  })

  ipcMain.handle('annotations:delete', (_e, id: string) => {
    run('DELETE FROM annotations WHERE id = ?', [id])
  })

  ipcMain.handle('annotations:swapSortOrder', (_e, id1: string, id2: string) => {
    getDb().transaction(() => {
      const a = get<{ sort_order: number | null }>('SELECT sort_order FROM annotations WHERE id = ?', [id1])
      const b = get<{ sort_order: number | null }>('SELECT sort_order FROM annotations WHERE id = ?', [id2])
      if (!a || !b) return
      run('UPDATE annotations SET sort_order = ? WHERE id = ?', [b.sort_order, id1])
      run('UPDATE annotations SET sort_order = ? WHERE id = ?', [a.sort_order, id2])
    })()
  })
}
