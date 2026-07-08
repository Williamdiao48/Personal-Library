import type { Database } from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { SourceTag, SourceMeta } from '../capture/fetch'

// F2 — persist the native structured tags + stats a fanfic parser lifted at
// capture (F1). The tags/meta live in recommender-owned tables (item_source_tags,
// item_source_meta) that the seed builder + candidate sources read; the hybrid
// rule (D2) also promotes the fandom + relationship subset into the user-facing
// `tags` table so those few show as library chips. Shared with the F3 backfill.

// Categories surfaced as visible library chips (D2 hybrid). The long freeform /
// character / genre tail stays recommender-only to avoid flooding the UI.
const VISIBLE_CHIP_CATEGORIES: ReadonlySet<SourceTag['category']> = new Set([
  'fandom',
  'relationship',
])

// Matches the tags table's default color so promoted chips look native.
const CHIP_COLOR = '#6b7280'

/** Map a captured item's source_url to a site key (for item_source_meta.source / F3 dispatch). */
export function siteKeyFromUrl(url: string | null): string | null {
  if (!url) return null
  try {
    const host = new URL(url).hostname
    if (host.includes('archiveofourown.org')) return 'ao3'
    if (host.includes('fanfiction.net')) return 'ffn'
    return null
  } catch {
    return null
  }
}

/**
 * Persist an item's native tags + stats and surface fandom+relationship as chips.
 * Idempotent — replaces any prior source tags/meta for the item so the F3 backfill
 * (and a re-capture) can re-run cleanly. Synchronous prepared statements: call
 * inside the caller's transaction.
 */
export function persistSourceTags(
  db: Database,
  itemId: string,
  sourceTags: SourceTag[] | undefined,
  sourceMeta: SourceMeta | undefined,
  source: string | null,
): void {
  // Replace prior source tags for this item so backfill / re-capture is clean.
  db.prepare(`DELETE FROM item_source_tags WHERE item_id = ?`).run(itemId)
  const insTag = db.prepare(
    `INSERT OR IGNORE INTO item_source_tags (item_id, name, category) VALUES (?, ?, ?)`,
  )
  for (const t of sourceTags ?? []) {
    const name = t.name.trim()
    if (name) insTag.run(itemId, name, t.category)
  }

  if (sourceMeta && Object.keys(sourceMeta).length > 0) {
    db.prepare(
      `INSERT INTO item_source_meta (item_id, kudos, favs, follows, words, status, rating, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         kudos = excluded.kudos, favs = excluded.favs, follows = excluded.follows,
         words = excluded.words, status = excluded.status, rating = excluded.rating,
         source = excluded.source`,
    ).run(
      itemId,
      sourceMeta.kudos ?? null,
      sourceMeta.favs ?? null,
      sourceMeta.follows ?? null,
      sourceMeta.words ?? null,
      sourceMeta.status ?? null,
      sourceMeta.rating ?? null,
      source,
    )
  }

  // Hybrid (D2): promote fandom + relationship tags to visible library chips.
  const findTag = db.prepare(`SELECT id FROM tags WHERE name = ?`)
  const insTagRow = db.prepare(`INSERT INTO tags (id, name, color) VALUES (?, ?, ?)`)
  const linkTag = db.prepare(`INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)`)
  for (const t of sourceTags ?? []) {
    if (!VISIBLE_CHIP_CATEGORIES.has(t.category)) continue
    const name = t.name.trim()
    if (!name) continue
    const existing = findTag.get(name) as { id: string } | undefined
    let tagId = existing?.id
    if (!tagId) {
      tagId = randomUUID()
      insTagRow.run(tagId, name, CHIP_COLOR)
    }
    linkTag.run(itemId, tagId)
  }
}
