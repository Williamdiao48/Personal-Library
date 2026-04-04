import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { all, get, run } from '../db'
import type { Annotation, CreateAnnotationPayload } from '../../../src/types'

export function registerAnnotationHandlers(): void {

  ipcMain.handle('annotations:getForItem', (_e, itemId: string) => {
    return all<Annotation>(`
      SELECT * FROM annotations
      WHERE item_id = ?
      ORDER BY chapter_index NULLS FIRST, position ASC, created_at ASC
    `, [itemId])
  })

  ipcMain.handle('annotations:create', (_e, payload: CreateAnnotationPayload) => {
    const id = randomUUID()
    const now = Date.now()
    run(`
      INSERT INTO annotations
        (id, item_id, type, chapter_index, position, selected_text, context_before, context_after, note_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    ])
    return get<Annotation>('SELECT * FROM annotations WHERE id = ?', [id])
  })

  ipcMain.handle('annotations:updateNote', (_e, id: string, noteText: string | null) => {
    run('UPDATE annotations SET note_text = ? WHERE id = ?', [noteText, id])
  })

  ipcMain.handle('annotations:delete', (_e, id: string) => {
    run('DELETE FROM annotations WHERE id = ?', [id])
  })
}
