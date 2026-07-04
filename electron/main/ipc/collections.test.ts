import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { invoke, resetIpc } from '../../../test/stubs/electron'
import {
  openTestDb,
  closeTestDb,
  seedItem,
  seedCollection,
  type TestDb,
} from '../../../test/db/harness'
import { registerCollectionHandlers } from './collections'
import type { Item } from '../../../src/types'

let db: TestDb

beforeEach(() => {
  resetIpc()
  db = openTestDb()
  registerCollectionHandlers()
})
afterEach(() => closeTestDb())

const orderOf = (collectionId: string, itemId: string): number | null =>
  (
    db
      .prepare('SELECT sort_order FROM collection_items WHERE collection_id = ? AND item_id = ?')
      .get(collectionId, itemId) as { sort_order: number | null }
  ).sort_order

describe('collections IPC — CRUD', () => {
  it('create / getAll (name-sorted) / rename / delete', async () => {
    await invoke('collections:create', 'Zeta')
    await invoke('collections:create', 'Alpha')
    let all = (await invoke('collections:getAll')) as any[]
    expect(all.map((c) => c.name)).toEqual(['Alpha', 'Zeta'])

    await invoke('collections:rename', all[0].id, 'Aardvark')
    all = (await invoke('collections:getAll')) as any[]
    expect(all.map((c) => c.name)).toEqual(['Aardvark', 'Zeta'])

    await invoke('collections:delete', all[0].id)
    expect(((await invoke('collections:getAll')) as any[]).length).toBe(1)
  })
})

describe('collections IPC — membership & ordering', () => {
  it('addItem assigns incrementing sort_order', async () => {
    const c = seedCollection(db, 'C')
    const a = seedItem(db, {})
    const b = seedItem(db, {})
    await invoke('collections:addItem', c, a)
    await invoke('collections:addItem', c, b)
    expect(orderOf(c, a)).toBe(0)
    expect(orderOf(c, b)).toBe(1)
  })

  it('getItems returns members in sort_order, excluding trashed', async () => {
    const c = seedCollection(db, 'C')
    const a = seedItem(db, { id: 'a' })
    const b = seedItem(db, { id: 'b' })
    const t = seedItem(db, { id: 't', deleted_at: 9 })
    await invoke('collections:addItem', c, a)
    await invoke('collections:addItem', c, b)
    await invoke('collections:addItem', c, t)
    await invoke('collections:reorderItems', c, ['b', 'a']) // b first now

    const items = (await invoke('collections:getItems', c)) as Item[]
    expect(items.map((i) => i.id)).toEqual(['b', 'a']) // t excluded (trashed)
  })

  it('removeItem detaches without deleting the item', async () => {
    const c = seedCollection(db, 'C')
    const a = seedItem(db, { id: 'a' })
    await invoke('collections:addItem', c, a)
    await invoke('collections:removeItem', c, a)
    expect(((await invoke('collections:getItems', c)) as Item[]).length).toBe(0)
    expect(db.prepare('SELECT COUNT(*) n FROM items').get()).toEqual({ n: 1 })
  })

  // Regression BUG-2: editing an item's collection membership must NOT reset the
  // drag-sort order of collections it stays in (v0.5.0 wiped every sort_order).
  it('regression BUG-2: setForItem preserves sort_order for retained collections', async () => {
    const c1 = seedCollection(db, 'C1')
    const c2 = seedCollection(db, 'C2')
    const item = seedItem(db, { id: 'it' })
    const other = seedItem(db, { id: 'other' })

    // Establish a deliberate ordering in c1: other=0, item=1.
    await invoke('collections:addItem', c1, other)
    await invoke('collections:addItem', c1, item)
    expect(orderOf(c1, 'it')).toBe(1)

    // Re-save membership (still in c1, newly in c2) — c1 order must be preserved.
    await invoke('collections:setForItem', 'it', [c1, c2])
    expect(orderOf(c1, 'it')).toBe(1) // preserved, not reset to NULL
  })

  // Regression BUG-3: collection listings must exclude soft-deleted items.
  it('regression BUG-3: getAllItemCollections excludes trashed items', async () => {
    const c = seedCollection(db, 'C')
    const active = seedItem(db, { id: 'active' })
    const trashed = seedItem(db, { id: 'trashed', deleted_at: 1 })
    await invoke('collections:addItem', c, active)
    await invoke('collections:addItem', c, trashed)

    const rows = (await invoke('collections:getAllItemCollections')) as any[]
    expect(rows.map((r) => r.item_id)).toEqual(['active'])
  })

  it('deleting a collection cascades its membership rows', async () => {
    const c = seedCollection(db, 'C')
    const a = seedItem(db, {})
    await invoke('collections:addItem', c, a)
    await invoke('collections:delete', c)
    expect(db.prepare('SELECT COUNT(*) n FROM collection_items').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM items').get()).toEqual({ n: 1 }) // item survives
  })
})
