import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { openTestDb, closeTestDb } from '../../../test/db/harness'
import { bringUpSchema, CURRENT_VERSION, MIGRATIONS } from './index'
import { SCHEMA } from './schema'

// Verifies a fresh database can be brought up cleanly and reaches the current
// schema version — the fresh-install path, which no existing user DB exercises.

describe('database bring-up', () => {
  afterEach(() => closeTestDb())

  it('brings a fresh in-memory DB up to CURRENT_VERSION', () => {
    const db = openTestDb()
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_VERSION)
  })

  it('is idempotent — re-running bringUpSchema on an up-to-date DB is a no-op', () => {
    const db = openTestDb()
    expect(() => bringUpSchema(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_VERSION)
  })

  it('creates every expected table', () => {
    const db = openTestDb()
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    for (const t of [
      'items',
      'progress',
      'tags',
      'item_tags',
      'collections',
      'collection_items',
      'reading_sessions',
      'annotations',
      'goals',
      'goal_items',
      'item_embeddings',
      'taste_seeds',
      'dismissed_recommendations',
      'candidate_cache',
      'item_source_tags',
      'item_source_meta',
      'tag_alias',
      'discover_cache',
      'candidate_embeddings',
      'annotation_themes',
      'annotation_theme_links',
      'blob_sync',
      'discover_interactions',
    ]) {
      expect(tables).toContain(t)
    }
  })

  // Index migrations from the 2026-07-14 audit follow-ups.
  const indexesOf = (db: Database.Database) =>
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
    ).map((r) => r.name)

  it('creates idx_items_derived_from (PERF-1, migration 29)', () => {
    const db = openTestDb()
    expect(indexesOf(db)).toContain('idx_items_derived_from')
  })

  it('drops the redundant idx_item_tags_item_id (LEAN-2, migration 30)', () => {
    const db = openTestDb()
    const indexes = indexesOf(db)
    expect(indexes).not.toContain('idx_item_tags_item_id')
    // The still-needed reverse index (bare tag_id lookups) must survive.
    expect(indexes).toContain('idx_item_tags_tag_id')
  })

  const colsOf = (db: Database.Database, table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

  // Regression guard for the fresh-install crash: every column an ALTER-ADD
  // migration contributes must be present in the final schema. If someone ever
  // re-adds one of these to SCHEMA (re-introducing the collision) OR drops the
  // migration, this fails.
  it('items has all migration-added columns', () => {
    const db = openTestDb()
    expect(colsOf(db, 'items')).toEqual(
      expect.arrayContaining([
        'derived_from',
        'chapter_start',
        'chapter_end',
        'content_hash',
        'deleted_at',
        'rating',
        'review',
        'cloud_backup',
        'cover_hash',
        'blob_hash',
        'file_hash',
      ]),
    )
  })

  it('creates idx_items_file_hash (import de-dup, migration 39)', () => {
    const db = openTestDb()
    expect(indexesOf(db)).toContain('idx_items_file_hash')
  })

  it('progress has all migration-added columns', () => {
    const db = openTestDb()
    expect(colsOf(db, 'progress')).toEqual(
      expect.arrayContaining(['scroll_chapter', 'scroll_y', 'status', 'max_scroll_position']),
    )
  })

  it('annotations.sort_order and collection_items.sort_order exist', () => {
    const db = openTestDb()
    expect(colsOf(db, 'annotations')).toContain('sort_order')
    expect(colsOf(db, 'collection_items')).toContain('sort_order')
  })

  // Migration 18 — the recommender embedding store.
  it('item_embeddings has the expected columns', () => {
    const db = openTestDb()
    expect(colsOf(db, 'item_embeddings')).toEqual(
      expect.arrayContaining([
        'item_id',
        'embedding',
        'model_version',
        'content_hash',
        'embedded_at',
      ]),
    )
  })

  it('item_embeddings.item_id is the primary key', () => {
    const db = openTestDb()
    const pk = (
      db.prepare(`PRAGMA table_info(item_embeddings)`).all() as { name: string; pk: number }[]
    ).filter((c) => c.pk > 0)
    expect(pk.map((c) => c.name)).toEqual(['item_id'])
  })

  it('drops an embedding row when its item is hard-deleted (ON DELETE CASCADE)', () => {
    const db = openTestDb()
    db.pragma('foreign_keys = ON')
    db.prepare(
      `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count, cover_path, description, date_saved, date_modified)
       VALUES ('e1', 'T', NULL, NULL, 'article', 'e1.html', 1, NULL, NULL, 0, 0)`,
    ).run()
    db.prepare(
      `INSERT INTO item_embeddings (item_id, embedding, model_version, content_hash, embedded_at)
       VALUES ('e1', X'00', 'm', 'h', 0)`,
    ).run()
    expect(db.prepare(`SELECT COUNT(*) c FROM item_embeddings`).get()).toMatchObject({ c: 1 })
    db.prepare(`DELETE FROM items WHERE id = 'e1'`).run()
    expect(db.prepare(`SELECT COUNT(*) c FROM item_embeddings`).get()).toMatchObject({ c: 0 })
  })

  // Migration 19 — the recommender taste-seeds seam (Chunk 3).
  it('taste_seeds has the expected columns', () => {
    const db = openTestDb()
    expect(colsOf(db, 'taste_seeds')).toEqual(
      expect.arrayContaining(['id', 'kind', 'text', 'weight', 'created_at']),
    )
  })

  it('taste_seeds.kind is constrained to title/vibe', () => {
    const db = openTestDb()
    const insert = (kind: string) =>
      db
        .prepare(
          `INSERT INTO taste_seeds (id, kind, text, weight, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(kind, kind, 'x', 1.0, 0)
    expect(() => insert('title')).not.toThrow()
    expect(() => insert('vibe')).not.toThrow()
    expect(() => insert('nonsense')).toThrow()
  })

  // Migration 20 — the recommender "real recommendations" seams (Chunk 4).
  it('dismissed_recommendations has the expected columns', () => {
    const db = openTestDb()
    expect(colsOf(db, 'dismissed_recommendations')).toEqual(
      expect.arrayContaining(['id', 'title', 'author', 'source', 'dismissed_at']),
    )
  })

  it('candidate_cache has the expected columns', () => {
    const db = openTestDb()
    expect(colsOf(db, 'candidate_cache')).toEqual(
      expect.arrayContaining(['query_key', 'payload_json', 'fetched_at']),
    )
  })

  it('candidate_cache.query_key is the primary key', () => {
    const db = openTestDb()
    const pk = (
      db.prepare(`PRAGMA table_info(candidate_cache)`).all() as { name: string; pk: number }[]
    ).filter((c) => c.pk > 0)
    expect(pk.map((c) => c.name)).toEqual(['query_key'])
  })

  // Migration 21 — the fanfic recall upgrade's native-tag store (F2).
  it('item_source_tags / item_source_meta have the expected columns', () => {
    const db = openTestDb()
    expect(colsOf(db, 'item_source_tags')).toEqual(
      expect.arrayContaining(['item_id', 'name', 'category']),
    )
    expect(colsOf(db, 'item_source_meta')).toEqual(
      expect.arrayContaining([
        'item_id',
        'kudos',
        'favs',
        'follows',
        'words',
        'status',
        'rating',
        'source',
      ]),
    )
  })

  it('drops source tags + meta when their item is hard-deleted (ON DELETE CASCADE)', () => {
    const db = openTestDb()
    db.pragma('foreign_keys = ON')
    db.prepare(
      `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count, cover_path, description, date_saved, date_modified)
       VALUES ('s1', 'T', NULL, NULL, 'article', 's1.html', 1, NULL, NULL, 0, 0)`,
    ).run()
    db.prepare(
      `INSERT INTO item_source_tags (item_id, name, category) VALUES ('s1', 'Harry Potter', 'fandom')`,
    ).run()
    db.prepare(`INSERT INTO item_source_meta (item_id, kudos) VALUES ('s1', 10)`).run()
    db.prepare(`DELETE FROM items WHERE id = 's1'`).run()
    expect(db.prepare(`SELECT COUNT(*) c FROM item_source_tags`).get()).toMatchObject({ c: 0 })
    expect(db.prepare(`SELECT COUNT(*) c FROM item_source_meta`).get()).toMatchObject({ c: 0 })
  })

  // Migration 22 — the autocomplete vocab-bridge cache (raw→canonical tag names).
  it('tag_alias has the expected columns and upserts by (raw, kind)', () => {
    const db = openTestDb()
    expect(colsOf(db, 'tag_alias')).toEqual(
      expect.arrayContaining(['raw', 'kind', 'canonical', 'resolved_at']),
    )
    const upsert = db.prepare(
      `INSERT INTO tag_alias (raw, kind, canonical, resolved_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(raw, kind) DO UPDATE SET canonical = excluded.canonical, resolved_at = excluded.resolved_at`,
    )
    upsert.run('Harry P.', 'character', 'Harry Potter', 1)
    upsert.run('Harry P.', 'character', 'Harry Potter (Movies)', 2) // same key → updates
    expect(db.prepare(`SELECT COUNT(*) c FROM tag_alias`).get()).toMatchObject({ c: 1 })
    expect(db.prepare(`SELECT canonical FROM tag_alias`).get()).toMatchObject({
      canonical: 'Harry Potter (Movies)',
    })
  })

  // Migration 23 — the Discover results cache (single-row snapshot of recommend()).
  it('discover_cache has the expected columns and is constrained to a single row', () => {
    const db = openTestDb()
    expect(colsOf(db, 'discover_cache')).toEqual(
      expect.arrayContaining(['id', 'cards_json', 'generated_at']),
    )
    const upsert = db.prepare(
      `INSERT INTO discover_cache (id, cards_json, generated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET cards_json = excluded.cards_json, generated_at = excluded.generated_at`,
    )
    upsert.run('[]', 1)
    upsert.run('[{"t":1}]', 2) // id is pinned to 1 → updates the same row
    expect(db.prepare(`SELECT COUNT(*) c FROM discover_cache`).get()).toMatchObject({ c: 1 })
    // The CHECK (id = 1) guard rejects any other row id.
    expect(() =>
      db
        .prepare(`INSERT INTO discover_cache (id, cards_json, generated_at) VALUES (2, '[]', 1)`)
        .run(),
    ).toThrow()
  })

  // Migration 24 — the candidate-embedding perf cache (sourceId-keyed vectors).
  it('candidate_embeddings has the expected columns and sourceId is the primary key', () => {
    const db = openTestDb()
    expect(colsOf(db, 'candidate_embeddings')).toEqual(
      expect.arrayContaining(['source_id', 'embedding', 'model_version']),
    )
    const pk = (
      db.prepare(`PRAGMA table_info(candidate_embeddings)`).all() as {
        name: string
        pk: number
      }[]
    ).filter((c) => c.pk > 0)
    expect(pk.map((c) => c.name)).toEqual(['source_id'])
  })

  it('annotations.color exists (migration 25 — highlight colors)', () => {
    const db = openTestDb()
    expect(colsOf(db, 'annotations')).toContain('color')
  })

  it('annotations.rects exists (migration 27 — PDF highlight geometry)', () => {
    const db = openTestDb()
    expect(colsOf(db, 'annotations')).toContain('rects')
  })

  it('annotations.book_fraction exists (migration 31 — normalized location)', () => {
    const db = openTestDb()
    expect(colsOf(db, 'annotations')).toContain('book_fraction')
  })

  it('seeds starter preset themes (migration 28) and is idempotent', () => {
    const db = openTestDb()
    const names = (
      db.prepare('SELECT name FROM annotation_themes ORDER BY name').all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(names).toEqual(
      expect.arrayContaining(['Identity', 'Love', 'Power', 'Coming of age', 'Good vs evil']),
    )
    const count = (db.prepare('SELECT COUNT(*) n FROM annotation_themes').get() as { n: number }).n
    // Re-running bring-up must not duplicate the presets (INSERT OR IGNORE on UNIQUE name).
    bringUpSchema(db)
    expect((db.prepare('SELECT COUNT(*) n FROM annotation_themes').get() as { n: number }).n).toBe(
      count,
    )
  })

  // Migration 26 — annotation themes.
  it('annotation_themes / annotation_theme_links have the expected columns', () => {
    const db = openTestDb()
    expect(colsOf(db, 'annotation_themes')).toEqual(
      expect.arrayContaining(['id', 'name', 'created_at']),
    )
    expect(colsOf(db, 'annotation_theme_links')).toEqual(
      expect.arrayContaining(['annotation_id', 'theme_id']),
    )
  })

  it('drops theme links when the annotation OR the theme is deleted (ON DELETE CASCADE)', () => {
    const db = openTestDb()
    db.pragma('foreign_keys = ON')
    db.prepare(
      `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count, cover_path, description, date_saved, date_modified)
       VALUES ('bk', 'T', NULL, NULL, 'article', 'bk.html', 1, NULL, NULL, 0, 0)`,
    ).run()
    db.prepare(
      `INSERT INTO annotations (id, item_id, type, position, created_at) VALUES ('an', 'bk', 'highlight', 0, 0)`,
    ).run()
    db.prepare(
      `INSERT INTO annotation_themes (id, name, created_at) VALUES ('th', 'symbolism', 0)`,
    ).run()
    db.prepare(
      `INSERT INTO annotation_theme_links (annotation_id, theme_id) VALUES ('an', 'th')`,
    ).run()
    expect(db.prepare(`SELECT COUNT(*) c FROM annotation_theme_links`).get()).toMatchObject({
      c: 1,
    })
    // Deleting the annotation removes the link.
    db.prepare(`DELETE FROM annotations WHERE id = 'an'`).run()
    expect(db.prepare(`SELECT COUNT(*) c FROM annotation_theme_links`).get()).toMatchObject({
      c: 0,
    })
  })

  // Migration 34 — Cloud Phase 2 blob-backup foundation (per-item opt-in + ledger).
  it('items.cloud_backup defaults to 0 (local-only, the privacy-safe default)', () => {
    const db = openTestDb()
    db.prepare(
      `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count, cover_path, description, date_saved, date_modified)
       VALUES ('c1', 'T', NULL, NULL, 'article', 'c1.html', 1, NULL, NULL, 0, 0)`,
    ).run()
    // A row inserted without naming cloud_backup must land local-only.
    expect(db.prepare(`SELECT cloud_backup FROM items WHERE id = 'c1'`).get()).toMatchObject({
      cloud_backup: 0,
    })
  })

  it('blob_sync has the expected columns and content_hash is the primary key', () => {
    const db = openTestDb()
    expect(colsOf(db, 'blob_sync')).toEqual(
      expect.arrayContaining([
        'content_hash',
        'kind',
        'state',
        'last_attempt_at',
        'error',
        'updated_at',
      ]),
    )
    const pk = (
      db.prepare(`PRAGMA table_info(blob_sync)`).all() as { name: string; pk: number }[]
    ).filter((c) => c.pk > 0)
    expect(pk.map((c) => c.name)).toEqual(['content_hash'])
  })

  it('blob_sync defaults a new row to kind=content / state=pending', () => {
    const db = openTestDb()
    db.prepare(`INSERT INTO blob_sync (content_hash) VALUES ('h1')`).run()
    expect(
      db.prepare(`SELECT kind, state FROM blob_sync WHERE content_hash = 'h1'`).get(),
    ).toMatchObject({ kind: 'content', state: 'pending' })
  })

  it('creates idx_blob_sync_state (outbox drain query)', () => {
    const db = openTestDb()
    expect(indexesOf(db)).toContain('idx_blob_sync_state')
  })

  // Migration 35 — the real R2 content-address (sha256 of packed bytes), distinct
  // from the fast text fingerprint in content_hash.
  it('items.blob_hash exists and defaults to NULL (set later by the uploader)', () => {
    const db = openTestDb()
    db.prepare(
      `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count, cover_path, description, date_saved, date_modified)
       VALUES ('b1', 'T', NULL, NULL, 'article', 'b1.html', 1, NULL, NULL, 0, 0)`,
    ).run()
    expect(db.prepare(`SELECT blob_hash FROM items WHERE id = 'b1'`).get()).toMatchObject({
      blob_hash: null,
    })
  })

  // Migration 36 — Cloud Phase 3, the uniform sync clock. Every syncable table
  // gains updated_at (except items, which reuses date_modified) + deleted_at
  // (except append-only reading_sessions) + a dirty push flag.
  const SYNC_CLOCK_TABLES = [
    'progress',
    'tags',
    'item_tags',
    'collections',
    'collection_items',
    'annotations',
    'annotation_themes',
    'annotation_theme_links',
    'goals',
    'goal_items',
  ]

  it('adds updated_at/deleted_at/dirty to every syncable table', () => {
    const db = openTestDb()
    for (const t of SYNC_CLOCK_TABLES) {
      const cols = colsOf(db, t)
      expect(cols, `${t}.updated_at`).toContain('updated_at')
      expect(cols, `${t}.deleted_at`).toContain('deleted_at')
      expect(cols, `${t}.dirty`).toContain('dirty')
    }
    // items gets its own updated_at (backfilled from date_modified) + dirty, and
    // already has deleted_at (mig 15).
    expect(colsOf(db, 'items')).toContain('updated_at')
    expect(colsOf(db, 'items')).toContain('dirty')
  })

  it('reading_sessions is append-only — a dirty flag but no updated_at/deleted_at', () => {
    const db = openTestDb()
    const cols = colsOf(db, 'reading_sessions')
    expect(cols).toContain('dirty')
    expect(cols).not.toContain('updated_at')
    expect(cols).not.toContain('deleted_at')
  })

  it('dirty defaults to 1 so a new row is queued for its first push', () => {
    const db = openTestDb()
    db.prepare(`INSERT INTO tags (id, name) VALUES ('t-dirty', 'sci-fi')`).run()
    expect(db.prepare(`SELECT dirty FROM tags WHERE id = 't-dirty'`).get()).toMatchObject({
      dirty: 1,
    })
  })

  // Build a database at exactly user_version 35 (pre-Phase-3) the way a real
  // install reaches it — SCHEMA baseline + migrations 2..35 in order — so we can
  // exercise migration 36's backfill against pre-existing rows.
  const buildAtV35 = (): Database.Database => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
    for (let v = 2; v <= 35; v++) {
      if (MIGRATIONS[v]) db.exec(MIGRATIONS[v])
    }
    db.pragma('user_version = 35')
    return db
  }

  it('backfills updated_at from each table’s best existing timestamp and marks rows dirty', () => {
    const db = buildAtV35()
    db.prepare(
      `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count, cover_path, description, date_saved, date_modified)
       VALUES ('i1', 'T', NULL, NULL, 'article', 'i1.html', 1, NULL, NULL, 100, 100)`,
    ).run()
    db.prepare(`INSERT INTO progress (item_id, last_read_at) VALUES ('i1', 555)`).run()
    db.prepare(`INSERT INTO collections (id, name, date_created) VALUES ('c1', 'C', 777)`).run()
    db.prepare(
      `INSERT INTO annotations (id, item_id, type, created_at) VALUES ('a1', 'i1', 'note', 888)`,
    ).run()
    // tags has no pre-existing timestamp → backfills to migration-time "now".
    db.prepare(`INSERT INTO tags (id, name) VALUES ('t1', 'sci-fi')`).run()

    bringUpSchema(db) // runs migration 36 (+ later) only
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_VERSION)

    // items.updated_at backfills from date_modified.
    expect(db.prepare(`SELECT updated_at FROM items WHERE id = 'i1'`).get()).toMatchObject({
      updated_at: 100,
    })
    expect(
      db.prepare(`SELECT updated_at, dirty FROM progress WHERE item_id = 'i1'`).get(),
    ).toMatchObject({ updated_at: 555, dirty: 1 })
    expect(db.prepare(`SELECT updated_at FROM collections WHERE id = 'c1'`).get()).toMatchObject({
      updated_at: 777,
    })
    expect(db.prepare(`SELECT updated_at FROM annotations WHERE id = 'a1'`).get()).toMatchObject({
      updated_at: 888,
    })
    const tag = db.prepare(`SELECT updated_at, dirty FROM tags WHERE id = 't1'`).get() as {
      updated_at: number
      dirty: number
    }
    expect(tag.updated_at).toBeGreaterThan(0)
    expect(tag.dirty).toBe(1)
    db.close()
  })

  // Migration 40 — re-dirty already-backed-up items so a blob_hash/cover_hash the
  // uploader recorded AFTER the row's metadata synced still propagates to other
  // devices (heals the stranded-hash → cross-device pull-on-open ENOENT). Build at
  // v39 the way a real install reaches it, then confirm bring-up re-dirties only
  // backed-up live rows and leaves local-only rows untouched.
  const buildAtV39 = (): Database.Database => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
    for (let v = 2; v <= 39; v++) {
      if (MIGRATIONS[v]) db.exec(MIGRATIONS[v])
    }
    db.pragma('user_version = 39')
    return db
  }

  it('re-dirties already-synced backed-up items but not local-only ones (migration 40)', () => {
    const db = buildAtV39()
    const insert = db.prepare(
      `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count, cover_path, description, date_saved, date_modified, blob_hash)
       VALUES (?, 'T', NULL, NULL, ?, ?, 1, NULL, NULL, 0, 0, ?)`,
    )
    insert.run('backed', 'epub', 'backed.epub', 'bh') // cloud-backed
    insert.run('local', 'article', 'local.html', null) // local-only
    // Both already pushed their metadata (the sync engine clears dirty on push).
    db.prepare(`UPDATE items SET dirty = 0`).run()

    bringUpSchema(db) // runs migration 40
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_VERSION)

    // The backed-up row is re-dirtied so its stranded blob_hash finally pushes...
    expect(db.prepare(`SELECT dirty FROM items WHERE id = 'backed'`).get()).toMatchObject({
      dirty: 1,
    })
    // ...while a local-only synced row is left alone (no needless re-push).
    expect(db.prepare(`SELECT dirty FROM items WHERE id = 'local'`).get()).toMatchObject({
      dirty: 0,
    })
    db.close()
  })

  // Migration 41 — purged_at becomes a synced column (permanent-delete now cascades
  // so the shared R2 blob can be reaped). Re-dirty items purged BEFORE the change so
  // their purged_at finally propagates. Build at v40 the way a real install reaches
  // it, then confirm bring-up re-dirties only purged rows.
  const buildAtV40 = (): Database.Database => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
    for (let v = 2; v <= 40; v++) {
      if (MIGRATIONS[v]) db.exec(MIGRATIONS[v])
    }
    db.pragma('user_version = 40')
    return db
  }

  it('re-dirties already-purged items but not live/trashed ones (migration 41)', () => {
    const db = buildAtV40()
    const insert = db.prepare(
      `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count, cover_path, description, date_saved, date_modified, deleted_at, purged_at)
       VALUES (?, 'T', NULL, NULL, 'article', ?, 1, NULL, NULL, 0, 0, ?, ?)`,
    )
    insert.run('purged', 'purged.html', 100, 200) // permanently deleted (tombstone)
    insert.run('trashed', 'trashed.html', 100, null) // in Trash, restorable
    insert.run('live', 'live.html', null, null) // ordinary live item
    // All already pushed their metadata (the sync engine clears dirty on push).
    db.prepare(`UPDATE items SET dirty = 0`).run()

    bringUpSchema(db) // runs migration 41
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_VERSION)

    // The purged row is re-dirtied so its purged_at finally cascades to other devices…
    expect(db.prepare(`SELECT dirty FROM items WHERE id = 'purged'`).get()).toMatchObject({
      dirty: 1,
    })
    // …while a trashed-but-restorable and a live row are left alone (no needless re-push).
    expect(db.prepare(`SELECT dirty FROM items WHERE id = 'trashed'`).get()).toMatchObject({
      dirty: 0,
    })
    expect(db.prepare(`SELECT dirty FROM items WHERE id = 'live'`).get()).toMatchObject({
      dirty: 0,
    })
    db.close()
  })

  // Migration 42 — device-local `files_reclaimed` guard for the local-file reaper.
  // A row created before the column existed must gain it, defaulted 0, so the first
  // sweep can reclaim (or heal) its on-disk files.
  it('adds files_reclaimed (default 0) to existing items (migration 42)', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
    for (let v = 2; v <= 41; v++) {
      if (MIGRATIONS[v]) db.exec(MIGRATIONS[v])
    }
    db.pragma('user_version = 41')
    db.prepare(
      `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count, cover_path, description, date_saved, date_modified, purged_at)
       VALUES ('p', 'T', NULL, NULL, 'article', 'p.html', 1, NULL, NULL, 0, 0, 200)`,
    ).run()

    bringUpSchema(db) // runs migration 42
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_VERSION)

    expect(db.prepare(`SELECT files_reclaimed FROM items WHERE id = 'p'`).get()).toMatchObject({
      files_reclaimed: 0,
    })
    db.close()
  })

  // Migration 43 — device-local `orphaned_at` on blob_sync for the reaper's grace window.
  // An existing synced ledger row must gain the column, defaulted NULL ("not yet observed
  // as an orphan"), so the mark-and-sweep only reaps after a first sweep stamps it.
  it('adds orphaned_at (default NULL) to blob_sync (migration 43)', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
    for (let v = 2; v <= 42; v++) {
      if (MIGRATIONS[v]) db.exec(MIGRATIONS[v])
    }
    db.pragma('user_version = 42')
    db.prepare(
      `INSERT INTO blob_sync (content_hash, kind, state, updated_at) VALUES ('H', 'content', 'synced', 0)`,
    ).run()

    bringUpSchema(db) // runs migration 43
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_VERSION)

    const cols = (db.prepare(`PRAGMA table_info(blob_sync)`).all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(cols).toContain('orphaned_at')
    expect(db.prepare(`SELECT orphaned_at FROM blob_sync WHERE content_hash = 'H'`).get()).toEqual({
      orphaned_at: null,
    })
    db.close()
  })

  // Migration 44 — implicit-feedback loop's discover_interactions table (ADR-0011).
  // A fresh DB must have the table with the expected columns + source_id PK; a DB at
  // version 43 must gain it on bring-up (new table, so the migrate-up just creates it).
  it('discover_interactions has the expected columns + source_id PK (migration 44)', () => {
    const db = openTestDb()
    expect(colsOf(db, 'discover_interactions')).toEqual(
      expect.arrayContaining([
        'source_id',
        'title',
        'author',
        'source',
        'url',
        'subjects',
        'opened_at',
        'open_count',
      ]),
    )
    const pk = (
      db.prepare(`PRAGMA table_info(discover_interactions)`).all() as { name: string; pk: number }[]
    ).filter((c) => c.pk > 0)
    expect(pk.map((c) => c.name)).toEqual(['source_id'])
  })

  it('creates discover_interactions when migrating a v43 database (migration 44)', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
    for (let v = 2; v <= 43; v++) {
      if (MIGRATIONS[v]) db.exec(MIGRATIONS[v])
    }
    db.pragma('user_version = 43')

    bringUpSchema(db) // runs migration 44
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_VERSION)

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(tables).toContain('discover_interactions')
    db.close()
  })

  it('applies migrations incrementally from an empty (pre-schema) database', () => {
    // A DB at user_version 0 with NO tables must migrate cleanly to head — this is
    // the path a brand-new install actually takes.
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    expect(() => bringUpSchema(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_VERSION)
    db.close()
  })

  // Regression for the production emergency: the broken v0.5.1 release baked
  // migration-added columns into its SCHEMA baseline while still shipping the
  // ALTER-ADD migrations. A DB it created has those columns AND user_version=0,
  // so re-running migration 5 (`ADD COLUMN scroll_chapter`) threw
  // `duplicate column name: scroll_chapter` and crashed startup. bringUpSchema
  // must self-heal such a DB to head without throwing.
  it('heals a database created by the broken v0.5.1 baseline', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    // Reproduce the v0.5.1 baseline's collision-prone columns, left at
    // user_version 0 (migrations never completed on that release's fresh install).
    db.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT, source_url TEXT,
        content_type TEXT NOT NULL, file_path TEXT NOT NULL, word_count INTEGER,
        cover_path TEXT, description TEXT, date_saved INTEGER NOT NULL,
        date_modified INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE progress (
        item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        scroll_position REAL DEFAULT 0, last_read_at INTEGER,
        scroll_chapter INTEGER DEFAULT NULL, scroll_y REAL DEFAULT 0,
        status TEXT DEFAULT NULL
      );
    `)
    expect(db.pragma('user_version', { simple: true })).toBe(0)

    expect(() => bringUpSchema(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_VERSION)

    // Columns the broken baseline was MISSING must still get added by migrations.
    expect(colsOf(db, 'items')).toEqual(
      expect.arrayContaining(['derived_from', 'content_hash', 'rating', 'review']),
    )
    expect(colsOf(db, 'progress')).toContain('max_scroll_position')
    db.close()
  })
})
