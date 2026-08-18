// ─────────────────────────────────────────────────────────────────────────────
// Table specs — the single source of truth for WHAT syncs and HOW.
//
// One SyncSpec per syncable table, consumed by the pure reconcile engine
// (reconcile.ts) and the cloudRepo/orchestrator (Chunk 4). Column names are the
// LOCAL SQLite names, which are 1:1 with the Postgres mirror (server/supabase
// migrations) MINUS `user_id` (cloudRepo adds it on push, strips it on pull) and
// MINUS device-local columns (file_path, cover_path, cloud_backup, dirty — never
// synced).
//
// purged_at IS synced (Tier 1 #4): permanent-delete cascades globally so the
// shared R2 blob can be reaped once no un-purged item references it — and so a
// peer hides a permanently-deleted item from its Trash (its Trash query already
// filters purged_at IS NULL).
//
// Order matters: parents precede children so a pull applies FKs top-down (items
// before its children; tags before item_tags; collections before collection_items;
// annotations + annotation_themes before annotation_theme_links).
// ─────────────────────────────────────────────────────────────────────────────

export type SyncRow = Record<string, unknown> & {
  updated_at?: number | null
  deleted_at?: number | null
  /** Local-only push flag; present on local rows, absent on rows pulled from Postgres. */
  dirty?: number
}

export interface SyncSpec {
  table: string
  /** Primary-key columns (local shape — no user_id). Composite for join tables. */
  key: string[]
  /** Columns synced to/from Postgres (includes key + updated_at + deleted_at). */
  columns: string[]
  /**
   * 'lww' — whole-row last-write-wins on updated_at (the default).
   * 'append' — immutable events (reading_sessions): union by key, no LWW, no
   *   tombstone; a row is applied iff the local side lacks it.
   */
  mode: 'lww' | 'append'
  /**
   * For tables with a per-user UNIQUE(name): the column two devices can collide
   * on when both create the same-named row offline (C4 natural-key merge).
   */
  naturalKey?: string
  /**
   * Tables + columns that reference this table's id, so a C4 merge can rewrite a
   * loser's references onto the survivor. Only set on naturalKey tables.
   */
  referencedBy?: { table: string; col: string }[]
  /**
   * Per-column merge overrides that OPT OUT of whole-row LWW for a monotonic field
   * so it converges independently of which row wins the row-level LWW:
   *   'max' — a grow-only max register. The field is folded to max(local, incoming)
   *           on every pull/readback, so it can never regress across the sync
   *           boundary (mirrors the local MAX(...) upsert). Backed server-side by a
   *           GREATEST trigger (see the progress_max_register migration) so the
   *           authoritative copy is order-independent too.
   * Columns absent here follow the row's LWW winner as usual.
   */
  merge?: Record<string, 'max'>
}

const LWW = 'lww' as const

