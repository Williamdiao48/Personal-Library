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
})
