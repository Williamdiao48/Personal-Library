import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { invoke, resetIpc, dialog, app } from '../../../test/stubs/electron'
import {
  openTestDb,
  closeTestDb,
  seedItem,
  seedTag,
  tagItem,
  type TestDb,
} from '../../../test/db/harness'
import { registerLibraryHandlers, clampRating } from './library'
import { computeContentHash } from '../util/contentHash'
import type { Item } from '../../../src/types'

// library:refresh reaches into the capture pipeline + recommender; mock those
// edges so the refresh branch-matrix is drivable without the network/DB churn.
vi.mock('../capture', () => ({
  refreshContent: vi.fn(),
  appendChapters: vi.fn(),
  getChapterCount: vi.fn(),
}))
vi.mock('../recommender/lifecycle', () => ({ triggerBackfill: vi.fn() }))
import { refreshContent, appendChapters, getChapterCount } from '../capture'
import { triggerBackfill } from '../recommender/lifecycle'

type Mock = ReturnType<typeof vi.fn>

let db: TestDb
// A per-test userData dir (app.getPath is overridden to it) so the handlers'
// real file writes never collide with other suites sharing the stub's fixed
// /tmp/pl-test-userdata path when Vitest runs files in parallel.
let userData: string
let CONTENT_DIR: string

beforeEach(() => {
  resetIpc()
  db = openTestDb()
  userData = mkdtempSync(join(tmpdir(), 'pl-lib-'))
  CONTENT_DIR = join(userData, 'content')
  mkdirSync(CONTENT_DIR, { recursive: true })
  vi.spyOn(app, 'getPath').mockImplementation((name: string) =>
    name === 'userData' ? userData : join('/tmp', `pl-test-${name}`),
  )
  registerLibraryHandlers()
})
afterEach(() => {
  closeTestDb()
  vi.restoreAllMocks() // spies (dialog, app.getPath)
  vi.clearAllMocks() // call history on the ../capture + lifecycle module mocks
  vi.unstubAllGlobals()
  rmSync(userData, { recursive: true, force: true })
})

// Index an item exactly as capture does: a contentless-FTS posting AND the
// item_fts_index side-table row that makes a later delete exact (H1/M1).
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
  db.prepare('INSERT INTO item_fts_index(item_id, title, author, content) VALUES(?, ?, ?, ?)').run(
    itemId,
    title,
    author ?? '',
    content,
  )
}

