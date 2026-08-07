import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { invoke, resetIpc } from '../../../test/stubs/electron'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'

// registerLibraryHandlers pulls in the capture pipeline + recommender at import;
// stub those edges (same as library.test.ts) so this suite stays DB-only.
vi.mock('../capture', () => ({
  refreshContent: vi.fn(),
  appendChapters: vi.fn(),
  getChapterCount: vi.fn(),
}))
vi.mock('../recommender/lifecycle', () => ({ triggerBackfill: vi.fn() }))

import { registerLibraryHandlers } from './library'
import { registerCollectionHandlers } from './collections'
import { registerAnnotationHandlers } from './annotations'
import { registerGoalsHandlers } from './goals'

// Phase 3 turns every hard-delete on a SYNCABLE table into a propagating
// tombstone (deleted_at set + dirty=1), so deletions sync instead of silently
// resurrecting on the next pull. These tests lock the two guarantees that matter:
// (1) no syncable table is ever hard-deleted from a handler (Risk #1), and
// (2) a soft-delete hides the row, keeps a dirty tombstone, and frees any
//     UNIQUE(name) slot so re-creating a same-named row still works (R6).

let db: TestDb

beforeEach(() => {
  resetIpc()
  db = openTestDb()
  registerLibraryHandlers()
  registerCollectionHandlers()
  registerAnnotationHandlers()
  registerGoalsHandlers()
})

afterEach(() => closeTestDb())

const SYNCABLE = [
  'items',
  'progress',
  'tags',
  'item_tags',
  'collections',
  'collection_items',
  'annotations',
  'annotation_themes',
  'annotation_theme_links',
  'goals',
  'goal_items',
  'reading_sessions',
]