export const SYNC_SPECS: SyncSpec[] = [
  {
    table: 'items',
    key: ['id'],
    // blob_hash/cover_hash are the R2 object keys; file_path/cover_path are the
    // PORTABLE (relative, id-based) content paths — synced so a second device can
    // both name the row (file_path NOT NULL) and resolve the bytes via pull-on-open.
    // All four added to the server items table by a Phase-3 migration.
    columns: [
      'id',
      'title',
      'author',
      'source_url',
      'content_type',
      'file_path',
      'cover_path',
      'word_count',
      'description',
      'date_saved',
      'date_modified',
      'derived_from',
      'chapter_start',
      'chapter_end',
      'content_hash',
      'rating',
      'review',
      'blob_hash',
      'cover_hash',
      // sha256 of the RAW imported epub/pdf bytes (util/capture fileHash.ts). Synced
      // so a book imported on one device de-dups when the identical file is imported
      // on another device of the same account (the local findDuplicateByFileHash
      // query then matches the pulled-in row). Cross-USER dedup is a separate future
      // design (shared storage + proof-of-possession) — not implied by syncing this.
      'file_hash',
      'updated_at',
      'deleted_at',
      // Synced so permanent-delete cascades: a purge on one device propagates and
      // (a) hides the item from every device's Trash (getTrashed filters
      // purged_at IS NULL) and (b) lets the reaper reclaim the shared R2 blob once
      // no un-purged item references it. Written at purge time on a tombstone row.
      'purged_at',
    ],
    mode: LWW,
  },
  {
    table: 'progress',
    key: ['item_id'],
    columns: [
      'item_id',
      'scroll_position',
      'last_read_at',
      'scroll_chapter',
      'scroll_y',
      'status',
      'max_scroll_position',
      'updated_at',
      'deleted_at',
    ],
    mode: LWW,
    // max_scroll_position is the "furthest point ever read" high-water mark: locally
    // monotonic (library.ts writes it via MAX(...)), and three subsystems depend on
    // that (progress, the recommender's depth/status signal, stats' words-read). Plain
    // whole-row LWW would let a peer's newer-but-shallower write drag it backward, so
    // it's a grow-only max register instead — folded to max(local, incoming) on every
    // pull/readback and clamped by a server-side GREATEST trigger.
    merge: { max_scroll_position: 'max' },
  },
  {
    table: 'tags',
    key: ['id'],
    columns: ['id', 'name', 'color', 'updated_at', 'deleted_at'],
    mode: LWW,
    naturalKey: 'name',
    referencedBy: [{ table: 'item_tags', col: 'tag_id' }],
  },
  {
    table: 'item_tags',
    key: ['item_id', 'tag_id'],
    columns: ['item_id', 'tag_id', 'updated_at', 'deleted_at'],
    mode: LWW,
  },
  {
    table: 'collections',
    key: ['id'],
    columns: ['id', 'name', 'date_created', 'updated_at', 'deleted_at'],
    mode: LWW,
    naturalKey: 'name',
    referencedBy: [{ table: 'collection_items', col: 'collection_id' }],
  },
  {
    table: 'collection_items',
    key: ['collection_id', 'item_id'],
    columns: ['collection_id', 'item_id', 'sort_order', 'updated_at', 'deleted_at'],
    mode: LWW,
  },
  {
    // Append-only events (Decision 4). Local rows carry no updated_at/deleted_at;
    // cloudRepo supplies a server updated_at on push (the server restamps anyway).
    table: 'reading_sessions',
    key: ['id'],
    columns: ['id', 'item_id', 'started_at', 'ended_at', 'duration'],
    mode: 'append',
  },
  {
    table: 'annotations',
    key: ['id'],
    columns: [
      'id',
      'item_id',
      'type',
      'chapter_index',
      'position',
      'selected_text',
      'context_before',
      'context_after',
      'note_text',
      'created_at',
      'sort_order',
      'color',
      'rects',
      'book_fraction',
      'updated_at',
      'deleted_at',
    ],
    mode: LWW,
  },
  {
    table: 'annotation_themes',
    key: ['id'],
    columns: ['id', 'name', 'created_at', 'updated_at', 'deleted_at'],
    mode: LWW,
    naturalKey: 'name',
    referencedBy: [{ table: 'annotation_theme_links', col: 'theme_id' }],
  },
  {
    table: 'annotation_theme_links',
    key: ['annotation_id', 'theme_id'],
    columns: ['annotation_id', 'theme_id', 'updated_at', 'deleted_at'],
    mode: LWW,
  },
  {
    table: 'goals',
    key: ['id'],
    columns: [
      'id',
      'type',
      'title',
      'period',
      'target_minutes',
      'target_count',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
    mode: LWW,
  },
  {
    table: 'goal_items',
    key: ['goal_id', 'item_id'],
    columns: ['goal_id', 'item_id', 'updated_at', 'deleted_at'],
    mode: LWW,
  },
]

export const SYNC_SPEC_BY_TABLE: Record<string, SyncSpec> = Object.fromEntries(
  SYNC_SPECS.map((s) => [s.table, s]),
)
