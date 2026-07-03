// Baseline schema, created on first launch before migrations run.
//
// IMPORTANT: this is the ORIGINAL (v1) shape — every column/table added by a
// later migration (see MIGRATIONS in index.ts) must be added THERE, not here.
// Listing a migration-added column in this baseline makes a fresh install run
// `CREATE TABLE` with that column and then hit `duplicate column name` when the
// corresponding `ALTER TABLE ADD COLUMN` migration runs. `CREATE TABLE IF NOT
// EXISTS` never alters an existing table, so trimming columns here is invisible
// to already-migrated user databases.

export const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS items (
    id          TEXT PRIMARY KEY,           -- UUID
    title       TEXT NOT NULL,
    author      TEXT,
    source_url  TEXT,
    content_type TEXT NOT NULL              -- 'article' | 'epub' | 'pdf'
      CHECK(content_type IN ('article', 'epub', 'pdf')),
    file_path   TEXT NOT NULL,             -- path relative to content dir
    word_count  INTEGER,
    cover_path  TEXT,
    description TEXT,
    date_saved  INTEGER NOT NULL,          -- unix timestamp
    date_modified INTEGER NOT NULL
    -- Added by migrations: derived_from (3), chapter_start/end (8),
    -- content_hash (9), deleted_at (15), rating/review (17).
  );

  CREATE TABLE IF NOT EXISTS progress (
    item_id           TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    scroll_position   REAL DEFAULT 0,      -- 0.0 - 1.0 fraction
    last_read_at      INTEGER              -- unix timestamp
    -- Added by migrations: scroll_chapter/scroll_y (5), status (7),
    -- max_scroll_position (11).
  );

  CREATE TABLE IF NOT EXISTS tags (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#6b7280'
  );

  CREATE TABLE IF NOT EXISTS item_tags (
    item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
    tag_id  TEXT REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
  );

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

  CREATE TABLE IF NOT EXISTS reading_sessions (
    id         TEXT    PRIMARY KEY,
    item_id    TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,   -- unix ms
    ended_at   INTEGER NOT NULL,   -- unix ms
    duration   INTEGER NOT NULL    -- ms, capped at SESSION_MAX_MS
  );
  CREATE INDEX IF NOT EXISTS idx_rs_item_id    ON reading_sessions(item_id);
  CREATE INDEX IF NOT EXISTS idx_rs_started_at ON reading_sessions(started_at);

  -- Indexes for common library sort/filter operations
  CREATE INDEX IF NOT EXISTS idx_items_date_saved  ON items(date_saved DESC);
  CREATE INDEX IF NOT EXISTS idx_items_author      ON items(author);
  CREATE INDEX IF NOT EXISTS idx_items_title       ON items(title);
  CREATE INDEX IF NOT EXISTS idx_item_tags_tag_id  ON item_tags(tag_id);
  CREATE INDEX IF NOT EXISTS idx_progress_last_read ON progress(last_read_at DESC);

  -- Full-text search over title, author, and extracted content
  CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    title,
    author,
    content,
    content='',        -- contentless: we manage the index manually
    tokenize='porter unicode61'
  );

  CREATE TABLE IF NOT EXISTS annotations (
    id             TEXT    PRIMARY KEY,
    item_id        TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    type           TEXT    NOT NULL
      CHECK(type IN ('bookmark', 'highlight', 'note')),
    chapter_index  INTEGER DEFAULT NULL,    -- 0-based chapter; NULL for PDF / single-page
    position       REAL    NOT NULL DEFAULT 0, -- 0.0-1.0 scroll fraction OR PDF page number
    selected_text  TEXT    DEFAULT NULL,    -- highlighted text (highlight / text-anchored note)
    context_before TEXT    DEFAULT NULL,    -- ~30 chars before selection for re-anchoring
    context_after  TEXT    DEFAULT NULL,    -- ~30 chars after selection for re-anchoring
    note_text      TEXT    DEFAULT NULL,    -- user's freeform note
    created_at     INTEGER NOT NULL         -- unix ms; sort_order added by migration 14
  );
  CREATE INDEX IF NOT EXISTS idx_annotations_item_id
    ON annotations(item_id, chapter_index, position);
`
