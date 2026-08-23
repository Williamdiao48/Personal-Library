import { all } from '../db'
import type { BulkSource } from '../../../src/types'

// ── Shared capture dedup primitives ───────────────────────────────────────────
// Two dedup axes, used by BOTH the bulk-favorites path (bulkImport.ts, at discovery
// preview time) and the single-URL capture path (capture/index.ts, post-parse):
//   • CANONICAL id (site + numeric work id) — same-site, URL-variant-proof: /works/123,
//     /works/123?view_full_work=true and /works/123/chapters/456 are one work.
//   • CONTENT key (normalized title|author) — a fic cross-posted to BOTH AO3 and FFN
//     gets a different work id on each site, so the canonical key can't tell they're
//     the same story; the normalized title+author can.
// Kept in one module so the two entry points can't drift apart (they did: the bulk
// preview deduped cross-source, the single-URL paste path only matched exact
// source_url, so pasting the FFN URL of a fic already owned from AO3 re-imported it).

/** A work identified by its site + canonical numeric id — the same-site dedup key. */
export interface CanonicalId {
  kind: BulkSource
  id: string
}

/**
 * Reduce any AO3 work URL or FFN story URL to its canonical {kind,id}, ignoring
 * query strings, chapter/slug tails, and www/scheme variants. Returns null for
 * anything that isn't a recognizable work/story URL.
 */
export function canonicalWorkId(url: string): CanonicalId | null {
  const ao3 = /\/works\/(\d+)/.exec(url)
  if (ao3 && /archiveofourown\.org/i.test(url)) return { kind: 'ao3', id: ao3[1] }
  const ffn = /\/s\/(\d+)/.exec(url)
  if (ffn && /fanfiction\.net/i.test(url)) return { kind: 'ffn', id: ffn[1] }
  return null
}

/** Stable string key for a canonical id (Set/Map membership). */
export function canonicalKey(c: CanonicalId): string {
  return `${c.kind}:${c.id}`
}

/** Normalize a string for content-key comparison: lowercase, punctuation → space,
 *  whitespace collapsed. Mirrors the recommender's `candidateKey` normalization;
 *  inlined (not imported) so the capture path stays decoupled from the recommender's
 *  DB/network module graph. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Cross-source dedup key: a work's normalized `title|author`. The same fic
 * cross-posted to AO3 and FFN keeps its title + author but gets a different work id
 * on each site, so canonicalWorkId (site + id) can't see it's the same story — this
 * can. Returns null unless BOTH title and author are present: requiring both is the
 * deliberate precision-first choice — matching on title alone would false-collide
 * unrelated works sharing a generic title, and a false "already in library" silently
 * drops a work the user asked for. An author handle that differs across sites is a
 * miss we accept rather than risk that.
 */
export function contentKey(
  title: string | null | undefined,
  author: string | null | undefined,
): string | null {
  const t = norm(title ?? '')
  const a = norm(author ?? '')
  if (!t || !a) return null
  return `${t}|${a}`
}

/** The two owned-work dedup indexes, built together in one library scan. */
export interface OwnedKeys {
  /** `${kind}:${id}` canonical ids — same-site, URL-variant-proof dedup. */
  canonical: Set<string>
  /** normalized `title|author` — cross-source (AO3 ↔ FFN) dedup. */
  content: Set<string>
}

// deleted_at IS NULL, in every owned scan below: this app NEVER physically removes an
// item row — soft delete sets deleted_at (Trash), and even "permanent delete" / "empty
// trash" keeps the row as a purged tombstone (deleted_at + purged_at set, bytes
// reclaimed) so the deletion syncs and can't resurrect-on-pull. Both keep source_url +
// title/author, so without this filter a re-import of a work the user deleted (soft OR
// hard) is wrongly flagged "already in library". A deleted work is not owned.

/**
 * Build both owned-work dedup indexes from the library, so a discovered work can be
 * flagged in O(1). One pass over owned items (a personal library is small).
 *
 * No source_url filter: a work imported without a fanfic source_url (e.g. an EPUB of a
 * fic) can still content-match an incoming AO3/FFN copy by title+author. The canonical
 * side just skips null urls.
 */
export function ownedKeys(): OwnedKeys {
  const rows = all<{ source_url: string | null; title: string | null; author: string | null }>(
    'SELECT source_url, title, author FROM items WHERE deleted_at IS NULL',
  )
  const canonical = new Set<string>()
  const content = new Set<string>()
  for (const { source_url, title, author } of rows) {
    if (source_url) {
      const c = canonicalWorkId(source_url)
      if (c) canonical.add(canonicalKey(c))
    }
    const ck = contentKey(title, author)
    if (ck) content.add(ck)
  }
  return { canonical, content }
}

/** A pre-existing LIVE library item a capture collapsed onto (dedup hit). */
export interface DuplicateMatch {
  id: string
  title: string
}

/**
 * Find a LIVE library item that duplicates an about-to-be-saved capture, matched by
 * canonical work id (from the source URL) OR normalized title|author (cross-source).
 * Returns the first match, or null. This is the authoritative gate for the single-URL
 * capture path (which previously deduped only by exact source_url and so re-imported a
 * cross-posted fic). One scan of the (small) live library — canonical takes precedence
 * as the stronger signal, content is the cross-source fallback.
 */
export function findLiveDuplicate(
  sourceUrl: string,
  title: string | null | undefined,
  author: string | null | undefined,
): DuplicateMatch | null {
  const c = canonicalWorkId(sourceUrl)
  const ck = contentKey(title, author)
  if (!c && !ck) return null // nothing to match on

  const rows = all<{ id: string; title: string; source_url: string | null; author: string | null }>(
    'SELECT id, title, source_url, author FROM items WHERE deleted_at IS NULL',
  )
  for (const row of rows) {
    if (c && row.source_url) {
      const rc = canonicalWorkId(row.source_url)
      if (rc && canonicalKey(rc) === canonicalKey(c)) return { id: row.id, title: row.title }
    }
    if (ck && contentKey(row.title, row.author) === ck) return { id: row.id, title: row.title }
  }
  return null
}
