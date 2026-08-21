import { all } from '../db'
import { discoverAo3Bookmarks } from './sites/ao3-bookmarks'
import { discoverFfnetFavorites } from './sites/ffnet-favorites'
import type { BulkSource, DiscoveredWork, FavoritesDiscovery } from '../../../src/types'

// ── Bulk favorites import — discovery dispatch, validation, dedup (Phase 2) ────
// Turns a validated account reference into a de-duplicated, library-annotated
// preview (DiscoverResult) the UI shows before committing to N downloads. The
// actual serialized import (runBulkImport) lands in Phase 3 in this same file.
//
// Dedup is load-bearing and NOT automatic: captureUrl blindly INSERTs the raw
// source_url with no dedup, and the only existing URL check is renderer-side in
// AddItemModal (which the bulk path bypasses). So this module dedups every work
// itself — by CANONICAL id, not exact source_url, since /works/123,
// /works/123?view_full_work=true and /works/123/chapters/456 are the same work.

/** A work identified by its site + canonical numeric id — the dedup key. */
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
function canonicalKey(c: CanonicalId): string {
  return `${c.kind}:${c.id}`
}

/**
 * Build the set of canonical ids already in the library, so a discovered work can
 * be flagged `alreadyInLibrary` in O(1). One pass over owned source_urls (a
 * personal library is small) — correct where a `source_url LIKE '%/works/{id}%'`
 * query would false-match (`/works/12` vs `/works/123`) and cheaper than N queries.
 */
export function ownedCanonicalIds(): Set<string> {
  const rows = all<{ source_url: string | null }>(
    "SELECT source_url FROM items WHERE source_url IS NOT NULL AND source_url <> ''",
  )
  const set = new Set<string>()
  for (const { source_url } of rows) {
    if (!source_url) continue
    const c = canonicalWorkId(source_url)
    if (c) set.add(canonicalKey(c))
  }
  return set
}

/**
 * Normalize + validate an account reference for a source. Accepts either a bare
 * value or a pasted profile URL, and enforces a strict character class so the
 * validated ref can be interpolated into a fixed URL template with no path
 * injection. Throws a user-facing error on anything that doesn't match.
 *
 * - AO3 → a username (URL slug): letters, digits, underscores. From `/users/{name}`.
 * - FFN → a numeric user id. From `/u/{id}`.
 */
export function normalizeAccountRef(source: BulkSource, rawRef: string): string {
  const ref = (rawRef ?? '').trim()
  if (!ref) throw new Error('Enter an account reference.')

  if (source === 'ao3') {
    // A pasted profile URL like https://archiveofourown.org/users/Name/bookmarks
    const fromUrl = /\/users\/([A-Za-z0-9_]+)/.exec(ref)?.[1]
    const username = fromUrl ?? ref
    if (!/^[A-Za-z0-9_]+$/.test(username)) {
      throw new Error('Enter a valid AO3 username (letters, numbers, underscores).')
    }
    return username
  }

  // FFN: a pasted profile URL like https://www.fanfiction.net/u/12345/Name
  const fromUrl = /\/u\/(\d+)/.exec(ref)?.[1]
  const id = fromUrl ?? ref
  if (!/^\d+$/.test(id)) {
    throw new Error('Enter a valid FanFiction.net user id (the number in /u/…).')
  }
  return id
}

/** Progress callback for the discovery phase (AO3 multi-page walk). */
export type DiscoverProgress = (page: number, totalPages: number, found: number) => void

/**
 * Discover an account's favorites/bookmarks, then annotate + de-duplicate:
 *   1. validate the ref and dispatch to the right site discoverer;
 *   2. drop within-batch duplicates by canonical id (same story listed twice);
 *   3. flag each remaining work `alreadyInLibrary` against the owned-id set.
 * Returns the preview object the modal renders. Never captures anything.
 */
export async function discoverFavorites(
  source: BulkSource,
  rawRef: string,
  onProgress?: DiscoverProgress,
): Promise<FavoritesDiscovery> {
  const ref = normalizeAccountRef(source, rawRef)

  let rawWorks: DiscoveredWork[]
  let skippedSeries = 0
  let skippedExternal = 0
  if (source === 'ao3') {
    const res = await discoverAo3Bookmarks(ref, onProgress)
    rawWorks = res.works
    skippedSeries = res.skippedSeries
    skippedExternal = res.skippedExternal
  } else {
    rawWorks = await discoverFfnetFavorites(ref)
    onProgress?.(1, 1, rawWorks.length)
  }

  // (2) Within-batch dedup by canonical id — the same story appearing twice in one
  // list must not double-import. A work with no parseable canonical id is kept
  // (deduped by url instead) rather than silently dropped.
  const seen = new Set<string>()
  const deduped: DiscoveredWork[] = []
  for (const w of rawWorks) {
    const c = canonicalWorkId(w.url)
    const key = c ? canonicalKey(c) : `url:${w.url}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(w)
  }

  // (3) Flag works already owned (canonical-id match against the library).
  const owned = ownedCanonicalIds()
  let alreadyInLibrary = 0
  const works = deduped.map((w) => {
    const c = canonicalWorkId(w.url)
    const isOwned = c ? owned.has(canonicalKey(c)) : false
    if (isOwned) alreadyInLibrary++
    return { ...w, alreadyInLibrary: isOwned }
  })

  return {
    source,
    ref,
    works,
    total: works.length,
    alreadyInLibrary,
    skippedSeries,
    skippedExternal,
  }
}
