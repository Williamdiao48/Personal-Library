import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { invoke, resetIpc } from '../../../test/stubs/electron'
import {
  openTestDb,
  closeTestDb,
  seedItem,
  seedTag,
  tagItem,
  type TestDb,
} from '../../../test/db/harness'
import { registerLibraryHandlers } from './library'
import type { Item } from '../../../src/types'

let db: TestDb

beforeEach(() => {
  resetIpc()
  db = openTestDb()
  registerLibraryHandlers()
})
afterEach(() => closeTestDb())

// Insert a contentless-FTS row for an item so library:search can MATCH it.
function indexFts(itemId: string, content: string): void {
  const { rowid, title, author } = db
    .prepare('SELECT rowid, title, author FROM items WHERE id = ?')
    .get(itemId) as { rowid: number; title: string; author: string | null }
  db.prepare('INSERT INTO items_fts(rowid, title, author, content) VALUES(?, ?, ?, ?)').run(
    rowid,
    title,
    author ?? '',
    content,
  )
}

describe('library IPC — read & trash lifecycle', () => {
  it('getAll returns active items newest-first and excludes trashed', async () => {
    seedItem(db, { id: 'a', title: 'A', date_saved: 100 })
    seedItem(db, { id: 'b', title: 'B', date_saved: 200 })
    seedItem(db, { id: 'c', title: 'C', date_saved: 300, deleted_at: 999 })

    const items = (await invoke('library:getAll')) as Item[]
    expect(items.map((i) => i.id)).toEqual(['b', 'a']) // date_saved DESC, c trashed
  })

  it('softDelete → getTrashed → restore round-trips', async () => {
    seedItem(db, { id: 'x', title: 'X' })
    await invoke('library:softDelete', 'x')

    expect((await invoke('library:getAll') as Item[]).length).toBe(0)
    const trashed = (await invoke('library:getTrashed')) as Item[]
    expect(trashed.map((i) => i.id)).toEqual(['x'])

    await invoke('library:restore', 'x')
    expect((await invoke('library:getAll') as Item[]).map((i) => i.id)).toEqual(['x'])
    expect((await invoke('library:getTrashed') as Item[]).length).toBe(0)
  })

  it('permanentlyDelete removes the row entirely', async () => {
    seedItem(db, { id: 'gone', deleted_at: 1 })
    await invoke('library:permanentlyDelete', 'gone')
    expect(db.prepare('SELECT COUNT(*) n FROM items').get()).toEqual({ n: 0 })
  })

  it('emptyTrash deletes only trashed rows', async () => {
    seedItem(db, { id: 'keep' })
    seedItem(db, { id: 'trash1', deleted_at: 1 })
    seedItem(db, { id: 'trash2', deleted_at: 2 })
    await invoke('library:emptyTrash')
    expect(db.prepare('SELECT id FROM items').all()).toEqual([{ id: 'keep' }])
  })
})

describe('library IPC — progress & status', () => {
  it('updateProgress clamps out-of-range and NaN scroll fractions', async () => {
    seedItem(db, { id: 'p' })
    await invoke('library:updateProgress', 'p', 5) // >1
    expect(
      (db.prepare('SELECT scroll_position FROM progress WHERE item_id = ?').get('p') as any)
        .scroll_position,
    ).toBe(1)

    await invoke('library:updateProgress', 'p', Number.NaN)
    expect(
      (db.prepare('SELECT scroll_position FROM progress WHERE item_id = ?').get('p') as any)
        .scroll_position,
    ).toBe(0)
  })

  it('updateProgress syncs progress to derived items (PDF ↔ EPUB)', async () => {
    seedItem(db, { id: 'src' })
    seedItem(db, { id: 'epub' })
    db.prepare('UPDATE items SET derived_from = ? WHERE id = ?').run('src', 'epub')

    await invoke('library:updateProgress', 'src', 0.5)
    const d = db.prepare('SELECT scroll_position FROM progress WHERE item_id = ?').get('epub') as any
    expect(d.scroll_position).toBe(0.5)
  })

  it('setStatus upserts an explicit reading status', async () => {
    seedItem(db, { id: 's' })
    await invoke('library:setStatus', 's', 'finished')
    expect(
      (db.prepare('SELECT status FROM progress WHERE item_id = ?').get('s') as any).status,
    ).toBe('finished')
  })
})

