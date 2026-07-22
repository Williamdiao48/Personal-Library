import type { HighlightColor, AnnotationType } from '../../types'
import type { AnnotationSortBy, AnnotationGroupBy } from '../../contexts/SettingsContext'
import { DEFAULT_HIGHLIGHT_COLOR, HIGHLIGHT_COLORS } from '../../constants/highlightColors'

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

/** Alphabetical by source book, then reading order within that book. */
function byTitleThenLocation(a: Sortable, b: Sortable): number {
  const t = a.item_title.localeCompare(b.item_title)
  return t !== 0 ? t : byLocation(a, b)
}

/**
 * Flat item sort (non-mutating), used when NOT grouping by book. `newest`/
 * `oldest` order by creation time; `title` orders by book title then reading
 * order. (Reading order across books is meaningless, so it isn't offered.)
 */
export function sortAnnotations<T extends Sortable>(rows: T[], sortBy: AnnotationSortBy): T[] {
  const copy = [...rows]
  if (sortBy === 'newest') copy.sort((a, b) => b.created_at - a.created_at)
  else if (sortBy === 'oldest') copy.sort((a, b) => a.created_at - b.created_at)
  else copy.sort(byTitleThenLocation)
  return copy
}

// ── Grouping ─────────────────────────────────────────────────────────────────

interface Groupable extends Sortable {
  item_id: string
  type: AnnotationType
  color: HighlightColor | null
}

/** A group's stable key; the view maps it to a display header. For `color`,
 *  standalone notes fall into the `'note'` bucket (no highlight color). */
export interface AnnotationGroup<T> {
  key: string
  rows: T[]
}

function groupKey(a: Groupable, groupBy: AnnotationGroupBy): string {
  if (groupBy === 'none') return 'all'
  if (groupBy === 'type') return a.type
  if (groupBy === 'color') return a.type === 'note' ? 'note' : (a.color ?? DEFAULT_HIGHLIGHT_COLOR)
  return a.item_id
}

// Palette order for `color` grouping, with the note bucket pinned last.
const COLOR_KEY_ORDER = [...HIGHLIGHT_COLORS.map((c) => c.key as string), 'note']

/**
 * Bucket annotations into ordered groups. Sort is interpreted at the level the
 * grouping implies:
 *  - `book`: items inside each book are ALWAYS reading order; the book sections
 *    are ordered by `title` (A–Z), `newest` (section's most-recent, desc), or
 *    `oldest` (section's earliest, asc).
 *  - `color` / `type` / `none`: items are ordered by `sortAnnotations(sortBy)`,
 *    then bucketed with a fixed cluster order (palette w/ note bucket last;
 *    highlights before notes; single group for none).
 */
export function groupAnnotations<T extends Groupable>(
  rows: T[],
  groupBy: AnnotationGroupBy,
  sortBy: AnnotationSortBy,
): AnnotationGroup<T>[] {
  if (groupBy === 'book') {
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

  const sorted = sortAnnotations(rows, sortBy)
  const map = new Map<string, T[]>()
  for (const a of sorted) {
    const key = groupKey(a, groupBy)
    const bucket = map.get(key)
    if (bucket) bucket.push(a)
    else map.set(key, [a])
  }
  const groups: AnnotationGroup<T>[] = [...map.entries()].map(([key, rows]) => ({ key, rows }))

  if (groupBy === 'color') {
    groups.sort((g1, g2) => COLOR_KEY_ORDER.indexOf(g1.key) - COLOR_KEY_ORDER.indexOf(g2.key))
  } else if (groupBy === 'type') {
    const order = (k: string) => (k === 'highlight' ? 0 : 1)
    groups.sort((g1, g2) => order(g1.key) - order(g2.key))
  }
  return groups
}
