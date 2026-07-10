import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { unlinkSync } from 'fs'
import { SCHEMA } from './schema'
import { safeContentPath, safeUserDataPath } from '../security/paths'

let db: Database.Database

// Bump this number whenever you add a new entry to MIGRATIONS below.
// Exported so the test harness can assert a fresh DB reaches the current version.
export const CURRENT_VERSION = 24

// Each key is the version being migrated TO.
// The SQL runs inside a transaction; user_version is updated automatically.
// Exported so the in-memory test DB runs the exact same migration path.
export const MIGRATIONS: Record<number, string> = {
  1: '', // baseline — tables come from SCHEMA (IF NOT EXISTS), nothing extra to run
  2: `
    CREATE TABLE IF NOT EXISTS collections (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      date_created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collection_items (
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      item_id       TEXT NOT NULL REFERENCES items(id)       ON DELETE CASCADE,
      PRIMARY KEY (collection_id, item_id)
    );
  `,
  3: `ALTER TABLE items ADD COLUMN derived_from TEXT REFERENCES items(id) ON DELETE SET NULL;`,
  4: `
    CREATE TABLE IF NOT EXISTS reading_sessions (
      id         TEXT    PRIMARY KEY,
      item_id    TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL,
      ended_at   INTEGER NOT NULL,
      duration   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rs_item_id    ON reading_sessions(item_id);
    CREATE INDEX IF NOT EXISTS idx_rs_started_at ON reading_sessions(started_at);
  `,
  5: `
    ALTER TABLE progress ADD COLUMN scroll_chapter INTEGER DEFAULT NULL;
    ALTER TABLE progress ADD COLUMN scroll_y REAL DEFAULT 0;
  `,
  6: `
    CREATE INDEX IF NOT EXISTS idx_items_date_saved   ON items(date_saved DESC);
    CREATE INDEX IF NOT EXISTS idx_items_author       ON items(author);
    CREATE INDEX IF NOT EXISTS idx_items_title        ON items(title);
    CREATE INDEX IF NOT EXISTS idx_item_tags_tag_id   ON item_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_progress_last_read ON progress(last_read_at DESC);
  `,
  7: `
    ALTER TABLE progress ADD COLUMN status TEXT DEFAULT NULL
      CHECK(status IS NULL OR status IN ('unread', 'reading', 'finished', 'on-hold', 'dropped'));
  `,
  8: `ALTER TABLE items ADD COLUMN chapter_start INTEGER DEFAULT NULL;
ALTER TABLE items ADD COLUMN chapter_end INTEGER DEFAULT NULL;`,
  9: `ALTER TABLE items ADD COLUMN content_hash TEXT DEFAULT NULL;`,
  10: `
    CREATE TABLE goals (
      id             TEXT    PRIMARY KEY,
      type           TEXT    NOT NULL,
      title          TEXT    NOT NULL,
      period         TEXT,
      target_minutes INTEGER,
      target_count   INTEGER,
      created_at     INTEGER NOT NULL
    );
    CREATE TABLE goal_items (
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      PRIMARY KEY (goal_id, item_id)
    );
  `,
  11: `ALTER TABLE progress ADD COLUMN max_scroll_position REAL DEFAULT NULL;`,
  12: `CREATE INDEX IF NOT EXISTS idx_item_tags_item_id ON item_tags(item_id);`,
  13: `
    CREATE TABLE IF NOT EXISTS annotations (
      id             TEXT    PRIMARY KEY,
      item_id        TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      type           TEXT    NOT NULL
        CHECK(type IN ('bookmark', 'highlight', 'note')),
      chapter_index  INTEGER DEFAULT NULL,
      position       REAL    NOT NULL DEFAULT 0,
      selected_text  TEXT    DEFAULT NULL,
      context_before TEXT    DEFAULT NULL,
      context_after  TEXT    DEFAULT NULL,
      note_text      TEXT    DEFAULT NULL,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_annotations_item_id
      ON annotations(item_id, chapter_index, position);
  `,
  14: `
    ALTER TABLE annotations ADD COLUMN sort_order INTEGER DEFAULT NULL;
    UPDATE annotations SET sort_order = rowid;
  `,
  15: `ALTER TABLE items ADD COLUMN deleted_at INTEGER;`,
  16: `ALTER TABLE collection_items ADD COLUMN sort_order INTEGER DEFAULT NULL;`,
  17: `ALTER TABLE items ADD COLUMN rating REAL DEFAULT NULL;
ALTER TABLE items ADD COLUMN review TEXT DEFAULT NULL;`,
  // Recommender (Chunk 2): one embedding vector per item. Raw little-endian
  // Float32Array in a BLOB; model_version + content_hash gate re-embedding.
  // ON DELETE CASCADE drops the row when the item is hard-deleted. New table —
  // lives here only, never in schema.ts SCHEMA (fresh-install baseline gotcha).
  18: `
    CREATE TABLE IF NOT EXISTS item_embeddings (
      item_id       TEXT    PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      embedding     BLOB    NOT NULL,
      model_version TEXT    NOT NULL,
      content_hash  TEXT    NOT NULL,
      embedded_at   INTEGER NOT NULL
    );
  `,
  // Recommender (Chunk 3): the cold-start "taste seeds" seam — free-text titles
  // and vibe chips the user names in the (deferred, post-MVP) onboarding prompt,
  // folded into the taste vector as high-weight synthetic likes. Empty in v1;
  // the table exists now so lighting the seam up needs no future migration.
  // New table — lives here only, never in schema.ts SCHEMA (baseline gotcha).
  19: `
    CREATE TABLE IF NOT EXISTS taste_seeds (
      id         TEXT    PRIMARY KEY,
      kind       TEXT    NOT NULL CHECK(kind IN ('title', 'vibe')),
      text       TEXT    NOT NULL,
      weight     REAL    NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL
    );
  `,
  // Recommender (Chunk 4): the two "real recommendations" seams.
  //   dismissed_recommendations — books the user marked "not interested / already
  //     read"; filtered out of future recs. Keyed by normalized title+author.
  //   candidate_cache — a TTL cache of raw OpenLibrary search payloads keyed by
  //     query, so repeat recommend() calls don't re-hit their free API.
  // New tables — live here only, never in schema.ts SCHEMA (baseline gotcha).
  20: `
    CREATE TABLE IF NOT EXISTS dismissed_recommendations (
      id           TEXT    PRIMARY KEY,
      title        TEXT    NOT NULL,
      author       TEXT,
      source       TEXT,
      dismissed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidate_cache (
      query_key    TEXT    PRIMARY KEY,
      payload_json TEXT    NOT NULL,
      fetched_at   INTEGER NOT NULL
    );
  `,
  // Recommender (fanfic recall upgrade, F2): native structured tags + stats
  // lifted from AO3/FFN at capture (F1).
  //   item_source_tags — one row per (item, native tag), typed by category
  //     (fandom/relationship/character/freeform/genre/warning). Drives tag-native
  //     candidate queries + hybrid chip surfacing. Recommender-owned; distinct
  //     from the user-facing `tags` table.
  //   item_source_meta — per-item native stats (kudos/favs/follows, words,
  //     status, rating) for future popularity priors / display.
  // New tables — live here only, never in schema.ts SCHEMA (baseline gotcha).
  21: `
    CREATE TABLE IF NOT EXISTS item_source_tags (
      item_id  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      name     TEXT NOT NULL,
      category TEXT NOT NULL,
      PRIMARY KEY (item_id, name, category)
    );
    CREATE INDEX IF NOT EXISTS idx_item_source_tags_item_id ON item_source_tags(item_id);
    CREATE INDEX IF NOT EXISTS idx_item_source_tags_name    ON item_source_tags(name, category);
    CREATE TABLE IF NOT EXISTS item_source_meta (
      item_id  TEXT    PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      kudos    INTEGER,
      favs     INTEGER,
      follows  INTEGER,
      words    INTEGER,
      status   TEXT,
      rating   TEXT,
      source   TEXT
    );
  `,
  // Recommender (autocomplete vocab bridge): a persistent raw→canonical tag cache.
  // FFN captures use abbreviated names ("Harry P.") that don't match AO3's exact
  // named-field tag vocabulary ("Harry Potter"); we resolve them once via AO3's
  // autocomplete endpoint and cache the result here so each unique term hits the
  // network at most once. `canonical` NULL = resolved to nothing (negative cache,
  // so a dead term isn't re-fetched every recommend()). New table — MIGRATIONS only.
  22: `
    CREATE TABLE IF NOT EXISTS tag_alias (
      raw         TEXT    NOT NULL,
      kind        TEXT    NOT NULL,
      canonical   TEXT,
      resolved_at INTEGER NOT NULL,
      PRIMARY KEY (raw, kind)
    );
  `,
  // C5.2 — the Discover results cache: a single row holding the last recommend()
  // output (JSON) + when it was generated, so opening Discover shows cards
  // instantly (across restarts) while a fresh fetch is manual-only. Distinct from
  // candidate_cache (per-query source payloads). New table — MIGRATIONS only.
  23: `
    CREATE TABLE IF NOT EXISTS discover_cache (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      cards_json   TEXT,
      generated_at INTEGER
    );
  `,
  // Perf: cache the embedding of each recommendation CANDIDATE (keyed by its
  // sourceId — an OpenLibrary work key or a fic URL) so a Discover refresh reuses
  // vectors from the last run instead of re-embedding every candidate on the model.
  // `model_version` invalidates the cache when the model changes (mirrors
  // item_embeddings). Not item-scoped, so no FK. New table — MIGRATIONS only.
  24: `
    CREATE TABLE IF NOT EXISTS candidate_embeddings (
      source_id     TEXT    PRIMARY KEY,
      embedding     BLOB    NOT NULL,
      model_version TEXT    NOT NULL
    );
  `,
}

