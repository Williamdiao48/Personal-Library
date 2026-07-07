import { all } from '../db'
import { computeStale, type ReconcileItem, type ExistingEmbedding } from './reconcile'
import { itemMetadataText, type EmbedItemInput } from './embeddingText'
import { embeddingContentHash } from './embeddingCodec'
import { getAllEmbeddingMeta, upsertEmbedding } from './store'
import type { EmbedHost } from './embedHost'

// C2.4 — the backfill runner (orchestration, D-C2-1). Reads the active items +
// tags + the embedding metadata already on disk, asks the reconciler which are
// stale, embeds only those through the injected host, and upserts each row.
// Main owns the DB here; the host owns the model (worker, C2.5). The pass is
// guarded (concurrent callers coalesce onto one run) and debounced (a bulk
// import fires one run, not one per file). A missed change is caught by the next
// trigger — the hash gate makes correctness independent of catching every event.

/** Coalesce a burst of triggers into a single run this many ms after the last one. */
export const DEBOUNCE_MS = 1500

export interface BackfillResult {
  /** Active items examined. */
  scanned: number
  /** Items the reconciler flagged as needing (re)embedding. */
  stale: number
  /** Rows successfully embedded + written this pass. */
  embedded: number
  /** Stale items whose embed threw (logged, skipped — a bad item can't abort the pass). */
  failed: number
}

/** The item columns the backfill needs — a superset of ReconcileItem + EmbedItemInput. */
type BackfillRow = ReconcileItem & EmbedItemInput

function loadActiveItems(): BackfillRow[] {
  return all<BackfillRow>(`
    SELECT id, title, author, description, review, content_type, file_path, content_hash
    FROM items
    WHERE deleted_at IS NULL
  `)
}

function loadTagsByItem(): Map<string, string[]> {
  const rows = all<{ item_id: string; name: string }>(`
    SELECT it.item_id, t.name
    FROM item_tags it
    JOIN tags t ON t.id = it.tag_id
    JOIN items i ON i.id = it.item_id
    WHERE i.deleted_at IS NULL
  `)
  const map = new Map<string, string[]>()
  for (const r of rows) {
    const list = map.get(r.item_id)
    if (list) list.push(r.name)
    else map.set(r.item_id, [r.name])
  }
  return map
}

async function doBackfill(host: EmbedHost): Promise<BackfillResult> {
  const items = loadActiveItems()
  const tagsByItem = loadTagsByItem()

  const existing = new Map<string, ExistingEmbedding>()
  for (const m of getAllEmbeddingMeta()) {
    existing.set(m.item_id, { content_hash: m.content_hash, model_version: m.model_version })
  }

  const staleIds = computeStale(items, tagsByItem, existing, host.modelVersion)
  const byId = new Map(items.map((it) => [it.id, it]))

  let embedded = 0
  let failed = 0
  for (const id of staleIds) {
    const item = byId.get(id)
    if (!item) continue // shouldn't happen — computeStale only returns ids from `items`
    const tags = tagsByItem.get(id) ?? []
    try {
      const vec = await host.embed(item, tags)
      // Store the SAME hash the reconciler will re-derive next pass, so an
      // unchanged item is skipped rather than re-embedded forever.
      const contentHash = embeddingContentHash(itemMetadataText(item, tags), item.content_hash)
      upsertEmbedding({
        itemId: id,
        embedding: vec,
        modelVersion: host.modelVersion,
        contentHash,
        embeddedAt: Date.now(),
      })
      embedded++
    } catch (err) {
      failed++
      console.error(`[backfill] failed to embed item ${id}:`, err)
    }
  }

  return { scanned: items.length, stale: staleIds.length, embedded, failed }
}

let running: Promise<BackfillResult> | null = null

/**
 * Run one full reconcile→embed pass. Concurrent callers coalesce onto the
 * in-flight run (the guard), so a trigger arriving mid-pass doesn't kick a
 * second overlapping backfill; its changes are picked up by the next trigger.
 */
export function runBackfill(host: EmbedHost): Promise<BackfillResult> {
  if (running) return running
  running = doBackfill(host).finally(() => {
    running = null
  })
  return running
}

let timer: ReturnType<typeof setTimeout> | null = null

/**
 * Debounced entry point for lifecycle triggers (C2.6). A burst of events
 * (e.g. importing 50 files) collapses into a single backfill fired `delayMs`
 * after the last trigger. Fire-and-forget: never blocks the caller (capture
 * returns immediately; embedding happens after).
 */
export function scheduleBackfill(host: EmbedHost, delayMs = DEBOUNCE_MS): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void runBackfill(host).catch((err) => console.error('[backfill] run failed:', err))
  }, delayMs)
}

/** Test-only: drop the debounce timer so a pending schedule can't leak across tests. */
export function _resetBackfillState(): void {
  if (timer) clearTimeout(timer)
  timer = null
  running = null
}
