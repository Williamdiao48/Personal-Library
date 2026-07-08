import { get, run } from '../db'
import type { SeedQuery } from './seedQueries'

// C4.3 — OpenLibrary candidate generation (§9 step 1). Turn seed queries into a
// deduplicated set of real books: hit `search.json` (free, no key), normalize
// each doc to the shape the rerank needs, and cache raw payloads by query with a
// TTL (candidate_cache, migration 20) so repeat recommend() calls don't re-hit
// their API. Only the cache read/write and the network call touch the outside
// world — the normalizer is pure. Subjects-only in v1 (D-C4-2): no per-work
// description fetch.

const OPENLIBRARY_SEARCH = 'https://openlibrary.org/search.json'
// Fields we ask OpenLibrary for — subjects included so a single call yields the
// candidate's embed text (title/author/subjects); no N+1 works fetch (D-C4-2).
const FIELDS = 'key,title,author_name,subject,cover_i,isbn'
// OpenLibrary asks clients to send a descriptive User-Agent identifying the app.
const OL_HEADERS = {
  'User-Agent': 'PersonalLibrary/0.5 (personal reading app; recommender)',
  Accept: 'application/json',
}

export interface CandidatesConfig {
  MAX_SUBJECTS_PER_DOC: number
  LIMIT_PER_QUERY: number
  MAX_CANDIDATES: number
  CACHE_TTL_MS: number
  FETCH_TIMEOUT_MS: number
}

export const CANDIDATES: CandidatesConfig = {
  MAX_SUBJECTS_PER_DOC: 8, // cap the subjects folded into a candidate's embed text
  LIMIT_PER_QUERY: 20, // docs requested per seed query
  MAX_CANDIDATES: 80, // cap the merged/deduped set (§9: ~50–100)
  CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
  FETCH_TIMEOUT_MS: 15_000,
}

/** Which generator produced a candidate — books vs. the fanfic sources. */
export type SourceName = 'book' | 'ao3' | 'ffn'

/**
 * A normalized recommendation candidate — the same content-only shape the rerank
 * embeds, whether it's an OpenLibrary book or an AO3/FFN fic. For fics, `subjects`
 * carries the work's native tags (so it embeds exactly like a book's subjects) and
 * `isbn` is null.
 */
export interface Candidate {
  title: string
  author: string | null
  subjects: string[]
  coverUrl: string | null
  /** OpenLibrary work key (`/works/OL45804W`) or a fic's work URL; the dedup identity. */
  sourceId: string
  isbn: string | null
  /** The generator that produced this candidate (dedup namespacing, display, diversity). */
  source: SourceName
}

/** The subset of an OpenLibrary `search.json` doc we read (all fields optional). */
export interface OpenLibraryDoc {
  key?: string
  title?: string
  author_name?: string[]
  subject?: string[]
  cover_i?: number
  isbn?: string[]
}

/** Build a cover image URL from OpenLibrary's numeric cover id, or null. */
export function coverUrlFromId(coverId: number | undefined): string | null {
  return typeof coverId === 'number' ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null
}

/** Lowercase, strip punctuation, collapse whitespace — for tolerant title/author matching. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The normalized dedup identity for a book/fic: `title|author`, lowercased with
 * punctuation stripped and whitespace collapsed (exact-normalized, no fuzzy match).
 * Shared by the library/dismissed set builders, cross-source union, and
 * `filterCandidates` so every side normalizes identically.
 */
export function candidateKey(title: string, author: string | null): string {
  return `${norm(title)}|${norm(author ?? '')}`
}

/**
 * Normalize one `search.json` doc → Candidate, or null when it has no usable
 * title. Tolerates every field being absent (OpenLibrary omits them freely).
 * `sourceId` falls back to a synthetic title|author key when the work key is
 * missing, so dedup still works.
 */
