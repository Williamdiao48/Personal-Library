import { run, all } from '../db'
import { encodeVector, decodeVector } from './embeddingCodec'

// Perf cache for recommendation-CANDIDATE embeddings (migration 24). Mirrors
// store.ts's item_embeddings CRUD, but keyed by a candidate's `sourceId` (an
// OpenLibrary work key or a fic URL) and scoped by `model_version`, so a Discover
// refresh reuses vectors from a prior run instead of re-embedding every candidate
// on the model (the main CPU cost of a warm refresh). Imports the db singleton →
// its tests need the Node ABI. The pure codec lives in embeddingCodec.ts.

/** Decoded cached vectors for the given sourceIds under the current model. */
export function loadCandidateVectors(
  sourceIds: string[],
  modelVersion: string,
): Map<string, Float32Array> {
  const map = new Map<string, Float32Array>()
  const CHUNK = 400 // stay under SQLite's bound-parameter limit (999), room for modelVersion
  for (let i = 0; i < sourceIds.length; i += CHUNK) {
    const slice = sourceIds.slice(i, i + CHUNK)
    if (slice.length === 0) continue
    const rows = all<{ source_id: string; embedding: Buffer }>(
      `SELECT source_id, embedding FROM candidate_embeddings
       WHERE model_version = ? AND source_id IN (${slice.map(() => '?').join(',')})`,
      [modelVersion, ...slice],
    )
    for (const r of rows) map.set(r.source_id, decodeVector(r.embedding))
  }
  return map
}

/** Upsert a batch of candidate vectors under the current model. `cached_at` stamps
 *  each write so the startup TTL sweep (evictStaleCandidates, L5) can age rows out;
 *  a re-use refreshes it so an actively-served vector never expires. */
export function saveCandidateVectors(
  entries: { sourceId: string; vec: Float32Array }[],
  modelVersion: string,
  now: number = Date.now(),
): void {
  for (const e of entries) {
    run(
      `INSERT INTO candidate_embeddings (source_id, embedding, model_version, cached_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         embedding     = excluded.embedding,
         model_version = excluded.model_version,
         cached_at     = excluded.cached_at`,
      [e.sourceId, encodeVector(e.vec), modelVersion, now],
    )
  }
}
