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

/**
 * Student-oriented default meaning for each color. Users can rename these in
 * Settings; they drive the color-category legend + filters. Stored in AppSettings.
 */
export const DEFAULT_HIGHLIGHT_LABELS: Record<HighlightColor, string> = {
  yellow: 'Key quote',
  green: 'Theme / motif',
  blue: 'Vocabulary / craft',
  pink: 'Question',
}

/** The color category as a {key,label} pair, using the user's custom labels. */
export function colorCategory(
  key: HighlightColor,
  labels: Record<HighlightColor, string>,
): { key: HighlightColor; label: string; swatch: string } {
  const def = HIGHLIGHT_COLORS.find((c) => c.key === key) ?? HIGHLIGHT_COLORS[0]
  return { key, label: labels[key] || def.label, swatch: def.swatch }
}