export function normalizeOpenLibraryDoc(
  doc: OpenLibraryDoc,
  cfg: { MAX_SUBJECTS_PER_DOC: number } = CANDIDATES,
): Candidate | null {
  const title = doc.title?.trim()
  if (!title) return null
  const author = doc.author_name?.[0]?.trim() || null
  const subjects = (doc.subject ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, cfg.MAX_SUBJECTS_PER_DOC)
  const sourceId =
    doc.key?.trim() || `synthetic:${title.toLowerCase()}|${(author ?? '').toLowerCase()}`
  return {
    title,
    author,
    subjects,
    coverUrl: coverUrlFromId(doc.cover_i),
    sourceId,
    isbn: doc.isbn?.[0]?.trim() || null,
    source: 'book',
  }
}

// ── candidate_cache (TTL) ──────────────────────────────────────────────────────

interface CacheRow {
  payload_json: string
  fetched_at: number
}

/** Fresh cached docs for a query key, or null on miss / stale / parse failure. */
function readCache(queryKey: string, ttlMs: number, now: number): OpenLibraryDoc[] | null {
  const row = get<CacheRow>(
    `SELECT payload_json, fetched_at FROM candidate_cache WHERE query_key = ?`,
    [queryKey],
  )
  if (!row) return null
  if (now - row.fetched_at > ttlMs) return null // stale → force a re-fetch
  try {
    return JSON.parse(row.payload_json) as OpenLibraryDoc[]
  } catch {
    return null
  }
}

function writeCache(queryKey: string, docs: OpenLibraryDoc[], now: number): void {
  run(
    `INSERT INTO candidate_cache (query_key, payload_json, fetched_at)
     VALUES (?, ?, ?)
     ON CONFLICT(query_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       fetched_at   = excluded.fetched_at`,
    [queryKey, JSON.stringify(docs), now],
  )
}

// ── fetch ───────────────────────────────────────────────────────────────────

function searchUrl(q: string, limit: number): string {
  const params = new URLSearchParams({ q, fields: FIELDS, limit: String(limit) })
  return `${OPENLIBRARY_SEARCH}?${params.toString()}`
}

/**
 * Docs for one seed query — cache-first, then network. A single query failing
 * (non-2xx or a thrown fetch) yields `[]` so one bad query never sinks the batch.
 */
async function fetchDocsForQuery(
  q: string,
  cfg: CandidatesConfig,
  now: number,
): Promise<OpenLibraryDoc[]> {
  const queryKey = `${q}::l=${cfg.LIMIT_PER_QUERY}`
  const cached = readCache(queryKey, cfg.CACHE_TTL_MS, now)
  if (cached) return cached
  try {
    const res = await fetch(searchUrl(q, cfg.LIMIT_PER_QUERY), {
      signal: AbortSignal.timeout(cfg.FETCH_TIMEOUT_MS),
      headers: OL_HEADERS,
    })
    if (!res.ok) return []
    const body = (await res.json()) as { docs?: OpenLibraryDoc[] }
    const docs = body.docs ?? []
    writeCache(queryKey, docs, now)
    return docs
  } catch {
    return []
  }
}

/**
 * Fetch, normalize, dedup and cap the candidate set for a batch of seed queries.
 * Dedup is by `sourceId` (first occurrence wins — queries are weight-ordered by
 * the seeder). Touches the network + candidate_cache; the caller (C4.4) filters
 * and reranks the result.
 */
export async function fetchCandidates(
  queries: SeedQuery[],
  opts: { now?: number; cfg?: CandidatesConfig } = {},
): Promise<Candidate[]> {
  const cfg = opts.cfg ?? CANDIDATES
  const now = opts.now ?? Date.now()
  const byId = new Map<string, Candidate>()
  for (const query of queries) {
    if (byId.size >= cfg.MAX_CANDIDATES) break
    const docs = await fetchDocsForQuery(query.q, cfg, now)
    for (const doc of docs) {
      const cand = normalizeOpenLibraryDoc(doc, cfg)
      if (!cand || byId.has(cand.sourceId)) continue
      byId.set(cand.sourceId, cand)
      if (byId.size >= cfg.MAX_CANDIDATES) break
    }
  }
  return [...byId.values()]
}