// Does a search for `term` return item `id`?
function searchHits(term: string, id: string): boolean {
  const rows = db
    .prepare(
      `SELECT i.id FROM items_fts f JOIN items i ON i.rowid = f.rowid
       WHERE items_fts MATCH ? AND i.deleted_at IS NULL`,
    )
    .all(term) as { id: string }[]
  return rows.some((r) => r.id === id)
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

    expect(((await invoke('library:getAll')) as Item[]).length).toBe(0)
    const trashed = (await invoke('library:getTrashed')) as Item[]
    expect(trashed.map((i) => i.id)).toEqual(['x'])

    await invoke('library:restore', 'x')
    expect(((await invoke('library:getAll')) as Item[]).map((i) => i.id)).toEqual(['x'])
    expect(((await invoke('library:getTrashed')) as Item[]).length).toBe(0)
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

  // ── H1 regression: hard-delete must remove FTS postings (contentless FTS5) ──
  it('permanentlyDelete removes the item’s FTS postings and side-table row', async () => {
    seedItem(db, { id: 'z', title: 'Z' })
    indexFts('z', 'zebra unicorn')
    expect(searchHits('zebra', 'z')).toBe(true)

    await invoke('library:permanentlyDelete', 'z')

    expect(db.prepare('SELECT COUNT(*) n FROM items_fts').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM item_fts_index').get()).toEqual({ n: 0 })
  })

  it('search does NOT cross-match a deleted item’s text after its rowid is reused (H1)', async () => {
    // A takes a rowid and indexes "zebra"; delete it, then B is inserted and
    // reuses A's just-freed rowid. Without FTS cleanup, "zebra" would resolve to B.
    const a = seedItem(db, { title: 'A', deleted_at: 1 })
    indexFts(a, 'zebra')
    const aRowid = (db.prepare('SELECT rowid FROM items WHERE id = ?').get(a) as { rowid: number })
      .rowid

    await invoke('library:permanentlyDelete', a)

    const b = seedItem(db, { title: 'B' })
    const bRowid = (db.prepare('SELECT rowid FROM items WHERE id = ?').get(b) as { rowid: number })
      .rowid
    expect(bRowid).toBe(aRowid) // precondition: SQLite reused the freed rowid
    indexFts(b, 'giraffe')

    expect(searchHits('zebra', b)).toBe(false) // A's stale term must not hit B
    expect(searchHits('giraffe', b)).toBe(true) // B's own term still works
    expect(((await invoke('library:search', 'zebra')) as Item[]).length).toBe(0)
  })

  it('emptyTrash removes FTS postings for every purged row (H1)', async () => {
    const t1 = seedItem(db, { title: 'T1', deleted_at: 1 })
    const t2 = seedItem(db, { title: 'T2', deleted_at: 2 })
    indexFts(t1, 'aardvark')
    indexFts(t2, 'buffalo')

    await invoke('library:emptyTrash')

    expect(db.prepare('SELECT COUNT(*) n FROM items_fts').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM item_fts_index').get()).toEqual({ n: 0 })
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
    const d = db
      .prepare('SELECT scroll_position FROM progress WHERE item_id = ?')
      .get('epub') as any
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
    const afterRating = db
      .prepare('SELECT rating, date_modified FROM items WHERE id = ?')
      .get('m') as any
    expect(afterRating.rating).toBe(4)
    expect(afterRating.date_modified).toBeGreaterThan(1)

    await invoke('library:setReview', 'm', 'good')
    const afterReview = db
      .prepare('SELECT review, date_modified FROM items WHERE id = ?')
      .get('m') as any
    expect(afterReview.review).toBe('good')
    expect(afterReview.date_modified).toBeGreaterThan(1)
  })

  it('setTitle and setAuthor persist and bump date_modified', async () => {
    seedItem(db, { id: 't', date_modified: 1 })
    await invoke('library:setTitle', 't', 'New Title')
    await invoke('library:setAuthor', 't', 'New Author')
    const row = db
      .prepare('SELECT title, author, date_modified FROM items WHERE id = ?')
      .get('t') as any
    expect(row.title).toBe('New Title')
    expect(row.author).toBe('New Author')
    expect(row.date_modified).toBeGreaterThan(1)
  })

  // SEC-2: clampRating pins an untrusted rating into [0,5] at 0.5 granularity.
  // Unit-level table of edge cases (the pure helper) …
  it('SEC-2: clampRating snaps to 0.5 and clamps to [0,5]', () => {
    expect(clampRating(6)).toBe(5) // above max
    expect(clampRating(-1)).toBe(0) // below min
    expect(clampRating(2.7)).toBe(2.5) // snap down to nearest 0.5
    expect(clampRating(4.9)).toBe(5) // snap up, still in range
    expect(clampRating(0.5)).toBe(0.5) // valid value passes through
    expect(clampRating(3)).toBe(3) // valid whole star passes through
    expect(clampRating(null)).toBeNull() // un-rate is legitimate
    expect(clampRating(undefined)).toBeNull()
    expect(clampRating(NaN)).toBeNull() // no sensible numeric target
    expect(clampRating(Infinity)).toBeNull()
    expect(clampRating(-Infinity)).toBeNull()
    expect(clampRating('5' as unknown)).toBeNull() // non-number → unrated
  })

  // … and the actual security assertion: the clamp fires at the IPC boundary,
  // so a renderer sending garbage cannot corrupt items.rating.
  it('regression SEC-2: setRating clamps to [0,5]/0.5 at the IPC boundary', async () => {
    seedItem(db, { id: 's' })
    const ratingOf = () =>
      (db.prepare('SELECT rating FROM items WHERE id = ?').get('s') as { rating: number | null })
        .rating

    await invoke('library:setRating', 's', 99) // way out of range
    expect(ratingOf()).toBe(5)

    await invoke('library:setRating', 's', -4)
    expect(ratingOf()).toBe(0)

    await invoke('library:setRating', 's', 3.3) // off-granularity
    expect(ratingOf()).toBe(3.5)

    await invoke('library:setRating', 's', NaN as unknown as number)
    expect(ratingOf()).toBeNull()

    await invoke('library:setRating', 's', 4) // valid input is untouched
    expect(ratingOf()).toBe(4)
  })
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
    expect(((await invoke('tags:getAll')) as any[]).length).toBe(0)
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

describe('library IPC — simple reads & scroll position', () => {
  it('getById returns the joined item + progress row, or undefined for a miss', async () => {
    seedItem(db, { id: 'g1', title: 'Found' })
    await invoke('library:updateProgress', 'g1', 0.4)
    const item = (await invoke('library:getById', 'g1')) as any
    expect(item).toMatchObject({ id: 'g1', title: 'Found', scroll_position: 0.4 })
    expect(await invoke('library:getById', 'nope')).toBeUndefined()
  })

  it('findBySourceUrl matches on the source URL', async () => {
    seedItem(db, { id: 's1', source_url: 'https://ao3.org/works/1' })
    const hit = (await invoke('library:findBySourceUrl', 'https://ao3.org/works/1')) as any
    expect(hit?.id).toBe('s1')
    expect(await invoke('library:findBySourceUrl', 'https://none')).toBeUndefined()
  })

  it('saveScrollPos upserts the chapter + scroll anchor without touching derived items', async () => {
    seedItem(db, { id: 'sp' })
    await invoke('library:saveScrollPos', 'sp', 3, 420)
    const row = db
      .prepare('SELECT scroll_chapter, scroll_y FROM progress WHERE item_id = ?')
      .get('sp') as any
    expect(row).toMatchObject({ scroll_chapter: 3, scroll_y: 420 })
  })

  it('updateProgress on a derived item also advances its source (reverse sync)', async () => {
    seedItem(db, { id: 'src' })
    seedItem(db, { id: 'epub' })
    db.prepare('UPDATE items SET derived_from = ? WHERE id = ?').run('src', 'epub')
    await invoke('library:updateProgress', 'epub', 0.7)
    const parent = db
      .prepare('SELECT scroll_position FROM progress WHERE item_id = ?')
      .get('src') as any
    expect(parent.scroll_position).toBe(0.7)
  })
})

describe('library IPC — trash file cleanup (cover paths)', () => {
  it('permanentlyDelete tolerates a cover_path whose file is already gone', async () => {
    seedItem(db, { id: 'pd', deleted_at: 1, cover_path: 'content/pd-cover.png' })
    await invoke('library:permanentlyDelete', 'pd') // unlink throws → caught, row still deleted
    expect(db.prepare('SELECT COUNT(*) n FROM items').get()).toEqual({ n: 0 })
  })

  it('emptyTrash tolerates trashed rows with cover paths', async () => {
    seedItem(db, { id: 'et', deleted_at: 2, cover_path: 'content/et-cover.png' })
    await invoke('library:emptyTrash')
    expect(db.prepare('SELECT COUNT(*) n FROM items').get()).toEqual({ n: 0 })
  })
})

describe('library IPC — cover images', () => {
  it('setCover rejects an unsupported extension', async () => {
    seedItem(db, { id: 'c1' })
    expect(await invoke('library:setCover', 'c1', new ArrayBuffer(4), 'svg')).toBeNull()
  })

  it('setCover writes the file, stores the path, and propagates to uncovered derived items', async () => {
    seedItem(db, { id: 'pdf', cover_path: null })
    seedItem(db, { id: 'derived', cover_path: null })
    db.prepare('UPDATE items SET derived_from = ? WHERE id = ?').run('pdf', 'derived')

    const bytes = new Uint8Array([1, 2, 3, 4]).buffer
    const path = (await invoke('library:setCover', 'pdf', bytes, 'png')) as string
    expect(path).toBe('content/pdf-cover.png')
    expect(existsSync(join(CONTENT_DIR, 'pdf-cover.png'))).toBe(true)

    // Derived EPUB with no cover inherits its own copy.
    const derived = db.prepare('SELECT cover_path FROM items WHERE id = ?').get('derived') as any
    expect(derived.cover_path).toBe('content/derived-cover.png')
    expect(existsSync(join(CONTENT_DIR, 'derived-cover.png'))).toBe(true)
  })

  it('setCover refuses a crafted id that would escape the content dir (L2)', async () => {
    seedItem(db, { id: '../../evil' })
    await expect(
      invoke('library:setCover', '../../evil', new Uint8Array([1]).buffer, 'png'),
    ).rejects.toThrow(/invalid content path/i)
  })

  it('setCover removes a pre-existing cover file before writing the new one', async () => {
    seedItem(db, { id: 'c2', cover_path: 'content/c2-cover.png' })
    writeFileSync(join(CONTENT_DIR, 'c2-cover.png'), 'old')
    await invoke('library:setCover', 'c2', new Uint8Array([9]).buffer, 'jpg')
    const row = db.prepare('SELECT cover_path FROM items WHERE id = ?').get('c2') as any
    expect(row.cover_path).toBe('content/c2-cover.jpg')
  })

  it('pickCover returns null when the dialog is canceled', async () => {
    seedItem(db, { id: 'pc' })
    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await invoke('library:pickCover', 'pc')).toBeNull()
  })

  it('pickCover rejects a non-image selection', async () => {
    seedItem(db, { id: 'pc' })
    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/notes.txt'],
    })
    expect(await invoke('library:pickCover', 'pc')).toBeNull()
  })

  it('pickCover copies the chosen image and stores its path', async () => {
    seedItem(db, { id: 'pc', cover_path: null })
    const src = join(CONTENT_DIR, 'source.png')
    writeFileSync(src, 'imagebytes')
    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({ canceled: false, filePaths: [src] })

    const path = (await invoke('library:pickCover', 'pc')) as string
    expect(path).toBe('content/pc-cover.png')
    expect(readFileSync(join(CONTENT_DIR, 'pc-cover.png'), 'utf8')).toBe('imagebytes')
  })
})

