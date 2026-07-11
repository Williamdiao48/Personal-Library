import { run, get, all } from '../db'
import { encodeVector, decodeVector } from './embeddingCodec'

// C2.2 (repository half) — CRUD for item_embeddings (migration 18). Imports the
// db singleton, so its tests need the better-sqlite3 Node ABI (openTestDb). The
// pure serialization/hash helpers are in embeddingCodec.ts.

export interface StoredEmbedding {
  embedding: Float32Array
  modelVersion: string
  contentHash: string
  embeddedAt: number
}

/** Lightweight staleness metadata (no BLOB) — what the reconciler reads. */
export interface EmbeddingMeta {
  item_id: string
  model_version: string
  content_hash: string
}

/** Insert or replace an item's embedding row. */
export function upsertEmbedding(row: {
  itemId: string
  embedding: Float32Array
  modelVersion: string
  contentHash: string
  embeddedAt?: number
}): void {
  run(
    `INSERT INTO item_embeddings (item_id, embedding, model_version, content_hash, embedded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       embedding     = excluded.embedding,
       model_version = excluded.model_version,
       content_hash  = excluded.content_hash,
       embedded_at   = excluded.embedded_at`,
    [
      row.itemId,
      encodeVector(row.embedding),
      row.modelVersion,
      row.contentHash,
      row.embeddedAt ?? Date.now(),
    ],
  )
}

/** Full row (vector decoded) for one item, or undefined if not embedded. */
export function getEmbedding(itemId: string): StoredEmbedding | undefined {
  const r = get<{
    embedding: Buffer
    model_version: string
    content_hash: string
    embedded_at: number
  }>(
    `SELECT embedding, model_version, content_hash, embedded_at
     FROM item_embeddings WHERE item_id = ?`,
    [itemId],
  )
  if (!r) return undefined
  return {
    embedding: decodeVector(r.embedding),
    modelVersion: r.model_version,
    contentHash: r.content_hash,
    embeddedAt: r.embedded_at,
  }
}

/** Cheap staleness metadata for every embedded item (no BLOBs) — for reconcile. */
export function getAllEmbeddingMeta(): EmbeddingMeta[] {
  return all<EmbeddingMeta>(`SELECT item_id, model_version, content_hash FROM item_embeddings`)
}

/** Load decoded vectors for a set of ids (missing ids are simply absent). */
export function loadVectors(itemIds: string[]): Map<string, Float32Array> {
  const map = new Map<string, Float32Array>()
  const CHUNK = 500 // stay under SQLite's bound-parameter limit (999)
  for (let i = 0; i < itemIds.length; i += CHUNK) {
    const slice = itemIds.slice(i, i + CHUNK)
    if (slice.length === 0) continue
    const rows = all<{ item_id: string; embedding: Buffer }>(
      `SELECT item_id, embedding FROM item_embeddings
       WHERE item_id IN (${slice.map(() => '?').join(',')})`,
      slice,
    )
    for (const r of rows) map.set(r.item_id, decodeVector(r.embedding))
  }
  return map
}
