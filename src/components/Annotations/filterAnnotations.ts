import type { HighlightColor } from '../../types'
import type { AnnotationSortBy } from '../../contexts/SettingsContext'
import { DEFAULT_HIGHLIGHT_COLOR } from '../../constants/highlightColors'

export interface AnnotationFilter {
  query: string
  colorFilter: string // 'all' | HighlightColor
  themeFilter: string[] // theme ids; empty = any
  bookFilter: string // 'all' | item_id
  dateFilter: string // 'all' | '7d' | '30d' | '365d'
}

interface Filterable {
  selected_text: string | null
  note_text: string | null
  color: HighlightColor | null
  themes: { id: string }[]
  item_id: string
  created_at: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const DATE_WINDOWS: Record<string, number> = { '7d': 7, '30d': 30, '365d': 365 }

/** Does an annotation pass the active filters? Color matches the effective color
 *  (legacy null → yellow); theme filter is OR (any selected theme); query is a
 *  case-insensitive substring over the quote text + note; book matches item_id;
 *  date keeps annotations created within the rolling window. */
export function matchesAnnotationFilter(a: Filterable, f: AnnotationFilter): boolean {
  if (f.colorFilter !== 'all') {
    const color = a.color ?? DEFAULT_HIGHLIGHT_COLOR
    if (color !== f.colorFilter) return false
  }
  if (f.themeFilter.length > 0 && !a.themes.some((t) => f.themeFilter.includes(t.id))) {
    return false
  }
  if (f.bookFilter !== 'all' && a.item_id !== f.bookFilter) return false
  if (f.dateFilter !== 'all') {
    const days = DATE_WINDOWS[f.dateFilter]
    if (days && a.created_at < Date.now() - days * DAY_MS) return false
  }
  const q = f.query.trim().toLowerCase()
  if (q) {
    const hay = `${a.selected_text ?? ''} ${a.note_text ?? ''}`.toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

// ── Sorting ──────────────────────────────────────────────────────────────────

interface Sortable {
  chapter_index: number | null
  position: number
  item_title: string
  created_at: number
}

/** Reading-order comparator: chapter (nulls first) → position → created_at. */
function byLocation(a: Sortable, b: Sortable): number {
  const ca = a.chapter_index ?? -1
  const cb = b.chapter_index ?? -1
  if (ca !== cb) return ca - cb
  if (a.position !== b.position) return a.position - b.position
  return a.created_at - b.created_at
}

// ── Grouping ─────────────────────────────────────────────────────────────────

interface Groupable extends Sortable {
  item_id: string
}

/** A book section: `key` is the source item_id, `rows` are its annotations in
 *  reading order. */
export interface AnnotationGroup<T> {
  key: string
  rows: T[]
}

/**
 * Bucket annotations by source book. Items inside each book are ALWAYS in
 * reading order; the book sections are ordered by `title` (A–Z), `newest`
 * (section's most-recent annotation, desc), or `oldest` (section's earliest,
 * asc).
 */
export function groupAnnotations<T extends Groupable>(
  rows: T[],
  sortBy: AnnotationSortBy,
): AnnotationGroup<T>[] {
  const map = new Map<string, T[]>()
  for (const a of rows) {
    const bucket = map.get(a.item_id)
    if (bucket) bucket.push(a)
    else map.set(a.item_id, [a])
  }
  const groups: AnnotationGroup<T>[] = [...map.entries()].map(([key, rows]) => ({
    key,
    rows: [...rows].sort(byLocation), // reading order within a book, always
  }))
  if (sortBy === 'title') {
    groups.sort((g1, g2) => g1.rows[0].item_title.localeCompare(g2.rows[0].item_title))
  } else {
    const stamp = (g: AnnotationGroup<T>) =>
      sortBy === 'newest'
        ? Math.max(...g.rows.map((r) => r.created_at))
        : Math.min(...g.rows.map((r) => r.created_at))
    groups.sort((g1, g2) => (sortBy === 'newest' ? stamp(g2) - stamp(g1) : stamp(g1) - stamp(g2)))
  }
  return groups
}
