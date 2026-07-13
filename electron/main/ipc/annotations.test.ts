import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { invoke, resetIpc } from '../../../test/stubs/electron'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'
import { registerAnnotationHandlers, toMarkdown, toPlainText } from './annotations'
import type { ExportQuoteRow } from '../../../src/types'

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

  it('persists a highlight color on create and setColor updates it', async () => {
    const item = seedItem(db, {})
    const h = (await invoke('annotations:create', {
      item_id: item,
      type: 'highlight',
      position: 0.3,
      selected_text: 'sel',
      color: 'green',
    })) as any
    expect(h.color).toBe('green')

    await invoke('annotations:setColor', h.id, 'pink')
    const list = (await invoke('annotations:getForItem', item)) as any[]
    expect(list[0].color).toBe('pink')
  })

  it('defaults color to null when omitted', async () => {
    const item = seedItem(db, {})
    const a = (await invoke('annotations:create', {
      item_id: item,
      type: 'highlight',
      position: 0,
      selected_text: 's',
    })) as any
    expect(a.color).toBeNull()
  })

  it('round-trips PDF highlight geometry (rects JSON), null when omitted', async () => {
    const item = seedItem(db, {})
    const withRects = (await invoke('annotations:create', {
      item_id: item,
      type: 'highlight',
      position: 3, // PDF page number
      selected_text: 'quote',
      color: 'blue',
      rects: '[[1,2,3,4],[5,6,7,8]]',
    })) as any
    expect(withRects.rects).toBe('[[1,2,3,4],[5,6,7,8]]')

    const list = (await invoke('annotations:getForItem', item)) as any[]
    expect(list[0].rects).toBe('[[1,2,3,4],[5,6,7,8]]')

    const noRects = (await invoke('annotations:create', {
      item_id: item,
      type: 'note',
      position: 0.5,
    })) as any
    expect(noRects.rects).toBeNull()
  })

  it('updateNote edits note text', async () => {
    const item = seedItem(db, {})
    const a = (await invoke('annotations:create', {
      item_id: item,
      type: 'note',
      position: 0,
    })) as any
    await invoke('annotations:updateNote', a.id, 'edited')
    const list = (await invoke('annotations:getForItem', item)) as any[]
    expect(list[0].note_text).toBe('edited')
  })

  it('delete removes an annotation', async () => {
    const item = seedItem(db, {})
    const a = (await invoke('annotations:create', {
      item_id: item,
      type: 'bookmark',
      position: 0,
    })) as any
    await invoke('annotations:delete', a.id)
    expect(((await invoke('annotations:getForItem', item)) as any[]).length).toBe(0)
  })

  it('swapSortOrder exchanges the ordering of two annotations', async () => {
    const item = seedItem(db, {})
    const a = (await invoke('annotations:create', {
      item_id: item,
      type: 'note',
      position: 0,
    })) as any
    const b = (await invoke('annotations:create', {
      item_id: item,
      type: 'note',
      position: 0,
    })) as any
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

  it('create returns an empty themes array', async () => {
    const item = seedItem(db, {})
    const a = (await invoke('annotations:create', {
      item_id: item,
      type: 'highlight',
      position: 0,
      selected_text: 'x',
    })) as any
    expect(a.themes).toEqual([])
  })
})

describe('annotation themes + getAll', () => {
  it('creates a theme, reuses it by name (case-insensitive), and lists it', async () => {
    const t1 = (await invoke('annotationThemes:create', 'Symbolism')) as any
    const t2 = (await invoke('annotationThemes:create', 'symbolism')) as any
    expect(t2.id).toBe(t1.id) // reused, not duplicated
    const list = (await invoke('annotationThemes:list')) as any[]
    // The DB also carries the migration-28 preset vocabulary; assert our theme
    // appears exactly once (case-insensitive create reuses, never duplicates).
    expect(list.filter((t) => t.name === 'Symbolism')).toHaveLength(1)
    expect(list.some((t) => t.name === 'symbolism')).toBe(false)
  })

  it('setThemes attaches themes that surface on getForItem, and is a replace', async () => {
    const item = seedItem(db, {})
    const a = (await invoke('annotations:create', {
      item_id: item,
      type: 'highlight',
      position: 0,
      selected_text: 'quote',
    })) as any
    const th = (await invoke('annotationThemes:create', 'class conflict')) as any
    const other = (await invoke('annotationThemes:create', 'imagery')) as any

    await invoke('annotations:setThemes', a.id, [th.id, other.id])
    let rows = (await invoke('annotations:getForItem', item)) as any[]
    expect(rows[0].themes.map((t: any) => t.name).sort()).toEqual(['class conflict', 'imagery'])

    // Replace semantics: setting to just one drops the other.
    await invoke('annotations:setThemes', a.id, [th.id])
    rows = (await invoke('annotations:getForItem', item)) as any[]
    expect(rows[0].themes.map((t: any) => t.name)).toEqual(['class conflict'])
  })

  it('deleting a theme cascades its links off annotations', async () => {
    const item = seedItem(db, {})
    const a = (await invoke('annotations:create', {
      item_id: item,
      type: 'highlight',
      position: 0,
      selected_text: 'q',
    })) as any
    const th = (await invoke('annotationThemes:create', 'motif')) as any
    await invoke('annotations:setThemes', a.id, [th.id])
    await invoke('annotationThemes:delete', th.id)
    const rows = (await invoke('annotations:getForItem', item)) as any[]
    expect(rows[0].themes).toEqual([])
  })

  it('getAll joins the source book and excludes bookmarks + trashed items', async () => {
    const kept = seedItem(db, { title: 'Gatsby' })
    const trashed = seedItem(db, { title: 'Trashed' })
    db.prepare('UPDATE items SET deleted_at = 1 WHERE id = ?').run(trashed)

    await invoke('annotations:create', {
      item_id: kept,
      type: 'highlight',
      position: 0.2,
      selected_text: 'so we beat on',
    })
    await invoke('annotations:create', { item_id: kept, type: 'bookmark', position: 0.1 })
    await invoke('annotations:create', {
      item_id: trashed,
      type: 'highlight',
      position: 0,
      selected_text: 'hidden',
    })

    const all = (await invoke('annotations:getAll')) as any[]
    expect(all).toHaveLength(1) // bookmark + trashed excluded
    expect(all[0].item_title).toBe('Gatsby')
    expect(all[0].selected_text).toBe('so we beat on')
    expect(all[0].themes).toEqual([])
  })
})

describe('quote export formatting', () => {
  const row: ExportQuoteRow = {
    text: 'So we beat on',
    note: 'green light',
    title: 'The Great Gatsby',
    author: 'Fitzgerald',
    chapterLabel: 'Ch. 9',
    category: 'Key quote',
    themes: ['the american dream', 'time'],
  }

  it('markdown renders a blockquote with citation, category, and #themes', () => {
    const md = toMarkdown([row])
    expect(md).toContain('> So we beat on')
    expect(md).toContain('*The Great Gatsby*, Fitzgerald, Ch. 9')
    expect(md).toContain('[Key quote]')
    expect(md).toContain('#the-american-dream')
    expect(md).toContain('green light')
  })

  it('plain text quotes the passage and omits markdown emphasis', () => {
    const txt = toPlainText([row])
    expect(txt).toContain('"So we beat on"')
    expect(txt).not.toContain('*')
    expect(txt).toContain('#time')
  })
})
