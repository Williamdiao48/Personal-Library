import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { SCHEMA } from './schema'

let db: Database.Database

// Bump this number whenever you add a new entry to MIGRATIONS below.
const CURRENT_VERSION = 12

// Each key is the version being migrated TO.
// The SQL runs inside a transaction; user_version is updated automatically.
const MIGRATIONS: Record<number, string> = {
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
}

export function initDatabase(): void {
  const userDataPath = app.getPath('userData')
  const dbPath = join(userDataPath, 'library.db')

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')   // write-ahead log: safer, faster concurrent reads
  db.pragma('foreign_keys = ON')    // enforce FK constraints (ON DELETE CASCADE/SET NULL)
  db.pragma('synchronous = NORMAL') // safe with WAL; skips unnecessary fsyncs vs FULL
  db.pragma('cache_size = -32000')  // 32 MB page cache (default ~8 MB)
  db.pragma('temp_store = MEMORY')  // temp B-trees/indexes stay in RAM
  db.exec(SCHEMA)        // idempotent: creates tables only if they don't exist
  runMigrations()

  // Compact FTS5 segment trees on clean shutdown rather than startup.
  // On large libraries this can take 100–500 ms; deferring it avoids blocking launch.
  app.on('before-quit', () => {
    try { db.exec("INSERT INTO items_fts(items_fts) VALUES('optimize')") } catch {}
  })
}

function runMigrations(): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current >= CURRENT_VERSION) return

  for (let v = current + 1; v <= CURRENT_VERSION; v++) {
    db.transaction(() => {
      const sql = MIGRATIONS[v]
      if (sql) db.exec(sql)
      // SQLite pragmas don't accept bound parameters for user_version;
      // v is always a loop-counter integer so direct interpolation is safe.
      db.pragma(`user_version = ${v}`)
    })()
  }
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
