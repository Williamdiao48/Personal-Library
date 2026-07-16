import { describe, it, expect } from 'vitest'
import { buildTasteDigest, DIGEST_CAPS } from './tasteDigest'
import type { TasteSeeds, WeightedTerm } from './tasteSeeds'

// Pure — a deterministic transform of buildTasteSeeds() output. No DB/ABI.

const wt = (...terms: string[]): WeightedTerm[] =>
  terms.map((term, i) => ({ term, weight: terms.length - i }))

const seeds = (over: Partial<TasteSeeds> = {}): TasteSeeds => ({
  authors: [],
  fandoms: [],
  relationships: [],
  characters: [],
  freeforms: [],
  genres: [],
  ...over,
})

describe('buildTasteDigest', () => {
  it('emits one labeled line per non-empty category, in fixed order', () => {
    const out = buildTasteDigest(
      seeds({
        authors: wt('Le Guin', 'Butler'),
        genres: wt('Science Fiction'),
        freeforms: wt('Slow Burn'),
      }),
    )
    expect(out).toBe(
      'Favorite authors: Le Guin, Butler\nGenres: Science Fiction\nThemes and tags: Slow Burn',
    )
  })

  it('skips empty categories entirely (no blank lines)', () => {
    expect(buildTasteDigest(seeds({ authors: wt('A') }))).toBe('Favorite authors: A')
  })

  it('returns an empty string for thin/empty taste (caller then skips the LLM)', () => {
    expect(buildTasteDigest(seeds())).toBe('')
  })

  it('caps each category to its DIGEST_CAPS limit', () => {
    const many = wt(...Array.from({ length: 30 }, (_, i) => `A${i}`))
    const out = buildTasteDigest(seeds({ authors: many }))
    expect(out.slice('Favorite authors: '.length).split(', ')).toHaveLength(DIGEST_CAPS.authors)
  })

  it('ignores relationship/character categories (not part of the book digest)', () => {
    expect(buildTasteDigest(seeds({ relationships: wt('A/B'), characters: wt('C') }))).toBe('')
  })
})
