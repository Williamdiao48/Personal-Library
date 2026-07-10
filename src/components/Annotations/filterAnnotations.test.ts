import { describe, it, expect } from 'vitest'
import { matchesAnnotationFilter } from './filterAnnotations'

const base = {
  selected_text: 'So we beat on, boats against the current',
  note_text: 'green light imagery',
  color: 'green' as const,
  themes: [{ id: 't1' }, { id: 't2' }],
}

const noFilter = { query: '', colorFilter: 'all', themeFilter: [] as string[] }

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

  it('combines facets (all must pass)', () => {
    expect(
      matchesAnnotationFilter(base, { query: 'beat', colorFilter: 'green', themeFilter: ['t1'] }),
    ).toBe(true)
    expect(
      matchesAnnotationFilter(base, { query: 'beat', colorFilter: 'blue', themeFilter: ['t1'] }),
    ).toBe(false)
  })
})
