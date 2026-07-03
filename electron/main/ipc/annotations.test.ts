import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { invoke, resetIpc } from '../../../test/stubs/electron'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'
import { registerAnnotationHandlers } from './annotations'

let db: TestDb

beforeEach(() => {
  resetIpc()
  db = openTestDb()
  registerAnnotationHandlers()
})
afterEach(() => closeTestDb())

describe('annotations IPC', () => {
  it('create assigns incrementing sort_order and returns the row', async () => {
    const item = seedItem(db, {})
    const a = (await invoke('annotations:create', {
      item_id: item,
      type: 'note',
      position: 0.1,
      note_text: 'first',
    })) as any
    const b = (await invoke('annotations:create', {
      item_id: item,
      type: 'highlight',
      position: 0.2,
      selected_text: 'sel',
    })) as any

    expect(a.sort_order).toBe(1)
    expect(b.sort_order).toBe(2)
    expect(a.note_text).toBe('first')
    expect(b.selected_text).toBe('sel')
  })

  it('getForItem returns annotations ordered by sort_order', async () => {
    const item = seedItem(db, {})
    await invoke('annotations:create', { item_id: item, type: 'note', position: 0.9 })
    await invoke('annotations:create', { item_id: item, type: 'note', position: 0.1 })
    const list = (await invoke('annotations:getForItem', item)) as any[]
    expect(list.map((a) => a.sort_order)).toEqual([1, 2])
  })

  it('updateNote edits note text', async () => {
    const item = seedItem(db, {})
    const a = (await invoke('annotations:create', { item_id: item, type: 'note', position: 0 })) as any
    await invoke('annotations:updateNote', a.id, 'edited')
    const list = (await invoke('annotations:getForItem', item)) as any[]
    expect(list[0].note_text).toBe('edited')
  })

  it('delete removes an annotation', async () => {
    const item = seedItem(db, {})
    const a = (await invoke('annotations:create', { item_id: item, type: 'bookmark', position: 0 })) as any
    await invoke('annotations:delete', a.id)
    expect(((await invoke('annotations:getForItem', item)) as any[]).length).toBe(0)
  })

  it('swapSortOrder exchanges the ordering of two annotations', async () => {
    const item = seedItem(db, {})
    const a = (await invoke('annotations:create', { item_id: item, type: 'note', position: 0 })) as any
    const b = (await invoke('annotations:create', { item_id: item, type: 'note', position: 0 })) as any
    expect([a.sort_order, b.sort_order]).toEqual([1, 2])

    await invoke('annotations:swapSortOrder', a.id, b.id)
    const list = (await invoke('annotations:getForItem', item)) as any[]
    // a now sorts after b
    expect(list.map((x) => x.id)).toEqual([b.id, a.id])
  })

  it('cascades on item delete (FK ON DELETE CASCADE)', async () => {
    const item = seedItem(db, {})
    await invoke('annotations:create', { item_id: item, type: 'note', position: 0 })
    db.prepare('DELETE FROM items WHERE id = ?').run(item)
    expect(db.prepare('SELECT COUNT(*) n FROM annotations').get()).toEqual({ n: 0 })
  })
})
