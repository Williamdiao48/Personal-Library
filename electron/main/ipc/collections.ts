import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { all, run, getDb } from '../db'
import type { Collection, Item } from '../../../src/types'

export function registerCollectionHandlers(): void {

  ipcMain.handle('collections:getAll', () => {
    return all<Collection>('SELECT * FROM collections ORDER BY name')
  })

  ipcMain.handle('collections:create', (_e, name: string) => {
    const id = randomUUID()
    const now = Date.now()
    run('INSERT INTO collections (id, name, date_created) VALUES (?, ?, ?)', [id, name, now])
    return { id, name, date_created: now } as Collection
  })

  ipcMain.handle('collections:delete', (_e, id: string) => {
    // collection_items rows cascade via ON DELETE CASCADE
    run('DELETE FROM collections WHERE id = ?', [id])
  })

  ipcMain.handle('collections:rename', (_e, id: string, name: string) => {
    run('UPDATE collections SET name = ? WHERE id = ?', [name, id])
  })

  ipcMain.handle('collections:getAllItemCollections', () => {
    return all<{ item_id: string; collection_id: string; name: string }>(`
      SELECT ci.item_id, ci.collection_id, c.name
      FROM collection_items ci
      JOIN collections c ON c.id = ci.collection_id
    `)
  })

  ipcMain.handle('collections:getItems', (_e, collectionId: string) => {
    return all<Item>(`
      SELECT i.*
      FROM items i
      JOIN collection_items ci ON ci.item_id = i.id
      WHERE ci.collection_id = ? AND i.deleted_at IS NULL
      ORDER BY ci.sort_order ASC NULLS LAST, ci.rowid ASC
    `, [collectionId])
  })

  ipcMain.handle('collections:addItem', (_e, collectionId: string, itemId: string) => {
    const db = getDb()
    db.transaction(() => {
      const row = db.prepare(
        'SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM collection_items WHERE collection_id = ?'
      ).get([collectionId]) as { max_order: number }
      db.prepare(
        'INSERT OR IGNORE INTO collection_items (collection_id, item_id, sort_order) VALUES (?, ?, ?)'
      ).run(collectionId, itemId, row.max_order + 1)
    })()
  })

  ipcMain.handle('collections:reorderItems', (_e, collectionId: string, itemIds: string[]) => {
    const db = getDb()
    const stmt = db.prepare(
      'UPDATE collection_items SET sort_order = ? WHERE collection_id = ? AND item_id = ?'
    )
    db.transaction(() => {
      itemIds.forEach((id, i) => stmt.run(i, collectionId, id))
    })()
  })

  ipcMain.handle('collections:setForItem', (_e, itemId: string, collectionIds: string[]) => {
    const db = getDb()
    const deleteExisting = db.prepare('DELETE FROM collection_items WHERE item_id = ?')
    const insert = db.prepare('INSERT OR IGNORE INTO collection_items (collection_id, item_id) VALUES (?, ?)')
    db.transaction(() => {
      deleteExisting.run(itemId)
      for (const cid of collectionIds) insert.run(cid, itemId)
    })()
  })
}
