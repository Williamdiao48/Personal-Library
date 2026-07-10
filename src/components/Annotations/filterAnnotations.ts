import type { HighlightColor } from '../../types'
import { DEFAULT_HIGHLIGHT_COLOR } from '../../constants/highlightColors'

export interface AnnotationFilter {
  query: string
  colorFilter: string // 'all' | HighlightColor
  themeFilter: string[] // theme ids; empty = any
}

interface Filterable {
  selected_text: string | null
  note_text: string | null
  color: HighlightColor | null
  themes: { id: string }[]
}

/** Does an annotation pass the active filters? Color matches the effective color
 *  (legacy null → yellow); theme filter is OR (any selected theme); query is a
 *  case-insensitive substring over the quote text + note. */
export function matchesAnnotationFilter(a: Filterable, f: AnnotationFilter): boolean {
  if (f.colorFilter !== 'all') {
    const color = a.color ?? DEFAULT_HIGHLIGHT_COLOR
    if (color !== f.colorFilter) return false
  }
  if (f.themeFilter.length > 0 && !a.themes.some((t) => f.themeFilter.includes(t.id))) {
    return false
  }
  const q = f.query.trim().toLowerCase()
  if (q) {
    const hay = `${a.selected_text ?? ''} ${a.note_text ?? ''}`.toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}
