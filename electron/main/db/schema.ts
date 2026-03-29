// All DDL in one place. Run in order on first launch and migrations.

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
  );

  CREATE TABLE IF NOT EXISTS progress (
    item_id           TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    scroll_position   REAL DEFAULT 0,      -- 0.0 - 1.0 fraction
    last_read_at      INTEGER,             -- unix timestamp
    scroll_chapter    INTEGER DEFAULT NULL, -- chapter index for precise restore
    scroll_y          REAL    DEFAULT 0,   -- scrollTop pixels within chapter / overall
    status            TEXT    DEFAULT NULL  -- explicit reading status; NULL = infer from scroll_position
      CHECK(status IS NULL OR status IN ('unread', 'reading', 'finished', 'on-hold', 'dropped'))
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
`
