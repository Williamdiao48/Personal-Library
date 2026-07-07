import { itemMetadataText } from './embeddingText'
import { embeddingContentHash } from './embeddingCodec'

// C2.3 — the reconciler (pure staleness core, D-C2-1). Given the active items
// (+ their tags) and the embedding metadata already on disk, decide which items
// need (re)embedding. No model, no DB, no I/O — the whole point is that
// correctness is a hash comparison, independent of which lifecycle event fired.

/** Item fields the reconciler needs (structurally satisfied by Item). */
export interface ReconcileItem {
  id: string
  title: string
  author?: string | null
  description?: string | null
  review?: string | null
  /** items.content_hash — the full-text hash; NULL for immutable imports (D-C2-3). */
  content_hash: string | null
}

/** The staleness metadata already stored for an item (from getAllEmbeddingMeta). */
export interface ExistingEmbedding {
  content_hash: string
  model_version: string
}

/**
 * Return the ids that need (re)embedding: no row yet, the content changed
 * (Tier-A metadata text OR items.content_hash), or the row was produced by a
 * different model_version. Rows whose hash + model match are skipped.
 *
 * Callers pass the *active* items; a soft-deleted item simply isn't in `items`
 * (its stale row is harmless and a hard delete cascades it away).
 */
export function computeStale(
  items: ReconcileItem[],
  tagsByItem: Map<string, string[]>,
  existing: Map<string, ExistingEmbedding>,
  modelVersion: string,
): string[] {
  const stale: string[] = []
  for (const item of items) {
    const metaText = itemMetadataText(item, tagsByItem.get(item.id) ?? [])
    const wantHash = embeddingContentHash(metaText, item.content_hash)
    const have = existing.get(item.id)
    if (!have || have.content_hash !== wantHash || have.model_version !== modelVersion) {
      stale.push(item.id)
    }
  }
  return stale
}
