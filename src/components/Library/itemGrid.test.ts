import { describe, it, expect } from 'vitest'
import { buildTagsMap, buildCollectionsMap } from './itemGrid'
import type { Collection } from '../../types'

describe('buildTagsMap', () => {
  it('groups flat item↔tag rows by item_id', () => {
    const map = buildTagsMap([
      { item_id: 'i1', tag_id: 't1', name: 'Sci-Fi', color: '#f00' },
      { item_id: 'i1', tag_id: 't2', name: 'Fav', color: '#0f0' },
      { item_id: 'i2', tag_id: 't1', name: 'Sci-Fi', color: '#f00' },
    ])
    expect(map.i1).toEqual([
      { id: 't1', name: 'Sci-Fi', color: '#f00' },
      { id: 't2', name: 'Fav', color: '#0f0' },
    ])
    expect(map.i2).toEqual([{ id: 't1', name: 'Sci-Fi', color: '#f00' }])
  })

  it('returns an empty map for no rows', () => {
    expect(buildTagsMap([])).toEqual({})
  })
})

describe('buildCollectionsMap', () => {
  const cols: Collection[] = [
    { id: 'c1', name: 'To Read', date_created: 0 },
    { id: 'c2', name: 'Done', date_created: 0 },
  ]

  it('resolves collection_id rows against the collection list', () => {
    const map = buildCollectionsMap(cols, [
      { item_id: 'i1', collection_id: 'c1', name: 'To Read' },
      { item_id: 'i1', collection_id: 'c2', name: 'Done' },
    ])
    expect(map.i1).toEqual([cols[0], cols[1]])
  })

  it('skips rows whose collection is unknown', () => {
    const map = buildCollectionsMap(cols, [
      { item_id: 'i1', collection_id: 'missing', name: '?' },
      { item_id: 'i1', collection_id: 'c1', name: 'To Read' },
    ])
    expect(map.i1).toEqual([cols[0]])
  })
})