describe('library IPC — refresh', () => {
  const mockRefreshContent = refreshContent as Mock
  const mockGetChapterCount = getChapterCount as Mock
  const mockAppendChapters = appendChapters as Mock

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 })) // headChanged → may have changed
  })

  it('throws when the item does not exist', async () => {
    await expect(invoke('library:refresh', 'ghost')).rejects.toThrow(/not found/i)
  })

  it('throws when the item has no source URL', async () => {
    seedItem(db, { id: 'nosrc', source_url: null })
    await expect(invoke('library:refresh', 'nosrc')).rejects.toThrow(/no source URL/i)
  })

  it('short-circuits to "not changed" when the server answers 304', async () => {
    ;(globalThis.fetch as Mock).mockResolvedValue({ status: 304 })
    seedItem(db, { id: 'nm', source_url: 'https://x', word_count: 12 })
    const result = await invoke('library:refresh', 'nm')
    expect(result).toEqual({ changed: false, wordCount: 12 })
    expect(mockRefreshContent).not.toHaveBeenCalled()
  })

  it('reports "not changed" for a multi-chapter item with no new chapters', async () => {
    seedItem(db, { id: 'mc', source_url: 'https://x', word_count: 50 })
    db.prepare('UPDATE items SET chapter_start = 1, chapter_end = 5 WHERE id = ?').run('mc')
    mockGetChapterCount.mockResolvedValue(5)
    const result = await invoke('library:refresh', 'mc')
    expect(result).toEqual({ changed: false, wordCount: 50 })
    expect(mockAppendChapters).not.toHaveBeenCalled()
  })

  it('appends only the delta when new chapters appear', async () => {
    seedItem(db, { id: 'mc2', source_url: 'https://x' })
    db.prepare('UPDATE items SET chapter_start = 1, chapter_end = 5 WHERE id = ?').run('mc2')
    mockGetChapterCount.mockResolvedValue(8)
    mockAppendChapters.mockResolvedValue({ wordCount: 900 })
    const result = await invoke('library:refresh', 'mc2')
    expect(mockAppendChapters).toHaveBeenCalledWith('mc2', 8)
    expect(result).toEqual({ changed: true, wordCount: 900 })
    expect(triggerBackfill).toHaveBeenCalled()
  })

  it('full re-scrape: skips all I/O when the content hash is unchanged', async () => {
    const text = 'the very same words'
    seedItem(db, {
      id: 'same',
      source_url: 'https://x',
      word_count: 4,
      content_hash: computeContentHash(text),
    })
    mockRefreshContent.mockResolvedValue({ html: '<p>x</p>', textContent: text })
    const result = await invoke('library:refresh', 'same')
    expect(result).toEqual({ changed: false, wordCount: 4 })
  })

  it('full re-scrape: rewrites content + FTS and reports the new word count when changed', async () => {
    ;(globalThis.fetch as Mock).mockRejectedValue(new Error('HEAD failed')) // headChanged catch → proceed
    seedItem(db, {
      id: 'chg',
      source_url: 'https://x',
      file_path: 'chg.html',
      content_hash: 'stale',
      word_count: 1,
    })
    writeFileSync(join(CONTENT_DIR, 'chg.html'), '<p>old body</p>') // so the FTS-delete read succeeds
    indexFts('chg', 'old body') // contentless FTS 'delete' needs the originally-indexed tokens
    mockRefreshContent.mockResolvedValue({
      html: '<p>brand new content here</p>',
      textContent: 'brand new content here',
    })

    const result = await invoke('library:refresh', 'chg')
    expect(result).toEqual({ changed: true, wordCount: 4 })
    const row = db
      .prepare('SELECT word_count, content_hash FROM items WHERE id = ?')
      .get('chg') as any
    expect(row.word_count).toBe(4)
    expect(row.content_hash).not.toBe('stale')
    expect(readFileSync(join(CONTENT_DIR, 'chg.html'), 'utf8')).toContain('brand new content')
    expect(triggerBackfill).toHaveBeenCalled()
  })

  // ── M1 regression: refresh must delete the OLD postings exactly (from the
  // stored index values, not text re-derived from sanitized HTML), so old-only
  // tokens stop matching and search accuracy doesn't drift across refreshes. ──
  it('full re-scrape removes old-only FTS tokens and does not drift over repeated refreshes', async () => {
    ;(globalThis.fetch as Mock).mockRejectedValue(new Error('HEAD failed')) // headChanged → proceed
    seedItem(db, {
      id: 'drift',
      source_url: 'https://x',
      file_path: 'drift.html',
      content_hash: 'stale',
      word_count: 2,
    })
    // Divergence is the whole point of M1: the tokens ORIGINALLY indexed
    // (article.textContent) differ from what re-parsing the sanitized HTML file
    // yields. So the stored index text is the real tokens, but the on-disk file
    // reconstructs to something else — only the stored-value delete path removes
    // the real postings. If refresh ever regresses to reconstructing from the
    // file, `wolverine` survives and the first assertion below fails.
    writeFileSync(join(CONTENT_DIR, 'drift.html'), '<p>sanitized divergent markup</p>')
    indexFts('drift', 'wolverine badger') // the real originally-indexed tokens
    expect(searchHits('wolverine', 'drift')).toBe(true)

    // Refresh 1: wolverine/badger → penguin dolphin.
    mockRefreshContent.mockResolvedValue({
      html: '<p>penguin dolphin</p>',
      textContent: 'penguin dolphin',
    })
    expect((await invoke('library:refresh', 'drift')).changed).toBe(true)
    expect(searchHits('wolverine', 'drift')).toBe(false) // old posting exactly removed
    expect(searchHits('badger', 'drift')).toBe(false)
    expect(searchHits('penguin', 'drift')).toBe(true) // new posting present

    // Refresh 2: penguin/dolphin → aardvark. The old-text delete must use the
    // values stored by refresh 1 (not a reconstruction), or penguin lingers.
    mockRefreshContent.mockResolvedValue({
      html: '<p>aardvark</p>',
      textContent: 'aardvark',
    })
    expect((await invoke('library:refresh', 'drift')).changed).toBe(true)
    expect(searchHits('penguin', 'drift')).toBe(false) // no residual from refresh 1
    expect(searchHits('dolphin', 'drift')).toBe(false)
    expect(searchHits('aardvark', 'drift')).toBe(true)
  })

  it('falls through to a full re-scrape when getChapterCount is null (unsupported parser)', async () => {
    seedItem(db, {
      id: 'null-cc',
      source_url: 'https://x',
      file_path: 'null-cc.html',
      content_hash: 'stale',
    })
    db.prepare('UPDATE items SET chapter_start = 1, chapter_end = 2 WHERE id = ?').run('null-cc')
    writeFileSync(join(CONTENT_DIR, 'null-cc.html'), '<p>zzz</p>')
    indexFts('null-cc', 'zzz') // contentless FTS 'delete' needs the originally-indexed tokens
    mockGetChapterCount.mockResolvedValue(null) // unsupported → fall through
    mockRefreshContent.mockResolvedValue({ html: '<p>fresh</p>', textContent: 'fresh words now' })
    const result = (await invoke('library:refresh', 'null-cc')) as any
    expect(result.changed).toBe(true)
    // range was passed through from the item's chapter bounds
    expect(mockRefreshContent).toHaveBeenCalledWith('https://x', undefined, { start: 1, end: 2 })
  })
})
