import { JSDOM } from 'jsdom'
import { get, run } from '../../db'
import { fetchPage } from '../../capture/fetch'
import type { LikedItem } from '../taste'
import type { CandidateSource } from '../candidateSource'
import type { Candidate } from '../candidates'
import { buildTasteSeeds, type TasteSeeds } from '../tasteSeeds'

// F4 — the AO3 candidate source: recommend *actual fanfiction*. Unlike OpenLibrary
// (a book keyword API), AO3's works search is tag-native, so we anchor each query
// on a fandom the user loves — refined by their top relationship/freeform tags —
// sorted by kudos, and parse the results-index blurbs into Candidates the shared
// rerank scores against the taste vector. Respectful: cache-first (candidate_cache
// TTL), a handful of queries, index pages only (never full works), plain HTTP via
// fetchPage. The query builder + blurb parser are pure; only fetchAo3Candidates
// touches the network + cache.

export const AO3_SOURCE = {
  MAX_FANDOM_QUERIES: 4, // one fandom-anchored query each (respectful footprint)
  EXTRA_TERMS: 2, // top relationship/freeform terms folded into every query
  MAX_SUBJECTS_PER_BLURB: 12, // cap the tags folded into a candidate's embed text
  MAX_CANDIDATES: 60, // cap the merged/deduped set
  CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
}

export interface Ao3Query {
  term: string
  url: string
  weight: number
}

const AO3_ORIGIN = 'https://archiveofourown.org'

/** Quote a term so AO3 treats a multi-word tag as a phrase (and strip stray quotes). */
function phrase(term: string): string {
  return `"${term.replace(/"/g, ' ').trim()}"`
}

function ao3SearchUrl(query: string): string {
  const params = new URLSearchParams()
  params.set('work_search[query]', query)
  params.set('work_search[sort_column]', 'kudos_count')
  params.set('work_search[language_id]', 'en')
  return `${AO3_ORIGIN}/works/search?${params.toString()}`
}

/**
 * Build fandom-anchored AO3 search queries from the taste seeds: one query per top
 * fandom, each refined by the user's top relationship/freeform terms and sorted by
 * kudos. With no fandoms to anchor on, fall back to a single freeform/relationship
 * query; with neither, `[]` (this library has no fanfic signal → skip AO3).
 */
export function buildAo3Queries(seeds: TasteSeeds, cfg = AO3_SOURCE): Ao3Query[] {
  const extras = [...seeds.relationships, ...seeds.freeforms]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, cfg.EXTRA_TERMS)
    .map((t) => t.term)

  const queries: Ao3Query[] = []
  for (const f of seeds.fandoms.slice(0, cfg.MAX_FANDOM_QUERIES)) {
    const q = [phrase(f.term), ...extras.map(phrase)].join(' ')
    queries.push({ term: f.term, url: ao3SearchUrl(q), weight: f.weight })
  }
  if (queries.length === 0 && extras.length > 0) {
    queries.push({
      term: extras.join(' '),
      url: ao3SearchUrl(extras.map(phrase).join(' ')),
      weight: 1,
    })
  }
  return queries
}

/** Collect trimmed `a.tag` texts under any of the given selectors, in order. */
function collectTags(li: Element, selectors: string[]): string[] {
  const out: string[] = []
  for (const sel of selectors) {
    for (const a of Array.from(li.querySelectorAll(sel))) {
      const t = a.textContent?.trim()
      if (t) out.push(t)
    }
  }
  return out
}

/**
 * Parse one AO3 works-index `<li.work.blurb>` into a Candidate, or null when it has
 * no title / work link. `subjects` carries the blurb's fandoms + relationships +
 * characters + freeforms so the fic embeds like a book's subjects. Pure.
 */
export function parseAo3Blurb(li: Element, cfg = AO3_SOURCE): Candidate | null {
  const titleEl = li.querySelector('h4.heading a[href^="/works/"]')
  const href = titleEl?.getAttribute('href')
  const title = titleEl?.textContent?.trim()
  if (!title || !href) return null

  let sourceId: string
  try {
    sourceId = new URL(href, AO3_ORIGIN).href
  } catch {
    return null
  }

  const author = li.querySelector('a[rel="author"]')?.textContent?.trim() || null
  const subjects = collectTags(li, [
    '.fandoms a.tag',
    'li.relationships a.tag',
    'li.characters a.tag',
    'li.freeforms a.tag',
  ]).slice(0, cfg.MAX_SUBJECTS_PER_BLURB)

  return { title, author, subjects, coverUrl: null, sourceId, isbn: null, source: 'ao3' }
}

/** Parse every blurb in an AO3 works-index results page. Pure. */
export function parseAo3ResultsPage(html: string, cfg = AO3_SOURCE): Candidate[] {
  const doc = new JSDOM(html).window.document
  const out: Candidate[] = []
  for (const li of Array.from(doc.querySelectorAll('li.work.blurb'))) {
    const cand = parseAo3Blurb(li, cfg)
    if (cand) out.push(cand)
  }
  return out
}

// ── candidate_cache (TTL), namespaced to AO3 so keys never collide with books ──
interface CacheRow {
  payload_json: string
  fetched_at: number
}

function readCache(key: string, ttlMs: number, now: number): Candidate[] | null {
  const row = get<CacheRow>(
    `SELECT payload_json, fetched_at FROM candidate_cache WHERE query_key = ?`,
    [key],
  )
  if (!row || now - row.fetched_at > ttlMs) return null
  try {
    return JSON.parse(row.payload_json) as Candidate[]
  } catch {
    return null
  }
}

function writeCache(key: string, cands: Candidate[], now: number): void {
  run(
    `INSERT INTO candidate_cache (query_key, payload_json, fetched_at)
     VALUES (?, ?, ?)
     ON CONFLICT(query_key) DO UPDATE SET
       payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
    [key, JSON.stringify(cands), now],
  )
}

/**
 * Fetch, parse, dedup and cap AO3 candidates for a batch of queries. Cache-first
 * (candidate_cache keyed `ao3:<url>`). A single query failing (network / parse)
 * yields `[]` so one bad query never sinks the batch. Touches the network + cache.
 */
export async function fetchAo3Candidates(
  queries: Ao3Query[],
  opts: { now?: number; cfg?: typeof AO3_SOURCE } = {},
): Promise<Candidate[]> {
  const cfg = opts.cfg ?? AO3_SOURCE
  const now = opts.now ?? Date.now()
  const byId = new Map<string, Candidate>()
  for (const query of queries) {
    if (byId.size >= cfg.MAX_CANDIDATES) break
    const key = `ao3:${query.url}`
    let cands = readCache(key, cfg.CACHE_TTL_MS, now)
    if (!cands) {
      try {
        cands = parseAo3ResultsPage(await fetchPage(query.url), cfg)
        writeCache(key, cands, now)
      } catch {
        cands = []
      }
    }
    for (const cand of cands) {
      if (byId.has(cand.sourceId)) continue
      byId.set(cand.sourceId, cand)
      if (byId.size >= cfg.MAX_CANDIDATES) break
    }
  }
  return [...byId.values()]
}

export const ao3Source: CandidateSource = {
  name: 'ao3',
  async fetch(liked: LikedItem[]): Promise<Candidate[]> {
    const queries = buildAo3Queries(buildTasteSeeds(liked))
    if (queries.length === 0) return []
    return fetchAo3Candidates(queries)
  },
}
