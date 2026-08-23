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

/** A library item a capture matched — the id/title needed to collapse onto it. */
export interface DuplicateMatch {
  id: string
  title: string
}

/**
 * An index of the LIVE library keyed on both dedup axes → the owning item, so "is this
 * work already owned?" is one O(1) `match` on either axis. Built once, queried many:
 * the single-URL path builds it and matches once (findLiveDuplicate); the bulk path
 * builds it once and matches every discovered work, `add`-ing each import so a later
 * duplicate in the same run also skips.
 *
 * Both axes map key → item so a match yields the owning row (not just a boolean):
 *   • canonical `${kind}:${id}` — same-site, URL-variant-proof (chapter vs work URL).
 *   • content `title|author` (normalized) — the same fic cross-posted to the other site.
 * canonical is checked first (the stronger signal); content is the cross-source fallback.
 */
export class OwnedIndex {
  private canonical = new Map<string, DuplicateMatch>()
  private content = new Map<string, DuplicateMatch>()

  /**
   * Record `item` under whichever keys the work has (canonical id from its URL, and/or
   * its content key). First writer wins per key, so the earliest-scanned owner is the
   * one a match reports.
   */
  add(
    sourceUrl: string | null | undefined,
    title: string | null | undefined,
    author: string | null | undefined,
    item: DuplicateMatch,
  ): void {
    if (sourceUrl) {
      const c = canonicalWorkId(sourceUrl)
      if (c) {
        const key = canonicalKey(c)
        if (!this.canonical.has(key)) this.canonical.set(key, item)
      }
    }
    const ck = contentKey(title, author)
    if (ck && !this.content.has(ck)) this.content.set(ck, item)
  }

  /** The owning item if this work matches an indexed one on either axis, else null. */
  match(
    sourceUrl: string | null | undefined,
    title: string | null | undefined,
    author: string | null | undefined,
  ): DuplicateMatch | null {
    if (sourceUrl) {
      const c = canonicalWorkId(sourceUrl)
      if (c) {
        const hit = this.canonical.get(canonicalKey(c))
        if (hit) return hit
      }
    }
    const ck = contentKey(title, author)
    if (ck) {
      const hit = this.content.get(ck)
      if (hit) return hit
    }
    return null
  }
}

/**
 * Build an OwnedIndex over every LIVE library item — one pass (a personal library is
 * small). No source_url filter: a work imported without a fanfic source_url (e.g. an
 * EPUB of a fic) still content-matches an incoming AO3/FFN copy by title+author.
 *
 * deleted_at IS NULL: this app NEVER physically removes an item row — soft delete sets
 * deleted_at (Trash), and even "permanent delete" / "empty trash" keeps the row as a
 * purged tombstone (deleted_at + purged_at set, bytes reclaimed) so the deletion syncs
 * and can't resurrect-on-pull. Both keep source_url + title/author, so without this
 * filter a re-import of a work the user deleted (soft OR hard) is wrongly flagged
 * "already in library". A deleted work is not owned.
 */
export function buildOwnedIndex(): OwnedIndex {
  const rows = all<{
    id: string
    title: string
    source_url: string | null
    author: string | null
  }>('SELECT id, title, source_url, author FROM items WHERE deleted_at IS NULL')
  const idx = new OwnedIndex()
  for (const row of rows) {
    idx.add(row.source_url, row.title, row.author, { id: row.id, title: row.title })
  }
  return idx
}

/**
 * One-shot dedup for the single-URL capture path: is an about-to-be-saved capture a
 * duplicate of a LIVE item, by canonical id OR normalized title|author? Guards against
 * scanning the library when there's nothing to match on (a generic web capture with no
 * work id and no author), then defers to a freshly-built OwnedIndex.
 */
export function findLiveDuplicate(
  sourceUrl: string,
  title: string | null | undefined,
  author: string | null | undefined,
): DuplicateMatch | null {
  if (!canonicalWorkId(sourceUrl) && !contentKey(title, author)) return null
  return buildOwnedIndex().match(sourceUrl, title, author)
}