describe('Risk #1 — no hard-deletes on syncable tables', () => {
  it('no handler source issues DELETE FROM <syncable table>', () => {
    const files = ['library.ts', 'collections.ts', 'annotations.ts', 'goals.ts']
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
      for (const t of SYNCABLE) {
        if (new RegExp(`DELETE\\s+FROM\\s+${t}\\b`, 'i').test(src)) offenders.push(`${f}: ${t}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('tag soft-delete', () => {
  it('hides the tag, keeps a dirty tombstone, tombstones its links, and frees the name', async () => {
    const item = seedItem(db, {})
    const t = (await invoke('tags:create', 'sci-fi', '#fff')) as { id: string }
    await invoke('tags:setForItem', item, [t.id])

    await invoke('tags:delete', t.id)

    // Gone from the live API surface.
    expect(((await invoke('tags:getAll')) as unknown[]).length).toBe(0)
    expect(((await invoke('tags:getForItem', item)) as unknown[]).length).toBe(0)

    // Tombstone persists, dirty, with the name freed via the id-suffix.
    const row = db.prepare('SELECT deleted_at, dirty, name FROM tags WHERE id = ?').get(t.id) as {
      deleted_at: number | null
      dirty: number
      name: string
    }
    expect(row.deleted_at).not.toBeNull()
    expect(row.dirty).toBe(1)
    expect(row.name).not.toBe('sci-fi')
    // The freed name must use the Postgres-safe Unit Separator (0x1F), NOT NUL — a
    // NUL-suffixed name can never push to the Postgres mirror (22P05). (Phase 3 C4.)
    expect(row.name).toBe(`sci-fi\x1f${t.id}`)
    expect(row.name).not.toContain('\x00')

    // The item_tags link is tombstoned too (was ON DELETE CASCADE before).
    expect(db.prepare('SELECT COUNT(*) n FROM item_tags WHERE deleted_at IS NULL').get()).toEqual({
      n: 0,
    })

    // Re-creating a same-named tag no longer collides on UNIQUE(name).
    const t2 = (await invoke('tags:create', 'sci-fi', '#000')) as { id: string }
    expect(t2.id).not.toBe(t.id)
    expect(((await invoke('tags:getAll')) as { name: string }[]).map((x) => x.name)).toEqual([
      'sci-fi',
    ])
  })
})

describe('collection soft-delete', () => {
  it('re-creating a deleted collection’s name works, membership is tombstoned', async () => {
    const item = seedItem(db, {})
    const c = (await invoke('collections:create', 'Faves')) as { id: string }
    await invoke('collections:addItem', c.id, item)

    await invoke('collections:delete', c.id)

    expect(((await invoke('collections:getAll')) as unknown[]).length).toBe(0)
    expect(
      db.prepare('SELECT COUNT(*) n FROM collection_items WHERE deleted_at IS NULL').get(),
    ).toEqual({ n: 0 })
    // Name freed → same name re-creatable.
    const c2 = (await invoke('collections:create', 'Faves')) as { id: string }
    expect(c2.id).not.toBe(c.id)
  })

  it('removeItem tombstones the membership, then re-add revives the same row', async () => {
    const item = seedItem(db, {})
    const c = (await invoke('collections:create', 'C')) as { id: string }
    await invoke('collections:addItem', c.id, item)
    await invoke('collections:removeItem', c.id, item)
    expect(((await invoke('collections:getItems', c.id)) as unknown[]).length).toBe(0)
    // Re-add flips the tombstone back to live (one physical row, not two).
    await invoke('collections:addItem', c.id, item)
    expect(((await invoke('collections:getItems', c.id)) as unknown[]).length).toBe(1)
    expect(db.prepare('SELECT COUNT(*) n FROM collection_items').get()).toEqual({ n: 1 })
  })
})

describe('annotation + theme soft-delete', () => {
  it('deleting an annotation tombstones it and its theme links', async () => {
    const item = seedItem(db, {})
    const a = (await invoke('annotations:create', {
      item_id: item,
      type: 'note',
      position: 0,
      note_text: 'hi',
    })) as { id: string }
    const theme = (await invoke('annotationThemes:create', 'Symbolism')) as { id: string }
    await invoke('annotations:setThemes', a.id, [theme.id])

    await invoke('annotations:delete', a.id)

    expect(((await invoke('annotations:getForItem', item)) as unknown[]).length).toBe(0)
    expect(
      db.prepare('SELECT dirty, deleted_at FROM annotations WHERE id = ?').get(a.id),
    ).toMatchObject({ dirty: 1 })
    expect(
      db.prepare('SELECT COUNT(*) n FROM annotation_theme_links WHERE deleted_at IS NULL').get(),
    ).toEqual({ n: 0 })
  })

  it('deleting a theme frees its name and tombstones its links', async () => {
    const theme = (await invoke('annotationThemes:create', 'Power')) as { id: string }
    await invoke('annotationThemes:delete', theme.id)
    const listed = (await invoke('annotationThemes:list')) as { id: string }[]
    expect(listed.some((x) => x.id === theme.id)).toBe(false)
    // Same name re-creatable (a preset 'Power' also exists from migration 28, but a
    // fresh create must still succeed rather than collide on the tombstone).
    const again = (await invoke('annotationThemes:create', 'Power')) as { id: string }
    expect(again).toBeTruthy()
  })
})

describe('goal soft-delete', () => {
  it('deleting a goal tombstones the goal and its items', async () => {
    const item = seedItem(db, {})
    const g = (await invoke('goals:create', { type: 'list', title: 'TBR' })) as { id: string }
    await invoke('goals:addItem', g.id, item)

    await invoke('goals:delete', g.id)

    expect(((await invoke('goals:getAll')) as unknown[]).length).toBe(0)
    expect(db.prepare('SELECT dirty, deleted_at FROM goals WHERE id = ?').get(g.id)).toMatchObject({
      dirty: 1,
    })
    expect(db.prepare('SELECT COUNT(*) n FROM goal_items WHERE deleted_at IS NULL').get()).toEqual({
      n: 0,
    })
  })
})

describe('dirty flag is set on local edits (push tracking)', () => {
  it('editing an item’s title marks it dirty', async () => {
    const item = seedItem(db, {})
    // Freshly seeded rows default dirty=1; clear it to prove the edit re-marks it.
    db.prepare('UPDATE items SET dirty = 0 WHERE id = ?').run(item)
    await invoke('library:setTitle', item, 'New Title')
    expect(db.prepare('SELECT dirty FROM items WHERE id = ?').get(item)).toMatchObject({ dirty: 1 })
  })
})
