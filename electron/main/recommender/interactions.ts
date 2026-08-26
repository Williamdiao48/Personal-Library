import { run, all } from '../db'
import type { OpenInteraction } from './engagement'

// Recommender #3 — the db layer for Discover card opens (ADR-0011, migration 44).
// `recordOpen` logs/updates one open in discover_interactions; `loadOpens` reads them
// back for the pure engagement layer (engagement.ts) to weight and cluster. Imports
// the db singleton → tests need the better-sqlite3 Node ABI (openTestDb). LOCAL-ONLY:
// discover_interactions is not in SYNC_SPECS (engagement is device-local behavior,
// like dismissed_recommendations).

/** The card fields captured when a Discover recommendation is opened. Mirrors the
 *  identity/preview columns of dismissed_recommendations, keyed by the same sourceId
 *  space (fic URL / OL work key) so the opened card's cached vector is reusable. */
export interface OpenCardInput {
  sourceId: string
  title: string
  author: string | null
  source: string | null
  url: string | null
  subjects: string[]
}

/**
 * Record that a Discover card was opened. First open inserts (open_count 1); a repeat
 * open bumps open_count and refreshes opened_at (and re-stamps the preview fields in
 * case the card metadata changed between refreshes). Upsert on the sourceId PK.
 */
export function recordOpen(rec: OpenCardInput, now: number = Date.now()): void {
  run(
    `INSERT INTO discover_interactions
       (source_id, title, author, source, url, subjects, opened_at, open_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(source_id) DO UPDATE SET
       opened_at  = excluded.opened_at,
       open_count = open_count + 1,
       title      = excluded.title,
       author     = excluded.author,
       source     = excluded.source,
       url        = excluded.url,
       subjects   = excluded.subjects`,
    [
      rec.sourceId,
      rec.title,
      rec.author,
      rec.source,
      rec.url,
      JSON.stringify(rec.subjects ?? []),
      now,
    ],
  )
}

/** Every logged open, as the pure engagement layer consumes it (recency-weighted
 *  centroid + time-boxed suppression). The set is small (one row per opened card),
 *  so no windowing here — engagement.ts decays old opens toward zero weight itself. */
export function loadOpens(): OpenInteraction[] {
  const rows = all<{ source_id: string; opened_at: number; open_count: number }>(
    `SELECT source_id, opened_at, open_count FROM discover_interactions`,
  )
  return rows.map((r) => ({
    sourceId: r.source_id,
    openedAt: r.opened_at,
    openCount: r.open_count,
  }))
}
