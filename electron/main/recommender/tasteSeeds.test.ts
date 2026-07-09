import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'
import { buildTasteSeeds, buildAo3RawSeeds, buildLengthProfile } from './tasteSeeds'
import type { SourceTag } from '../capture/fetch'

const AO3 = 'https://archiveofourown.org/works/1'
const FFN = 'https://www.fanfiction.net/s/1'

// buildTasteSeeds joins liked ids → item_source_tags + authors (openTestDb, Node ABI).

function addSourceTags(db: TestDb, itemId: string, tags: SourceTag[]): void {
  const stmt = db.prepare(`INSERT INTO item_source_tags (item_id, name, category) VALUES (?, ?, ?)`)
  for (const t of tags) stmt.run(itemId, t.name, t.category)
}

function addSourceMeta(
  db: TestDb,
  itemId: string,
  meta: { words?: number; status?: string },
): void {
  db.prepare(`INSERT INTO item_source_meta (item_id, words, status) VALUES (?, ?, ?)`).run(
    itemId,
    meta.words ?? null,
    meta.status ?? null,
  )
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

describe('buildAo3RawSeeds', () => {
  let db: TestDb
  beforeEach(() => {
    db = openTestDb()
  })
  afterEach(() => closeTestDb())

  it('splits each named-field category by origin: AO3 → canonical, non-AO3 → raw (to resolve)', () => {
    const ao3 = seedItem(db, { source_url: AO3 })
    const ffn = seedItem(db, { source_url: FFN })
    addSourceTags(db, ao3, [
      { name: 'Hermione Granger/Draco Malfoy', category: 'relationship' },
      { name: 'Hermione Granger', category: 'character' },
      { name: 'Harry Potter - J. K. Rowling', category: 'fandom' },
    ])
    addSourceTags(db, ffn, [
      // FFN abbreviations land in `raw` — kept for autocomplete resolution, not dropped.
      { name: 'Harry P./Fleur D.', category: 'relationship' },
      { name: 'Harry P.', category: 'character' },
      { name: 'Harry Potter', category: 'fandom' },
    ])

    const seeds = buildAo3RawSeeds([
      { id: ao3, weight: 2 },
      { id: ffn, weight: 3 },
    ])
    expect(seeds.relationships.canonical).toEqual([
      { term: 'Hermione Granger/Draco Malfoy', weight: 2 },
    ])
    expect(seeds.relationships.raw).toEqual([{ term: 'Harry P./Fleur D.', weight: 3 }])
    expect(seeds.characters.canonical).toEqual([{ term: 'Hermione Granger', weight: 2 }])
    expect(seeds.characters.raw).toEqual([{ term: 'Harry P.', weight: 3 }])
    expect(seeds.fandoms.canonical).toEqual([{ term: 'Harry Potter - J. K. Rowling', weight: 2 }])
    expect(seeds.fandoms.raw).toEqual([{ term: 'Harry Potter', weight: 3 }])
    // Neither fic is genre-tagged romance → nothing feeds pairing inference.
    expect(seeds.romanceCharacters).toEqual({ canonical: [], raw: [] })
  })

  it('feeds only romance-fic characters into the pairing-inference pool', () => {
    const romance = seedItem(db, { source_url: FFN })
    const adventure = seedItem(db, { source_url: FFN })
    addSourceTags(db, romance, [
      { name: 'Romance', category: 'genre' },
      { name: 'Harry P.', category: 'character' },
      { name: 'Fleur D.', category: 'character' },
    ])
    addSourceTags(db, adventure, [
      { name: 'Adventure', category: 'genre' },
      { name: 'Harry P.', category: 'character' },
      { name: 'Ron W.', category: 'character' }, // gen-fic co-character → NOT a ship signal
    ])

    const seeds = buildAo3RawSeeds([
      { id: romance, weight: 1 },
      { id: adventure, weight: 1 },
    ])
    // full character pool spans both fics …
    expect(seeds.characters.raw.map((c) => c.term).sort()).toEqual([
      'Fleur D.',
      'Harry P.',
      'Ron W.',
    ])
    // … but only the romance fic's characters can seed a pairing (Ron excluded)
    expect(seeds.romanceCharacters.raw.map((c) => c.term).sort()).toEqual(['Fleur D.', 'Harry P.'])
  })
})

describe('buildLengthProfile', () => {
  let db: TestDb
  beforeEach(() => {
    db = openTestDb()
  })
  afterEach(() => closeTestDb())

  const seedFic = (over: { words?: number; status?: string }): string => {
    const id = seedItem(db, {})
    addSourceMeta(db, id, over)
    return id
  }
  const liked = (ids: string[]) => ids.map((id) => ({ id, weight: 1 }))

  it('sets a word floor when the reader clearly prefers long fics', () => {
    const ids = [seedFic({ words: 120000 }), seedFic({ words: 90000 }), seedFic({ words: 60000 })]
    const p = buildLengthProfile(liked(ids))
    expect(p.wordFloor).toBe(40000)
    expect(p.wordCeil).toBeUndefined()
  })

  it('sets a word ceiling when the reader clearly prefers short fics', () => {
    const ids = [seedFic({ words: 3000 }), seedFic({ words: 8000 }), seedFic({ words: 12000 })]
    const p = buildLengthProfile(liked(ids))
    expect(p.wordCeil).toBe(20000)
    expect(p.wordFloor).toBeUndefined()
  })

  it('leaves length unfiltered for a mixed library, and completeOnly when complete-skewed', () => {
    const ids = [
      seedFic({ words: 5000, status: 'complete' }),
      seedFic({ words: 100000, status: 'complete' }),
      seedFic({ words: 250000, status: 'complete' }),
    ]
    const p = buildLengthProfile(liked(ids))
    expect(p.wordFloor).toBeUndefined()
    expect(p.wordCeil).toBeUndefined()
    expect(p.completeOnly).toBe(true) // all three complete
  })

  it('never over-filters below the minimum sample', () => {
    const p = buildLengthProfile(liked([seedFic({ words: 500000, status: 'complete' })]))
    expect(p).toEqual({ completeOnly: false })
  })
})
