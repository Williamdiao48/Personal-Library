import { describe, it, expect } from 'vitest'
import { canonicalSubjectKey, dedupeSubjects } from './subjectNormalize'

describe('canonicalSubjectKey', () => {
  it('collapses the trailing fiction/literature qualifier variants of a topic', () => {
    for (const s of [
      'Bears',
      'Bears, Fiction',
      'Bears, Juvenile fiction',
      'Bears -- Fiction',
      'Bears — Juvenile literature',
      'Bears: Fiction',
      'Bears in fiction',
      'Bears in literature',
    ]) {
      expect(canonicalSubjectKey(s)).toBe('bears')
    }
  })

  it('peels stacked qualifiers', () => {
    expect(canonicalSubjectKey('Bears, Juvenile fiction, Fiction')).toBe('bears')
  })

  it('strips a parenthetical fictitious-character marker', () => {
    expect(canonicalSubjectKey('Paddington (Fictitious character)')).toBe('paddington')
  })

  it('leaves compound genres whose "fiction" has no separator ALONE', () => {
    expect(canonicalSubjectKey('Science Fiction')).toBe('science fiction')
    expect(canonicalSubjectKey('Fantasy Fiction')).toBe('fantasy fiction')
    expect(canonicalSubjectKey('Historical Fiction')).toBe('historical fiction')
  })

  it('normalizes case and whitespace', () => {
    expect(canonicalSubjectKey('  Kings   and Rulers ')).toBe('kings and rulers')
  })

  it('does not over-strip a topic that merely contains a qualifier word', () => {
    // "Literature" only peels when it follows a separator — a bare topic keeps it.
    expect(canonicalSubjectKey('American literature')).toBe('american literature')
  })
})

describe('dedupeSubjects', () => {
  it('collapses variants to one entry, keeping the shortest surface form', () => {
    expect(dedupeSubjects(['Bears, Fiction', 'Bears', 'Bears -- Juvenile fiction'])).toEqual([
      'Bears',
    ])
  })

  it('preserves first-seen key order and distinct topics', () => {
    expect(
      dedupeSubjects(['Bears, Fiction', 'Wizards', 'Bears', 'Wizards, Juvenile fiction']),
    ).toEqual(['Bears', 'Wizards'])
  })

  it('drops blank/whitespace subjects', () => {
    expect(dedupeSubjects(['', '  ', 'Bears'])).toEqual(['Bears'])
  })

  it('keeps compound genres separate from a topic', () => {
    expect(dedupeSubjects(['Science Fiction', 'Bears', 'Bears, Fiction'])).toEqual([
      'Science Fiction',
      'Bears',
    ])
  })
})
