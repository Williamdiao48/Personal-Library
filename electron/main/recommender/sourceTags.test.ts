import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'
import { all, get } from '../db'
import { persistSourceTags, siteKeyFromUrl } from './sourceTags'
import type { SourceTag } from '../capture/fetch'

// F2 — persistSourceTags touches item_source_tags / item_source_meta / tags /
// item_tags, so it runs under the Node ABI (openTestDb). siteKeyFromUrl is pure.

const TAGS: SourceTag[] = [
  { name: 'Harry Potter - J. K. Rowling', category: 'fandom' },
  { name: 'Hermione Granger/Draco Malfoy', category: 'relationship' },
  { name: 'Hermione Granger', category: 'character' },
  { name: 'Enemies to Lovers', category: 'freeform' },
]

const chipsOf = (db: TestDb, itemId: string): string[] =>
  all<{ name: string }>(
    `SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ? ORDER BY t.name`,
    [itemId],
  ).map((r) => r.name)

describe('persistSourceTags', () => {
  let db: TestDb
  beforeEach(() => {
    db = openTestDb()
  })
  afterEach(() => closeTestDb())

  it('stores native tags + meta and promotes only fandom/relationship to chips', () => {
    const id = seedItem(db, { source_url: 'https://archiveofourown.org/works/1' })
    persistSourceTags(
      db,
      id,
      TAGS,
      { kudos: 1234, words: 50123, status: 'complete', rating: 'Explicit' },
      'ao3',
    )

    const stored = all<{ name: string; category: string }>(
      `SELECT name, category FROM item_source_tags WHERE item_id = ?`,
      [id],
    )
    expect(stored).toHaveLength(4)
    expect(stored).toContainEqual({ name: 'Enemies to Lovers', category: 'freeform' })

    expect(
      get(`SELECT kudos, words, status, source FROM item_source_meta WHERE item_id = ?`, [id]),
    ).toMatchObject({ kudos: 1234, words: 50123, status: 'complete', source: 'ao3' })

    // Hybrid (D2): fandom + relationship become chips; freeform/character do not.
    expect(chipsOf(db, id)).toEqual([
      'Harry Potter - J. K. Rowling',
      'Hermione Granger/Draco Malfoy',
    ])
  })

  it('is idempotent — re-persisting replaces source tags and never accumulates chip rows', () => {
    const id = seedItem(db, {})
    persistSourceTags(db, id, TAGS, { kudos: 5 }, 'ao3')
    persistSourceTags(db, id, TAGS, { kudos: 9 }, 'ao3') // re-run (backfill / re-capture)

    expect(all(`SELECT 1 FROM item_source_tags WHERE item_id = ?`, [id])).toHaveLength(4)
    expect(chipsOf(db, id)).toHaveLength(2) // no duplicate links
    expect(all(`SELECT 1 FROM tags WHERE name = 'Harry Potter - J. K. Rowling'`)).toHaveLength(1)
    expect(
      get<{ kudos: number }>(`SELECT kudos FROM item_source_meta WHERE item_id = ?`, [id])?.kudos,
    ).toBe(9)
  })

  it('no-ops cleanly for a non-fanfic capture (undefined tags/meta)', () => {
    const id = seedItem(db, {})
    expect(() => persistSourceTags(db, id, undefined, undefined, null)).not.toThrow()
    expect(all(`SELECT 1 FROM item_source_tags WHERE item_id = ?`, [id])).toHaveLength(0)
    expect(chipsOf(db, id)).toHaveLength(0)
  })
})

describe('siteKeyFromUrl', () => {
  it('maps AO3 / FFN hosts and returns null otherwise', () => {
    expect(siteKeyFromUrl('https://archiveofourown.org/works/1')).toBe('ao3')
    expect(siteKeyFromUrl('https://www.fanfiction.net/s/1/1/x')).toBe('ffn')
    expect(siteKeyFromUrl('https://example.com/x')).toBeNull()
    expect(siteKeyFromUrl(null)).toBeNull()
    expect(siteKeyFromUrl('not a url')).toBeNull()
  })
})
