import { get, run, isDbOpen } from '../db'

// Shared TTL cache over the candidate_cache table (migration 20). The fanfic
// sources (AO3/FFN) store their already-normalized Candidate[] JSON keyed by a
// site-namespaced query key, so repeat recommend() calls and the eyeball harness
// don't re-scrape. (OpenLibrary keeps its own raw-doc cache in candidates.ts.)

interface CacheRow {
  payload_json: string
  fetched_at: number
}

/** Fresh cached payload for a key, or null on miss / stale / parse failure. */
export function readCandidateCache<T>(key: string, ttlMs: number, now: number): T | null {
  // These caches are written from fire-and-forget background prewarm/backfill work
  // (schedulePrewarm), which can still be mid-flight when a backup import closes the
  // DB for its swap. Treat a closed DB as a cache miss rather than throwing an
  // unhandled rejection off the speculative pass (the entry re-derives on next use).
  if (!isDbOpen()) return null
  const row = get<CacheRow>(
    `SELECT payload_json, fetched_at FROM candidate_cache WHERE query_key = ?`,
    [key],
  )
  if (!row || now - row.fetched_at > ttlMs) return null
  try {
    return JSON.parse(row.payload_json) as T
  } catch {
    return null
  }
}

export function writeCandidateCache(key: string, payload: unknown, now: number): void {
  if (!isDbOpen()) return // DB closed under a background prewarm (import swap) — skip.
  run(
    `INSERT INTO candidate_cache (query_key, payload_json, fetched_at)
     VALUES (?, ?, ?)
     ON CONFLICT(query_key) DO UPDATE SET
       payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
    [key, JSON.stringify(payload), now],
  )
}

// Retention window for the recommendation-candidate caches (L5). Both tables hold
// re-derivable data — a cache miss just re-scrapes (candidate_cache) or re-embeds
// (candidate_embeddings) — so a row untouched for this long is almost certainly a
// query/candidate the reader no longer surfaces; evicting it bounds slow growth.
export const CANDIDATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Delete candidate_cache + candidate_embeddings rows older than the retention
 * window (called once at startup, alongside the trash purge). candidate_embeddings
 * rows written before migration 33 have a NULL `cached_at` and are swept too — they
 * re-embed cheaply on next use. Returns the total rows removed.
 */
export function evictStaleCandidates(now: number, ttlMs = CANDIDATE_RETENTION_MS): number {
  const cutoff = now - ttlMs
  const cache = run(`DELETE FROM candidate_cache WHERE fetched_at < ?`, [cutoff])
  const embeddings = run(
    `DELETE FROM candidate_embeddings WHERE cached_at IS NULL OR cached_at < ?`,
    [cutoff],
  )
  return cache.changes + embeddings.changes
}