export function initDatabase(): void {
  const userDataPath = app.getPath('userData')
  const dbPath = join(userDataPath, 'library.db')

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL') // write-ahead log: safer, faster concurrent reads
  db.pragma('foreign_keys = ON') // enforce FK constraints (ON DELETE CASCADE/SET NULL)
  db.pragma('synchronous = NORMAL') // safe with WAL; skips unnecessary fsyncs vs FULL
  db.pragma('cache_size = -32000') // 32 MB page cache (default ~8 MB)
  db.pragma('temp_store = MEMORY') // temp B-trees/indexes stay in RAM
  bringUpSchema(db) // create tables (idempotent) + run pending migrations

  // Permanently purge items that have been in trash for 30+ days.
  // Paths come from the DB (attacker-influenceable via backup import), so route
  // them through the F1 traversal guards; a throw is caught per-row so one bad
  // row can't abort startup or escape the sandbox.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  const stale = db
    .prepare(
      `SELECT id, file_path, cover_path FROM items WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
    )
    .all(cutoff) as { id: string; file_path: string; cover_path: string | null }[]
  for (const row of stale) {
    try {
      unlinkSync(safeContentPath(row.file_path))
    } catch {}
    if (row.cover_path) {
      try {
        unlinkSync(safeUserDataPath(row.cover_path))
      } catch {}
    }
    db.prepare('DELETE FROM items WHERE id = ?').run(row.id)
  }

  // Compact FTS5 segment trees on clean shutdown rather than startup.
  // On large libraries this can take 100–500 ms; deferring it avoids blocking launch.
  app.on('before-quit', () => {
    try {
      db.exec("INSERT INTO items_fts(items_fts) VALUES('optimize')")
    } catch {}
  })
}

// Create the base schema and apply any pending migrations against `database`.
// Extracted from initDatabase (and parameterized) so the in-memory test harness
// can bring up an identical schema without touching Electron/app state.
export function bringUpSchema(database: Database.Database): void {
  database.exec(SCHEMA) // idempotent: creates tables only if they don't exist
  runMigrations(database)
}

function runMigrations(database: Database.Database): void {
  const current = database.pragma('user_version', { simple: true }) as number
  if (current >= CURRENT_VERSION) return

  for (let v = current + 1; v <= CURRENT_VERSION; v++) {
    database.transaction(() => {
      const sql = MIGRATIONS[v]
      if (sql) execMigration(database, sql)
      // SQLite pragmas don't accept bound parameters for user_version;
      // v is always a loop-counter integer so direct interpolation is safe.
      database.pragma(`user_version = ${v}`)
    })()
  }
}

// Run a migration's SQL, tolerating "duplicate column name" errors so the app
// self-heals databases created by the broken v0.5.1 baseline. That release's
// SCHEMA baked in several migration-added columns (progress.scroll_chapter/
// scroll_y/status, items.deleted_at, annotations.sort_order) yet still shipped
// the ALTER-ADD migrations, so a DB it created has those columns present but
// user_version=0. Re-running the ADD COLUMN migrations against it would throw
// `duplicate column name` and crash startup. The happy path (fresh install or
// already-migrated DB) runs the whole migration in one exec; only when a column
// already exists do we fall back to statement-by-statement, skipping the ADDs
// that are already satisfied while still applying the rest.
function execMigration(database: Database.Database, sql: string): void {
  try {
    database.exec(sql)
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err
    for (const stmt of sql.split(';')) {
      const trimmed = stmt.trim()
      if (!trimmed) continue
      try {
        database.exec(trimmed)
      } catch (e) {
        if (!isDuplicateColumn(e)) throw e
      }
    }
  }
}

function isDuplicateColumn(err: unknown): boolean {
  return err instanceof Error && /duplicate column name/i.test(err.message)
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.')
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = undefined as any
  }
}

/**
 * Test-only: point the module singleton at an already-open database so the IPC
 * handlers' run/get/all helpers operate on an in-memory test DB. Never called by
 * production code. See test/db/harness.ts.
 */
export function __setTestDb(database: Database.Database | undefined): void {
  db = database as Database.Database
}

// Convenience helpers used by IPC handlers

export function run(sql: string, params: unknown[] = []): Database.RunResult {
  return getDb().prepare(sql).run(params)
}

export function get<T>(sql: string, params: unknown[] = []): T | undefined {
  return getDb().prepare(sql).get(params) as T | undefined
}

export function all<T>(sql: string, params: unknown[] = []): T[] {
  return getDb().prepare(sql).all(params) as T[]
}
