import { describe, it, expect } from 'vitest'
import { matchesAnnotationFilter, groupAnnotations } from './filterAnnotations'

const DAY = 24 * 60 * 60 * 1000

const base = {
  selected_text: 'So we beat on, boats against the current',
  note_text: 'green light imagery',
  color: 'green' as const,
  themes: [{ id: 't1' }, { id: 't2' }],
  item_id: 'b1',
  created_at: Date.now(),
}

const noFilter = {
  query: '',
  colorFilter: 'all',
  themeFilter: [] as string[],
  bookFilter: 'all',
  dateFilter: 'all',
}

describe('matchesAnnotationFilter', () => {
  it('passes when no filters are set', () => {
    expect(matchesAnnotationFilter(base, noFilter)).toBe(true)
  })

  it('filters by effective color (legacy null → yellow)', () => {
    expect(matchesAnnotationFilter(base, { ...noFilter, colorFilter: 'green' })).toBe(true)
    expect(matchesAnnotationFilter(base, { ...noFilter, colorFilter: 'blue' })).toBe(false)
    const legacy = { ...base, color: null }
    expect(matchesAnnotationFilter(legacy, { ...noFilter, colorFilter: 'yellow' })).toBe(true)
    expect(matchesAnnotationFilter(legacy, { ...noFilter, colorFilter: 'green' })).toBe(false)
  })

  it('theme filter is OR — passes if it has ANY selected theme', () => {
    expect(matchesAnnotationFilter(base, { ...noFilter, themeFilter: ['t2'] })).toBe(true)
    expect(matchesAnnotationFilter(base, { ...noFilter, themeFilter: ['t9'] })).toBe(false)
    expect(matchesAnnotationFilter(base, { ...noFilter, themeFilter: ['t9', 't1'] })).toBe(true)
  })

  it('searches the quote text and the note, case-insensitively', () => {
    expect(matchesAnnotationFilter(base, { ...noFilter, query: 'BOATS' })).toBe(true)
    expect(matchesAnnotationFilter(base, { ...noFilter, query: 'imagery' })).toBe(true) // note
    expect(matchesAnnotationFilter(base, { ...noFilter, query: 'nonexistent' })).toBe(false)
  })

  it('filters by book (item_id)', () => {
    expect(matchesAnnotationFilter(base, { ...noFilter, bookFilter: 'b1' })).toBe(true)
    expect(matchesAnnotationFilter(base, { ...noFilter, bookFilter: 'b2' })).toBe(false)
  })

  it('filters by rolling date window', () => {
    const old = { ...base, created_at: Date.now() - 40 * DAY }
    expect(matchesAnnotationFilter(old, { ...noFilter, dateFilter: '7d' })).toBe(false)
    expect(matchesAnnotationFilter(old, { ...noFilter, dateFilter: '30d' })).toBe(false)
    expect(matchesAnnotationFilter(old, { ...noFilter, dateFilter: '365d' })).toBe(true)
    expect(matchesAnnotationFilter(base, { ...noFilter, dateFilter: '7d' })).toBe(true)
  })

  it('combines facets (all must pass)', () => {
    expect(
      matchesAnnotationFilter(base, { ...noFilter, query: 'beat', colorFilter: 'green' }),
    ).toBe(true)
    expect(matchesAnnotationFilter(base, { ...noFilter, query: 'beat', colorFilter: 'blue' })).toBe(
      false,
    )
  })
})

// Minimal shape for group tests.
const row = (over: Partial<Groupable> = {}): Groupable => ({
  item_id: 'b1',
  item_title: 'B book',
  chapter_index: 0,
  position: 0,
  created_at: 0,
  ...over,
})
type Groupable = {
  item_id: string
  item_title: string
  chapter_index: number | null
  position: number
  created_at: number
}

describe('groupAnnotations', () => {
  it('keeps reading order within a book, ranks sections by newest', () => {
    const rows = [
      row({ item_id: 'a', item_title: 'A', chapter_index: 2, created_at: 10 }),
      row({ item_id: 'b', item_title: 'B', chapter_index: 0, created_at: 50 }),
      row({ item_id: 'a', item_title: 'A', chapter_index: 0, created_at: 5 }),
    ]
    const groups = groupAnnotations(rows, 'newest')
    // Book 'b' (max 50) ranks before 'a' (max 10)...
    expect(groups.map((g) => g.key)).toEqual(['b', 'a'])
    // ...but within 'a' items stay in READING order (ch.0 created 5 before ch.2 created 10).
    expect(groups[1].rows.map((r) => r.created_at)).toEqual([5, 10])
  })

  it('ranks sections by oldest annotation for oldest', () => {
    const rows = [
      row({ item_id: 'a', item_title: 'A', created_at: 10 }),
      row({ item_id: 'b', item_title: 'B', created_at: 3 }),
    ]
    expect(groupAnnotations(rows, 'oldest').map((g) => g.key)).toEqual(['b', 'a'])
  })

  it('orders sections alphabetically for title', () => {
    const rows = [
      row({ item_id: 'z', item_title: 'Zoo' }),
      row({ item_id: 'a', item_title: 'Apple' }),
    ]
    expect(groupAnnotations(rows, 'title').map((g) => g.key)).toEqual(['a', 'z'])
  })
})
