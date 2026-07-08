import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'
import { buildTasteSeeds } from './tasteSeeds'
import type { SourceTag } from '../capture/fetch'

// buildTasteSeeds joins liked ids → item_source_tags + authors (openTestDb, Node ABI).

function addSourceTags(db: TestDb, itemId: string, tags: SourceTag[]): void {
  const stmt = db.prepare(`INSERT INTO item_source_tags (item_id, name, category) VALUES (?, ?, ?)`)
  for (const t of tags) stmt.run(itemId, t.name, t.category)
}

describe('buildTasteSeeds', () => {
  let db: TestDb
  beforeEach(() => {
    db = openTestDb()
  })
  afterEach(() => closeTestDb())

  it('buckets native tags by category and sums weight across liked items', () => {
    const i1 = seedItem(db, { author: 'Alice' })
    const i2 = seedItem(db, { author: 'Bob' })
    addSourceTags(db, i1, [
      { name: 'Harry Potter', category: 'fandom' },
      { name: 'Slow Burn', category: 'freeform' },
    ])
    addSourceTags(db, i2, [
      { name: 'harry potter', category: 'fandom' }, // same fandom, different casing
      { name: 'Romance', category: 'genre' },
      { name: 'Harry/Hermione', category: 'relationship' },
    ])

    const seeds = buildTasteSeeds([
      { id: i1, weight: 3 },
      { id: i2, weight: 1 },
    ])

    expect(seeds.fandoms).toEqual([{ term: 'Harry Potter', weight: 4 }]) // summed, first casing
    expect(seeds.freeforms).toEqual([{ term: 'Slow Burn', weight: 3 }])
    expect(seeds.genres).toEqual([{ term: 'Romance', weight: 1 }])
    expect(seeds.relationships).toEqual([{ term: 'Harry/Hermione', weight: 1 }])
    expect(seeds.authors).toEqual([
      { term: 'Alice', weight: 3 },
      { term: 'Bob', weight: 1 },
    ])
  })

  it('ignores non-positive-weight items and returns empty seeds for an empty liked set', () => {
    const i1 = seedItem(db, { author: 'Alice' })
    addSourceTags(db, i1, [{ name: 'Naruto', category: 'fandom' }])
    expect(buildTasteSeeds([{ id: i1, weight: 0 }]).fandoms).toEqual([])
    expect(buildTasteSeeds([]).authors).toEqual([])
  })
})
