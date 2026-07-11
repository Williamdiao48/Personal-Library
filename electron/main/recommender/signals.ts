import { all } from '../db'
import type { ReadingStatus } from '../../../src/types'

// C3.3 — load the per-item feedback signals the affinity ladder (§7.2) consumes:
// explicit rating/review plus the implicit reading signals (status, how far they
// got, how long they spent). One query over items ⋈ progress ⋈ a reading_sessions
// duration aggregate, driven from active items only (deleted_at IS NULL). Imports
// the db singleton → tests need the better-sqlite3 Node ABI (openTestDb).
//
// The effective-status inference (explicit status else scroll-derived) mirrors the
// raw-SQL predicates in stats.ts/goals.ts rather than importing the renderer's
// getEffectiveStatus (D-C3-1) — main-process code re-expresses that tiny rule
// locally. We infer from `depth` (the furthest point ever reached, preferring
// max_scroll_position) so an item read to the end but scrolled back still reads as
// finished — the right signal for taste.

/** One library item's feedback signals, ready for the affinity ladder. */
export interface ItemWithSignals {
  id: string
  /** Explicit star rating (0.5-steps, 0..5) or null when unrated. `0` ≠ null. */
  rating: number | null
  /** Effective reading status (explicit if set, else inferred from `depth`). */
  status: ReadingStatus
  /** Furthest fraction ever read, clamped 0..1 (max of max_scroll/scroll). */
  depth: number
  /** Total time spent reading this item, in minutes (0 if never). */
  minutes: number
  /** Whether the user wrote a non-empty review (a small confidence signal). */
  hasReview: boolean
}

interface SignalRow {
  id: string
  rating: number | null
  review: string | null
  status: ReadingStatus | null
  scroll_position: number | null
  max_scroll_position: number | null
  total_ms: number | null
}

function depthOf(maxScroll: number | null, scroll: number | null): number {
  const d = Math.max(maxScroll ?? 0, scroll ?? 0)
  return Math.min(Math.max(d, 0), 1)
}

function effectiveStatus(explicit: ReadingStatus | null, depth: number): ReadingStatus {
  if (explicit != null) return explicit
  if (depth <= 0) return 'unread'
  if (depth >= 1) return 'finished'
  return 'reading'
}

/** Read every active item's feedback signals (see ItemWithSignals). */
export function loadItemSignals(): ItemWithSignals[] {
  const rows = all<SignalRow>(`
    SELECT i.id                  AS id,
           i.rating              AS rating,
           i.review              AS review,
           p.status              AS status,
           p.scroll_position     AS scroll_position,
           p.max_scroll_position AS max_scroll_position,
           s.total_ms            AS total_ms
    FROM items i
    LEFT JOIN progress p ON p.item_id = i.id
    LEFT JOIN (
      SELECT item_id, SUM(duration) AS total_ms
      FROM   reading_sessions
      GROUP  BY item_id
    ) s ON s.item_id = i.id
    WHERE i.deleted_at IS NULL
  `)

  return rows.map((r) => {
    const depth = depthOf(r.max_scroll_position, r.scroll_position)
    return {
      id: r.id,
      rating: r.rating,
      status: effectiveStatus(r.status, depth),
      depth,
      minutes: (r.total_ms ?? 0) / 60_000,
      hasReview: typeof r.review === 'string' && r.review.trim().length > 0,
    }
  })
}
