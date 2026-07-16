import {
  CANDIDATES,
  candidateKey,
  mapPool,
  type CandidatesConfig,
  type OpenLibraryDoc,
} from './candidates'
import { readCandidateCache, writeCandidateCache } from './candidateCache'

// The book analogue of the fanfic native-tag enrichment (F1/F2/F3). Books arrive in
// the library with only an author + sparse manual tags, so the OpenLibrary seeder
// leans on author: queries and surfaces "more by authors you already own." Here we
// resolve each owned book to its real OpenLibrary *subjects* — the book-domain
// equivalent of AO3's fandom/relationship/character tags — so subject: seeding can
// find similar books by DIFFERENT authors.
//
// Cache-first over candidate_cache (long TTL, keyed `olsubj:<title|author>`): a
// book's subjects are recipe-independent, so a Refresh never re-fetches them, and an
// empty result is cached too so a book OpenLibrary doesn't know isn't retried every
// run. Only `resolveOwnedBookSubjects` touches the network; the parse is pure.

const OPENLIBRARY_SEARCH = 'https://openlibrary.org/search.json'
const OL_HEADERS = {
  'User-Agent': 'PersonalLibrary/0.5 (personal reading app; recommender)',
  Accept: 'application/json',
}

/** An owned book to resolve — the fields the title+author lookup needs. */
export interface OwnedBook {
  id: string
  title: string
  author: string | null
}

/**
 * The OpenLibrary `q` that anchors on the book's title, narrowed by author when we
 * have one (so a generic title lands on the right work). Quotes stripped so the term
 * is safe. Pure.
 */
export function ownedBookQuery(title: string, author: string | null): string {
  const t = title.replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
  const a = (author ?? '').replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
  return a ? `${t} author:"${a}"` : t
}

/** The trimmed, capped subject list from the best-matching search doc. Pure. */
export function extractSubjects(doc: OpenLibraryDoc | undefined, cap: number): string[] {
  return (doc?.subject ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, cap)
}

function searchUrl(q: string): string {
  const params = new URLSearchParams({ q, fields: 'key,subject', limit: '1' })
  return `${OPENLIBRARY_SEARCH}?${params.toString()}`
}

/**
 * One owned book's OpenLibrary subjects — cache-first, then a single `search.json`
 * lookup. A miss, a non-2xx, a throw, or a subject-less work all resolve to `[]`,
 * and that `[]` is cached too (bounded by the same long TTL as descriptions) so a
 * book OL can't classify isn't re-fetched every refresh.
 */
async function fetchOwnedBookSubjects(
  book: OwnedBook,
  cfg: CandidatesConfig,
  now: number,
): Promise<string[]> {
  const cacheKey = `olsubj:${candidateKey(book.title, book.author)}`
  const cached = readCandidateCache<{ subjects: string[] }>(
    cacheKey,
    cfg.DESCRIPTION_CACHE_TTL_MS,
    now,
  )
  if (cached) return cached.subjects

  let subjects: string[] = []
  try {
    const res = await fetch(searchUrl(ownedBookQuery(book.title, book.author)), {
      signal: AbortSignal.timeout(cfg.FETCH_TIMEOUT_MS),
      headers: OL_HEADERS,
    })
    if (res.ok) {
      const body = (await res.json()) as { docs?: OpenLibraryDoc[] }
      subjects = extractSubjects(body.docs?.[0], cfg.MAX_SUBJECTS_PER_DOC)
    }
  } catch {
    subjects = [] // degrade to author/manual-tag seeding for this book
  }
  writeCandidateCache(cacheKey, { subjects }, now)
  return subjects
}

/**
 * Resolve every owned book to its OpenLibrary subjects, keyed by item id. Cache-first
 * with bounded concurrency (same single host as the search + description fetches).
 * Touches the network + candidate_cache; the callers (the OpenLibrary seed builder)
 * fold the subjects into `subject:` queries.
 */
export async function resolveOwnedBookSubjects(
  books: OwnedBook[],
  opts: { now?: number; cfg?: CandidatesConfig } = {},
): Promise<Map<string, string[]>> {
  const cfg = opts.cfg ?? CANDIDATES
  const now = opts.now ?? Date.now()
  const out = new Map<string, string[]>()
  if (books.length === 0) return out
  const resolved = await mapPool(books, cfg.DESCRIPTION_CONCURRENCY, (b) =>
    fetchOwnedBookSubjects(b, cfg, now),
  )
  books.forEach((b, i) => out.set(b.id, resolved[i]))
  return out
}
