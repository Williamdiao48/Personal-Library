// In-memory SQLite harness for main-process DB/IPC integration tests.
//
// openTestDb() brings up a fresh `:memory:` database using the SAME
// SCHEMA + MIGRATIONS path production uses (via bringUpSchema), and points the
// db/index.ts singleton at it so IPC handlers' run/get/all helpers operate on it.
// Seed factories insert minimal valid rows and return their ids.
//
// NOTE: better-sqlite3 must be built for the Node ABI to load here
// (`npm run rebuild:node`); the app normally builds it for Electron's ABI.
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { bringUpSchema, __setTestDb, closeDb } from '../../electron/main/db/index'

export type TestDb = Database.Database

/** Fresh, fully-migrated in-memory DB wired into the db/index.ts singleton. */
export function openTestDb(): TestDb {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON') // exercise ON DELETE CASCADE / SET NULL in tests
  bringUpSchema(db)
  __setTestDb(db)
  return db
}

/** Detach + close the singleton. Call in afterEach. */
export function closeTestDb(): void {
  closeDb()
  __setTestDb(undefined)
}

// ── Seed factories ──────────────────────────────────────────────────────────
// Each returns the id of the row it created. Timestamps default to a fixed value
// so ordering assertions are deterministic; override via the `over` argument.

const T0 = 1_700_000_000_000

export interface SeedItemOverrides {
  id?: string
  title?: string
  author?: string | null
  source_url?: string | null
  content_type?: 'article' | 'epub' | 'pdf'
  file_path?: string
  word_count?: number | null
  cover_path?: string | null
  description?: string | null
  date_saved?: number
  date_modified?: number
  deleted_at?: number | null
  review?: string | null
  content_hash?: string | null
}

export function seedItem(db: TestDb, over: SeedItemOverrides = {}): string {
  const id = over.id ?? randomUUID()
  db.prepare(
    `INSERT INTO items
       (id, title, author, source_url, content_type, file_path, word_count,
        cover_path, description, date_saved, date_modified, deleted_at, review, content_hash)
     VALUES
       (@id, @title, @author, @source_url, @content_type, @file_path, @word_count,
        @cover_path, @description, @date_saved, @date_modified, @deleted_at, @review, @content_hash)`,
  ).run({
    id,
    title: over.title ?? 'Untitled',
    author: over.author ?? null,
    source_url: over.source_url ?? null,
    content_type: over.content_type ?? 'article',
    file_path: over.file_path ?? `${id}.html`,
    word_count: over.word_count ?? null,
    cover_path: over.cover_path ?? null,
    description: over.description ?? null,
    date_saved: over.date_saved ?? T0,
    date_modified: over.date_modified ?? T0,
    deleted_at: over.deleted_at ?? null,
    review: over.review ?? null,
    content_hash: over.content_hash ?? null,
  })
  return id
}

export interface SeedEmbeddingOverrides {
  embedding?: Buffer
  model_version?: string
  content_hash?: string
  embedded_at?: number
}

/** Insert an item_embeddings row (migration 18) for an existing item. */
export function seedEmbedding(db: TestDb, itemId: string, over: SeedEmbeddingOverrides = {}): void {
  db.prepare(
    `INSERT INTO item_embeddings (item_id, embedding, model_version, content_hash, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    itemId,
    over.embedding ?? Buffer.from([0, 0, 0, 0]),
    over.model_version ?? 'test-model',
    over.content_hash ?? 'h0',
    over.embedded_at ?? T0,
  )
}

export function seedTag(db: TestDb, name: string, color = '#6b7280'): string {
  const id = randomUUID()
  db.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)').run(id, name, color)
  return id
}

export function tagItem(db: TestDb, itemId: string, tagId: string): void {
  db.prepare('INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?)').run(itemId, tagId)
}

export function seedCollection(db: TestDb, name: string): string {
  const id = randomUUID()
  db.prepare('INSERT INTO collections (id, name, date_created) VALUES (?, ?, ?)').run(id, name, T0)
  return id
}

export function seedAnnotation(
  db: TestDb,
  itemId: string,
  over: {
    type?: 'bookmark' | 'highlight' | 'note'
    position?: number
    sort_order?: number | null
  } = {},
): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO annotations (id, item_id, type, position, created_at, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, itemId, over.type ?? 'note', over.position ?? 0, T0, over.sort_order ?? null)
  return id
}

export function seedSession(
  db: TestDb,
  itemId: string,
  over: { started_at?: number; duration?: number } = {},
): string {
  const id = randomUUID()
  const started = over.started_at ?? T0
  const duration = over.duration ?? 60_000
  db.prepare(
    `INSERT INTO reading_sessions (id, item_id, started_at, ended_at, duration)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, itemId, started, started + duration, duration)
  return id
}

export { T0 as SEED_T0 }
