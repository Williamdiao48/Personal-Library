import { all } from '../../db'
import type { LikedItem } from '../taste'
import type { CandidateSource, FetchOpts } from '../candidateSource'
import type { Candidate } from '../candidates'
import { buildSeedQueries, type SeedSource } from '../seedQueries'
import { fetchCandidates, CANDIDATES } from '../candidates'
import { siteKeyFromUrl } from '../sourceTags'
import { resolveOwnedBookSubjects, type OwnedBook } from '../ownedBookSubjects'

// F4 — the OpenLibrary (published-books) candidate source. Wraps the Chunk-4 path
// unchanged: join the liked items to their author + manual library tags, build the
// weighted subject:/author: queries, and fetch/normalize/cache from OpenLibrary.
// This is the `book` half of the union; the fanfic sources sit beside it.

const SEED_SOURCE_LIMIT = 100 // cap liked items fed to the seeder (keeps the IN() bounded)

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

interface ItemMeta {
  title: string
  author: string | null
  source_url: string | null
}

/**
 * Join the taste engine's liked ids (weight-descending) to each item's author,
 * manual tags, AND — for book-type items — its resolved OpenLibrary subjects, then
 * fold those subjects into the item's tag list so they seed `subject:` queries just
 * like fic native tags do. This is what gives books cross-author discovery instead
 * of author-flooded results. Async: subject resolution is cache-first network.
 */
async function loadSeedSources(liked: LikedItem[]): Promise<SeedSource[]> {
  const top = liked.slice(0, SEED_SOURCE_LIMIT)
  if (top.length === 0) return []
  const ids = top.map((l) => l.id)

  const metaById = new Map<string, ItemMeta>()
  for (const r of all<{
    id: string
    title: string
    author: string | null
    source_url: string | null
  }>(
    `SELECT id, title, author, source_url FROM items WHERE id IN (${placeholders(ids.length)})`,
    ids,
  )) {
    metaById.set(r.id, { title: r.title, author: r.author, source_url: r.source_url })
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

  // Book-type = not a fanfic (AO3/FFN have their own richer native-tag path). Resolve
  // those to OpenLibrary subjects — the book analogue of the fics' native tags.
  const books: OwnedBook[] = top.flatMap((l) => {
    const meta = metaById.get(l.id)
    if (!meta || siteKeyFromUrl(meta.source_url) !== null) return []
    return [{ id: l.id, title: meta.title, author: meta.author }]
  })
  const subjectsById = await resolveOwnedBookSubjects(books)

  return top.map((l) => ({
    author: metaById.get(l.id)?.author ?? null,
    tags: [...(tagsById.get(l.id) ?? []), ...(subjectsById.get(l.id) ?? [])],
    weight: l.weight,
  }))
}

export const openLibrarySource: CandidateSource = {
  name: 'book',
  async fetch(liked: LikedItem[], opts: FetchOpts = {}): Promise<Candidate[]> {
    const queries = buildSeedQueries(await loadSeedSources(liked))
    if (queries.length === 0) return []
    // A Refresh tightens the search-cache TTL to the soft floor so aged results
    // re-query; the description cache (DESCRIPTION_CACHE_TTL_MS) is left untouched —
    // a book's blurb is recipe-independent and shouldn't churn on a refresh.
    const cfg = opts.fresh ? { ...CANDIDATES, CACHE_TTL_MS: CANDIDATES.SOFT_FLOOR_MS } : CANDIDATES
    return fetchCandidates(queries, { cfg })
  },
}
