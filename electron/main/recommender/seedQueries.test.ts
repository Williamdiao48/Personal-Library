import { describe, it, expect } from 'vitest'
import { buildSeedQueries, SEED, type SeedSource } from './seedQueries'

// C4.2 — pure query seeder. No DB, no network, no ABI toggle.

const src = (over: Partial<SeedSource> = {}): SeedSource => ({
  author: null,
  tags: [],
  weight: 1,
  ...over,
})

describe('buildSeedQueries', () => {
  it('returns nothing for empty sources', () => {
    expect(buildSeedQueries([])).toEqual([])
  })

  it('emits fielded subject/author queries with wrapped quotes', () => {
    const qs = buildSeedQueries([src({ author: 'Neil Gaiman', tags: ['Fantasy'] })])
    expect(qs).toEqual(
      expect.arrayContaining([
        { kind: 'subject', term: 'Fantasy', q: 'subject:"Fantasy"', weight: 1 },
        { kind: 'author', term: 'Neil Gaiman', q: 'author:"Neil Gaiman"', weight: 1 },
      ]),
    )
  })

  it('sums weight for the same term across sources (case-insensitive)', () => {
    const qs = buildSeedQueries([
      src({ tags: ['Fantasy'], weight: 0.4 }),
      src({ tags: ['fantasy'], weight: 0.6 }),
    ])
    const fantasy = qs.filter((q) => q.kind === 'subject')
    expect(fantasy).toHaveLength(1)
    expect(fantasy[0].weight).toBeCloseTo(1.0)
    expect(fantasy[0].term).toBe('Fantasy') // first-seen casing preserved
  })

  it('orders subjects by summed weight, heaviest first', () => {
    const qs = buildSeedQueries([
      src({ tags: ['Romance'], weight: 0.2 }),
      src({ tags: ['SciFi'], weight: 0.9 }),
      src({ tags: ['Mystery'], weight: 0.5 }),
    ])
    expect(qs.filter((q) => q.kind === 'subject').map((q) => q.term)).toEqual([
      'SciFi',
      'Mystery',
      'Romance',
    ])
  })

  it('caps subjects at MAX_SUBJECTS and authors at MAX_AUTHORS', () => {
    const tags = Array.from({ length: SEED.MAX_SUBJECTS + 3 }, (_, i) => `tag${i}`)
    const authors = Array.from({ length: SEED.MAX_AUTHORS + 2 }, (_, i) =>
      src({ author: `Author ${i}`, weight: 1 }),
    )
    const qs = buildSeedQueries([src({ tags }), ...authors])
    expect(qs.filter((q) => q.kind === 'subject')).toHaveLength(SEED.MAX_SUBJECTS)
    expect(qs.filter((q) => q.kind === 'author')).toHaveLength(SEED.MAX_AUTHORS)
  })

  it('strips embedded quotes and collapses whitespace in terms', () => {
    const qs = buildSeedQueries([src({ tags: ['  Slow   "Burn"  '] })])
    expect(qs[0]).toMatchObject({ term: 'Slow Burn', q: 'subject:"Slow Burn"' })
  })

  it('skips null authors and blank tags', () => {
    const qs = buildSeedQueries([src({ author: null, tags: ['', '   ', 'Horror'] })])
    expect(qs).toEqual([{ kind: 'subject', term: 'Horror', q: 'subject:"Horror"', weight: 1 }])
  })

  it('skips non-positive-weight sources (only likes seed)', () => {
    const qs = buildSeedQueries([
      src({ tags: ['Ignored'], author: 'Nobody', weight: 0 }),
      src({ tags: ['Ignored2'], author: 'Nobody2', weight: -0.5 }),
    ])
    expect(qs).toEqual([])
  })

  it('breaks weight ties alphabetically (deterministic output)', () => {
    const qs = buildSeedQueries([
      src({ tags: ['Zebra'], weight: 0.5 }),
      src({ tags: ['Apple'], weight: 0.5 }),
    ])
    expect(qs.map((q) => q.term)).toEqual(['Apple', 'Zebra'])
  })
})