describe('library IPC — metadata edits', () => {
  // Regression BUG-4: rating/review edits must bump date_modified so the item
  // re-sorts under "date saved/modified" (was omitted in v0.5.0).
  it('regression BUG-4: setRating and setReview update date_modified', async () => {
    seedItem(db, { id: 'm', date_modified: 1 })
    await invoke('library:setRating', 'm', 4)
    const afterRating = (db.prepare('SELECT rating, date_modified FROM items WHERE id = ?').get('m')) as any
    expect(afterRating.rating).toBe(4)
    expect(afterRating.date_modified).toBeGreaterThan(1)

    await invoke('library:setReview', 'm', 'good')
    const afterReview = (db.prepare('SELECT review, date_modified FROM items WHERE id = ?').get('m')) as any
    expect(afterReview.review).toBe('good')
    expect(afterReview.date_modified).toBeGreaterThan(1)
  })

  it('setTitle and setAuthor persist and bump date_modified', async () => {
    seedItem(db, { id: 't', date_modified: 1 })
    await invoke('library:setTitle', 't', 'New Title')
    await invoke('library:setAuthor', 't', 'New Author')
    const row = db.prepare('SELECT title, author, date_modified FROM items WHERE id = ?').get('t') as any
    expect(row.title).toBe('New Title')
    expect(row.author).toBe('New Author')
    expect(row.date_modified).toBeGreaterThan(1)
  })

  // SEC-2: setRating does NOT clamp to [0,5]/0.5 at the handler (relies on the
  // StarRating UI). Documented as an open hardening item — flip to a real test
  // if/when the clamp is added.
  it.todo('SEC-2: setRating should clamp rating to [0,5] with 0.5 granularity')
})

describe('library IPC — tags', () => {
  it('create / getAll / rename / setColor / delete', async () => {
    const t = (await invoke('tags:create', 'sci-fi', '#ff0000')) as any
    expect(t).toMatchObject({ name: 'sci-fi', color: '#ff0000' })

    await invoke('tags:rename', t.id, 'scifi')
    await invoke('tags:setColor', t.id, '#00ff00')
    const all = (await invoke('tags:getAll')) as any[]
    expect(all).toEqual([{ id: t.id, name: 'scifi', color: '#00ff00' }])

    await invoke('tags:delete', t.id)
    expect((await invoke('tags:getAll') as any[]).length).toBe(0)
  })

  it('setForItem replaces the tag set for an item', async () => {
    const item = seedItem(db, {})
    const a = seedTag(db, 'a')
    const b = seedTag(db, 'b')
    const c = seedTag(db, 'c')
    await invoke('tags:setForItem', item, [a, b])
    expect(((await invoke('tags:getForItem', item)) as any[]).map((t) => t.name).sort()).toEqual([
      'a',
      'b',
    ])
    // Replacing drops old, adds new.
    await invoke('tags:setForItem', item, [c])
    expect(((await invoke('tags:getForItem', item)) as any[]).map((t) => t.name)).toEqual(['c'])
  })

  // Regression BUG-3: tag listings/counts must exclude soft-deleted items.
  it('regression BUG-3: getAllItemTags and getItemCounts exclude trashed items', async () => {
    const active = seedItem(db, {})
    const trashed = seedItem(db, { deleted_at: 123 })
    const tag = seedTag(db, 'shared')
    tagItem(db, active, tag)
    tagItem(db, trashed, tag)

    const listed = (await invoke('library:getAllItemTags')) as any[]
    expect(listed.map((r) => r.item_id)).toEqual([active])

    const counts = (await invoke('tags:getItemCounts')) as any[]
    expect(counts).toEqual([{ tag_id: tag, count: 1 }]) // trashed item not counted
  })
})

describe('library IPC — FTS search', () => {
  it('matches indexed content by prefix and excludes trashed items', async () => {
    const a = seedItem(db, { id: 'sa', title: 'Dragons' })
    const b = seedItem(db, { id: 'sb', title: 'Castles', deleted_at: 5 })
    indexFts(a, 'a tale of dragons and knights')
    indexFts(b, 'a tale of dragons and castles')

    const hits = (await invoke('library:search', 'drag')) as Item[] // prefix → drag*
    expect(hits.map((i) => i.id)).toEqual(['sa']) // sb is trashed
  })

  it('returns [] for malformed FTS syntax instead of throwing', () => {
    seedItem(db, {})
    expect(invoke('library:search', '"unbalanced')).toEqual([])
  })
})
