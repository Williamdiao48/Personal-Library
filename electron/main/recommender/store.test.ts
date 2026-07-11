import { describe, it, expect, afterEach } from 'vitest'
import { openTestDb, closeTestDb, seedItem, seedEmbedding } from '../../../test/db/harness'
import { upsertEmbedding, getEmbedding, getAllEmbeddingMeta, loadVectors } from './store'

// Repository tests — need the better-sqlite3 Node ABI (openTestDb).

describe('embedding store', () => {
  afterEach(() => closeTestDb())

  it('upserts and reads back a row with the vector + metadata intact', () => {
    const db = openTestDb()
    const id = seedItem(db)
    const vec = Float32Array.from([0.1, -0.2, 0.3, 0.4])
    upsertEmbedding({
      itemId: id,
      embedding: vec,
      modelVersion: 'bge-1',
      contentHash: 'abc',
      embeddedAt: 123,
    })
    const got = getEmbedding(id)
    expect(got).toBeDefined()
    expect(Array.from(got!.embedding)).toEqual(Array.from(vec))
    expect(got!.modelVersion).toBe('bge-1')
    expect(got!.contentHash).toBe('abc')
    expect(got!.embeddedAt).toBe(123)
  })

  it('overwrites on conflict (upsert replaces the prior row)', () => {
    const db = openTestDb()
    const id = seedItem(db)
    upsertEmbedding({
      itemId: id,
      embedding: Float32Array.from([1]),
      modelVersion: 'm1',
      contentHash: 'h1',
    })
    upsertEmbedding({
      itemId: id,
      embedding: Float32Array.from([2, 3]),
      modelVersion: 'm2',
      contentHash: 'h2',
    })
    const got = getEmbedding(id)
    expect(Array.from(got!.embedding)).toEqual([2, 3])
    expect(got!.modelVersion).toBe('m2')
    expect(got!.contentHash).toBe('h2')
    // still exactly one row
    expect(getAllEmbeddingMeta()).toHaveLength(1)
  })

  it('getEmbedding returns undefined for an unembedded item', () => {
    const db = openTestDb()
    const id = seedItem(db)
    expect(getEmbedding(id)).toBeUndefined()
  })

  it('getAllEmbeddingMeta returns cheap staleness metadata for every row', () => {
    const db = openTestDb()
    const a = seedItem(db, { title: 'A' })
    const b = seedItem(db, { title: 'B' })
    seedEmbedding(db, a, { model_version: 'm', content_hash: 'ha' })
    seedEmbedding(db, b, { model_version: 'm', content_hash: 'hb' })
    const meta = getAllEmbeddingMeta().sort((x, y) => x.content_hash.localeCompare(y.content_hash))
    expect(meta).toEqual([
      { item_id: a, model_version: 'm', content_hash: 'ha' },
      { item_id: b, model_version: 'm', content_hash: 'hb' },
    ])
  })

  it('loadVectors returns decoded vectors for requested ids, skipping missing ones', () => {
    const db = openTestDb()
    const a = seedItem(db)
    const b = seedItem(db)
    upsertEmbedding({
      itemId: a,
      embedding: Float32Array.from([1, 2]),
      modelVersion: 'm',
      contentHash: 'h',
    })
    upsertEmbedding({
      itemId: b,
      embedding: Float32Array.from([3, 4]),
      modelVersion: 'm',
      contentHash: 'h',
    })
    const map = loadVectors([a, b, 'does-not-exist'])
    expect(map.size).toBe(2)
    expect(Array.from(map.get(a)!)).toEqual([1, 2])
    expect(Array.from(map.get(b)!)).toEqual([3, 4])
    expect(map.has('does-not-exist')).toBe(false)
  })

  it('loadVectors([]) is an empty map (no query)', () => {
    openTestDb()
    expect(loadVectors([]).size).toBe(0)
  })
})
