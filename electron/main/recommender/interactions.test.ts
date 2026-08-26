import { describe, it, expect, afterEach } from 'vitest'
import { openTestDb, closeTestDb } from '../../../test/db/harness'
import { recordOpen, loadOpens, type OpenCardInput } from './interactions'
import { all } from '../db'

// Repository tests for discover_interactions (ADR-0011, migration 44) — need the
// better-sqlite3 Node ABI (openTestDb).

const card = (over: Partial<OpenCardInput> = {}): OpenCardInput => ({
  sourceId: 'https://ao3.org/works/1',
  title: 'A Fic',
  author: 'Author',
  source: 'ao3',
  url: 'https://ao3.org/works/1',
  subjects: ['angst', 'slow-burn'],
  ...over,
})

describe('discover interactions store', () => {
  afterEach(() => closeTestDb())

  it('records a first open with open_count 1 and the given opened_at', () => {
    openTestDb()
    recordOpen(card(), 1_000)
    const opens = loadOpens()
    expect(opens).toEqual([{ sourceId: 'https://ao3.org/works/1', openedAt: 1_000, openCount: 1 }])
  })

  it('persists the preview fields + subjects as JSON', () => {
    openTestDb()
    recordOpen(card({ subjects: ['x', 'y'] }), 42)
    const row = all<{ title: string; author: string; source: string; subjects: string }>(
      `SELECT title, author, source, subjects FROM discover_interactions`,
    )[0]
    expect(row.title).toBe('A Fic')
    expect(row.author).toBe('Author')
    expect(row.source).toBe('ao3')
    expect(JSON.parse(row.subjects)).toEqual(['x', 'y'])
  })

  it('a repeat open bumps open_count and refreshes opened_at (upsert on sourceId)', () => {
    openTestDb()
    recordOpen(card(), 1_000)
    recordOpen(card(), 5_000)
    recordOpen(card(), 9_000)
    const opens = loadOpens()
    expect(opens).toHaveLength(1) // still one row
    expect(opens[0]).toEqual({
      sourceId: 'https://ao3.org/works/1',
      openedAt: 9_000, // latest
      openCount: 3,
    })
  })

  it('re-stamps preview fields on a repeat open (metadata may change)', () => {
    openTestDb()
    recordOpen(card({ title: 'Old Title' }), 1)
    recordOpen(card({ title: 'New Title' }), 2)
    const row = all<{ title: string }>(`SELECT title FROM discover_interactions`)[0]
    expect(row.title).toBe('New Title')
  })

  it('keeps distinct sourceIds as separate rows', () => {
    openTestDb()
    recordOpen(card({ sourceId: 'a' }), 1)
    recordOpen(card({ sourceId: 'b' }), 2)
    const ids = loadOpens()
      .map((o) => o.sourceId)
      .sort()
    expect(ids).toEqual(['a', 'b'])
  })

  it('handles null author/source/url and empty subjects', () => {
    openTestDb()
    recordOpen(card({ author: null, source: null, url: null, subjects: [] }), 7)
    const row = all<{ author: string | null; subjects: string }>(
      `SELECT author, subjects FROM discover_interactions`,
    )[0]
    expect(row.author).toBeNull()
    expect(JSON.parse(row.subjects)).toEqual([])
  })

  it('loadOpens is empty on a fresh db', () => {
    openTestDb()
    expect(loadOpens()).toEqual([])
  })
})
