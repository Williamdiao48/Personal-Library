import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { openTestDb, closeTestDb } from '../../../test/db/harness'
import { bringUpSchema, CURRENT_VERSION } from './index'

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
    ]) {
      expect(tables).toContain(t)
    }
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
      ]),
    )
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
