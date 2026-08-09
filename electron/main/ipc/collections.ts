import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { all, run, getDb } from '../db'
import { NAME_TOMB_SEP_SQL } from '../db/nameTombstone'
import { notifyLocalMutation } from '../cloud/sync/syncService'
import type { Collection, Item } from '../../../src/types'

export function registerCollectionHandlers(): void {
  ipcMain.handle('collections:getAll', () => {
    return all<Collection>('SELECT * FROM collections WHERE deleted_at IS NULL ORDER BY name')
  })

  ipcMain.handle('collections:create', (_e, name: string) => {
    const id = randomUUID()
    const now = Date.now()
    run('INSERT INTO collections (id, name, date_created, updated_at) VALUES (?, ?, ?, ?)', [
      id,
      name,
      now,
      now,
    ])
    notifyLocalMutation()
    return { id, name, date_created: now } as Collection
  })

  ipcMain.handle('collections:delete', (_e, id: string) => {
    // Soft-delete (propagating tombstone). Suffix the name (Postgres-safe separator,
    // see nameTombstone) to free the local UNIQUE(name) slot (R6), and tombstone this
    // collection's membership rows (they used to go via ON DELETE CASCADE).
    const now = Date.now()
    getDb().transaction(() => {
      run(
        `UPDATE collections SET deleted_at = ?, updated_at = ?, dirty = 1, name = name || ${NAME_TOMB_SEP_SQL} || id WHERE id = ?`,
        [now, now, id],
      )
      run(
        `UPDATE collection_items SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE collection_id = ? AND deleted_at IS NULL`,
        [now, now, id],
      )
    })()
    notifyLocalMutation()
  })

  ipcMain.handle('collections:rename', (_e, id: string, name: string) => {
    run('UPDATE collections SET name = ?, updated_at = ?, dirty = 1 WHERE id = ?', [
      name,
      Date.now(),
      id,
    ])
    notifyLocalMutation()
  })

  ipcMain.handle('collections:getAllItemCollections', () => {
    return all<{ item_id: string; collection_id: string; name: string }>(`
      SELECT ci.item_id, ci.collection_id, c.name
      FROM collection_items ci
      JOIN collections c ON c.id = ci.collection_id
      JOIN items i ON i.id = ci.item_id
      WHERE i.deleted_at IS NULL AND ci.deleted_at IS NULL AND c.deleted_at IS NULL
    `)
  })

  ipcMain.handle('collections:getItems', (_e, collectionId: string) => {
    return all<Item>(
      `
      SELECT i.*, p.scroll_position, p.last_read_at, p.scroll_chapter, p.scroll_y, p.status
      FROM items i
      JOIN collection_items ci ON ci.item_id = i.id
      LEFT JOIN progress p ON p.item_id = i.id
      WHERE ci.collection_id = ? AND i.deleted_at IS NULL AND ci.deleted_at IS NULL
      ORDER BY ci.sort_order ASC NULLS LAST, ci.rowid ASC
    `,
      [collectionId],
    )
  })

  ipcMain.handle('collections:addItem', (_e, collectionId: string, itemId: string) => {
    const db = getDb()
    const now = Date.now()
    db.transaction(() => {
      // Next position among LIVE members only (a tombstoned membership doesn't hold a slot).
      const row = db
        .prepare(
          'SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM collection_items WHERE collection_id = ? AND deleted_at IS NULL',
        )
        .get([collectionId]) as { max_order: number }
      // Upsert-revive: re-adding a previously-removed item flips its tombstone live.
      db.prepare(
        `INSERT INTO collection_items (collection_id, item_id, sort_order, updated_at, dirty) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(collection_id, item_id) DO UPDATE SET
           deleted_at = NULL, sort_order = excluded.sort_order, updated_at = excluded.updated_at, dirty = 1`,
      ).run(collectionId, itemId, row.max_order + 1, now)
    })()
    notifyLocalMutation()
  })

  ipcMain.handle('collections:removeItem', (_e, collectionId: string, itemId: string) => {
    const now = Date.now()
    run(
      'UPDATE collection_items SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE collection_id = ? AND item_id = ? AND deleted_at IS NULL',
      [now, now, collectionId, itemId],
    )
    notifyLocalMutation()
  })

  ipcMain.handle('collections:reorderItems', (_e, collectionId: string, itemIds: string[]) => {
    const db = getDb()
    const now = Date.now()
    const stmt = db.prepare(
      'UPDATE collection_items SET sort_order = ?, updated_at = ?, dirty = 1 WHERE collection_id = ? AND item_id = ?',
    )
    db.transaction(() => {
      itemIds.forEach((id, i) => stmt.run(i, now, collectionId, id))
    })()
    notifyLocalMutation()
  })

  ipcMain.handle('collections:setForItem', (_e, itemId: string, collectionIds: string[]) => {
    const db = getDb()
    const now = Date.now()
    // Preserve prior positions (incl. tombstoned rows) so a revive restores order.
    const existing = db
      .prepare('SELECT collection_id, sort_order FROM collection_items WHERE item_id = ?')
      .all([itemId]) as { collection_id: string; sort_order: number | null }[]
    const savedOrders = new Map(existing.map((r) => [r.collection_id, r.sort_order]))

    const tombstoneAll = db.prepare(
      'UPDATE collection_items SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE item_id = ? AND deleted_at IS NULL',
    )
    const upsert = db.prepare(
      `INSERT INTO collection_items (collection_id, item_id, sort_order, updated_at, dirty) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(collection_id, item_id) DO UPDATE SET
         deleted_at = NULL, sort_order = excluded.sort_order, updated_at = excluded.updated_at, dirty = 1`,
    )
    db.transaction(() => {
      tombstoneAll.run(now, now, itemId)
      for (const cid of collectionIds) upsert.run(cid, itemId, savedOrders.get(cid) ?? null, now)
    })()
    notifyLocalMutation()
  })
}
