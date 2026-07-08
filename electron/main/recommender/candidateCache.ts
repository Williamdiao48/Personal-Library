import { get, run } from '../db'

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
  run(
    `INSERT INTO candidate_cache (query_key, payload_json, fetched_at)
     VALUES (?, ?, ?)
     ON CONFLICT(query_key) DO UPDATE SET
       payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
    [key, JSON.stringify(payload), now],
  )
}
