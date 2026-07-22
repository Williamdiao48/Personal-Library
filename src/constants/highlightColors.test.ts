import { describe, it, expect } from 'vitest'
import {
  HIGHLIGHT_COLORS,
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_HIGHLIGHT_LABELS,
  colorCategory,
} from './highlightColors'
import type { HighlightColor } from '../types'

describe('highlight color palette', () => {
  it('exposes the four swatches in order with the yellow default', () => {
    expect(HIGHLIGHT_COLORS.map((c) => c.key)).toEqual(['yellow', 'green', 'blue', 'pink'])
    expect(DEFAULT_HIGHLIGHT_COLOR).toBe('yellow')
    // every swatch has a hex color + a default label
    expect(HIGHLIGHT_COLORS.every((c) => /^#[0-9a-f]{6}$/i.test(c.swatch) && c.label)).toBe(true)
    expect(Object.keys(DEFAULT_HIGHLIGHT_LABELS).sort()).toEqual([
      'blue',
      'green',
      'pink',
      'yellow',
    ])
  })
})

describe('colorCategory', () => {
  const labels: Record<HighlightColor, string> = {
    yellow: 'Argument',
    green: 'Evidence',
    blue: 'Vocabulary / craft',
    pink: 'Question',
  }

  it('uses the user label + the palette swatch for a known key', () => {
    expect(colorCategory('green', labels)).toEqual({
      key: 'green',
      label: 'Evidence',
      swatch: '#4ade80',
    })
  })

  it('falls back to the palette default label when the user label is blank', () => {
    const blank = { ...labels, blue: '' }
    expect(colorCategory('blue', blank)).toEqual({
      key: 'blue',
      label: 'Blue', // HIGHLIGHT_COLORS default for blue
      swatch: '#60a5fa',
    })
  })

  it('falls back to the first swatch for an unknown key', () => {
    const out = colorCategory('mauve' as HighlightColor, labels as Record<HighlightColor, string>)
    // unknown key → def = HIGHLIGHT_COLORS[0] (yellow) swatch; label from labels[key] (undefined) || def.label
    expect(out.swatch).toBe('#facc15')
    expect(out.label).toBe('Yellow')
    expect(out.key).toBe('mauve')
  })
})
