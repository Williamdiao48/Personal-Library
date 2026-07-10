import type { HighlightColor } from '../types'

/**
 * The highlight color palette, in swatch order. The `key` is what gets stored
 * on the annotation (and set as `data-color` on the mark); the per-theme CSS in
 * reader.css / epub-reader.css maps each key to an actual background/underline.
 * `swatch` is only the solid dot shown in the picker UI.
 */
export interface HighlightColorDef {
  key: HighlightColor
  label: string
  swatch: string
}

export const HIGHLIGHT_COLORS: HighlightColorDef[] = [
  { key: 'yellow', label: 'Yellow', swatch: '#facc15' },
  { key: 'green', label: 'Green', swatch: '#4ade80' },
  { key: 'blue', label: 'Blue', swatch: '#60a5fa' },
  { key: 'pink', label: 'Pink', swatch: '#f472b6' },
]

/** Fallback for legacy highlights (color === null) and the default swatch. */
export const DEFAULT_HIGHLIGHT_COLOR: HighlightColor = 'yellow'
