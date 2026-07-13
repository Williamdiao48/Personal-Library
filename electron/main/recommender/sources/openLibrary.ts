import { all } from '../../db'
import type { LikedItem } from '../taste'
import type { CandidateSource, FetchOpts } from '../candidateSource'
import type { Candidate } from '../candidates'
import { buildSeedQueries, type SeedSource } from '../seedQueries'
import { fetchCandidates, CANDIDATES } from '../candidates'

// F4 — the OpenLibrary (published-books) candidate source. Wraps the Chunk-4 path
// unchanged: join the liked items to their author + manual library tags, build the
// weighted subject:/author: queries, and fetch/normalize/cache from OpenLibrary.
// This is the `book` half of the union; the fanfic sources sit beside it.

const SEED_SOURCE_LIMIT = 100 // cap liked items fed to the seeder (keeps the IN() bounded)

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

/**
 * Join the taste engine's liked ids (weight-descending) to each item's author +
 * manual tags → the seed sources the OpenLibrary query builder consumes.
 */
function loadSeedSources(liked: LikedItem[]): SeedSource[] {
  const top = liked.slice(0, SEED_SOURCE_LIMIT)
  if (top.length === 0) return []
  const ids = top.map((l) => l.id)

  const authorById = new Map<string, string | null>()
  for (const r of all<{ id: string; author: string | null }>(
    `SELECT id, author FROM items WHERE id IN (${placeholders(ids.length)})`,
    ids,
  )) {
    authorById.set(r.id, r.author)
  }

  const tagsById = new Map<string, string[]>()
  for (const r of all<{ item_id: string; name: string }>(
    `SELECT it.item_id AS item_id, t.name AS name
     FROM item_tags it JOIN tags t ON t.id = it.tag_id
     WHERE it.item_id IN (${placeholders(ids.length)})`,
    ids,
  )) {
    const list = tagsById.get(r.item_id)
    if (list) list.push(r.name)
    else tagsById.set(r.item_id, [r.name])
  }

  return top.map((l) => ({
    author: authorById.get(l.id) ?? null,
    tags: tagsById.get(l.id) ?? [],
    weight: l.weight,
  }))
}

export const openLibrarySource: CandidateSource = {
  name: 'book',
  async fetch(liked: LikedItem[], opts: FetchOpts = {}): Promise<Candidate[]> {
    const queries = buildSeedQueries(loadSeedSources(liked))
    if (queries.length === 0) return []
    // A Refresh tightens the search-cache TTL to the soft floor so aged results
    // re-query; the description cache (DESCRIPTION_CACHE_TTL_MS) is left untouched —
    // a book's blurb is recipe-independent and shouldn't churn on a refresh.
    const cfg = opts.fresh ? { ...CANDIDATES, CACHE_TTL_MS: CANDIDATES.SOFT_FLOOR_MS } : CANDIDATES
    return fetchCandidates(queries, { cfg })
  },
}
