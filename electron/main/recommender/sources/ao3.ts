import { JSDOM } from 'jsdom'
import { fetchPage } from '../../capture/fetch'
import type { LikedItem } from '../taste'
import type { CandidateSource } from '../candidateSource'
import type { Candidate } from '../candidates'
import {
  buildAo3RawSeeds,
  buildLengthProfile,
  type Ao3TagSeeds,
  type LengthProfile,
} from '../tasteSeeds'
import { resolveAo3Seeds } from '../tagResolve'
import { readCandidateCache, writeCandidateCache } from '../candidateCache'

// F4 (+ recall upgrade) — the AO3 candidate source: recommend *actual fanfiction*.
// AO3's works search is tag-native, so instead of a bag of keywords we anchor each
// query on the user's own AO3-canonical tags via the EXACT named fields — pairings
// and characters first (the strongest taste signal), then fandom for breadth —
// sorted by kudos and paginated a couple pages deep so the pool spans the whole
// popularity range, not just a fandom's all-time top-20. A soft length/completion
// band (from the reader's own liked-fic stats) narrows only when their taste is
// clearly skewed. Precision comes from the taste-vector rerank downstream; the
// query's job is recall. Respectful: cache-first, capped requests, a polite delay,
// index pages only (never full works), plain HTTP via fetchPage. The query builder
// + blurb parser are pure; only fetchAo3Candidates touches the network + cache.

export const AO3_SOURCE = {
  MAX_RELATIONSHIP_QUERIES: 3, // pairings first — the strongest signal
  MAX_CHARACTER_QUERIES: 2,
  MAX_FANDOM_QUERIES: 2, // fandom-wide breadth, fetched last (fills leftover slots)
  PAGES_PER_QUERY: 2, // paginate deep enough to break the top-20 kudos bias
  MAX_REQUESTS: 10, // hard etiquette cap on total page fetches per recommend()
  REQUEST_DELAY_MS: 500, // polite delay between real fetches (AO3 is volunteer-run)
  MAX_SUBJECTS_PER_BLURB: 12, // cap the tags folded into a candidate's embed text
  MAX_CANDIDATES: 80, // cap the merged/deduped set
  CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
}

/** A single AO3 search: the fully-keyed `work_search[...]` fields (minus `page`). */
export interface Ao3Query {
  term: string
  weight: number
  params: Record<string, string>
}

const AO3_ORIGIN = 'https://archiveofourown.org'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Quote a term so AO3's free-text field treats a multi-word tag as a phrase. */
function phrase(term: string): string {
  return `"${term.replace(/"/g, ' ').trim()}"`
}

/**
 * Assemble the `work_search[...]` fields for one anchor: the named (or free-text)
 * tag field, the soft length band (word_count range + complete) when the profile
 * carries one, kudos sort, English. `page` is appended later, per fetch.
 */
function queryParams(field: string, value: string, length: LengthProfile): Record<string, string> {
  const p: Record<string, string> = { [`work_search[${field}]`]: value }
  if (length.wordFloor) p['work_search[word_count]'] = `>${length.wordFloor}`
  else if (length.wordCeil) p['work_search[word_count]'] = `<${length.wordCeil}`
  if (length.completeOnly) p['work_search[complete]'] = 'T'
  p['work_search[sort_column]'] = 'kudos_count'
  p['work_search[language_id]'] = 'en'
  return p
}

/** Absolute works-search URL for a query at a given 1-based page. */
export function ao3PageUrl(query: Ao3Query, page: number): string {
  const p = new URLSearchParams(query.params)
  if (page > 1) p.set('page', String(page))
  return `${AO3_ORIGIN}/works/search?${p.toString()}`
}

/**
 * Build AO3 search queries from the AO3-canonical seeds, in priority order:
 * pairings (`relationship_names`) → characters (`character_names`) → fandoms
 * (`fandom_names`). Each uses AO3's EXACT named field, so a pairing filters rather
 * than ANDing a phrase into free text (the query-poisoning bug). Genres are
 * deliberately NOT hard-filtered here ("loosely") — the reranker weighs them via
 * `subjects`. Falls back to a single fuzzy free-text `query` on a non-AO3 fandom
 * only when there's no AO3-canonical anchor at all (an FFN-only library); with
 * nothing, `[]` (skip AO3). Pure.
 */
export function buildAo3Queries(
  seeds: Ao3TagSeeds,
  length: LengthProfile,
  cfg = AO3_SOURCE,
): Ao3Query[] {
  const queries: Ao3Query[] = []
  const add = (field: string, t: { term: string; weight: number }): void => {
    queries.push({ term: t.term, weight: t.weight, params: queryParams(field, t.term, length) })
  }
  for (const r of seeds.relationships.slice(0, cfg.MAX_RELATIONSHIP_QUERIES))
    add('relationship_names', r)
  for (const c of seeds.characters.slice(0, cfg.MAX_CHARACTER_QUERIES)) add('character_names', c)
  for (const f of seeds.fandoms.slice(0, cfg.MAX_FANDOM_QUERIES)) add('fandom_names', f)
  if (queries.length === 0 && seeds.fandomsFreeText.length > 0) {
    const f = seeds.fandomsFreeText[0]
    queries.push({
      term: f.term,
      weight: f.weight,
      params: queryParams('query', phrase(f.term), length),
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

/**
 * Fetch, parse, dedup and cap AO3 candidates for a batch of queries, paginating
 * each up to PAGES_PER_QUERY pages. Cache-first (per-page key `ao3:<url>`); a
 * polite delay separates real network fetches, and a hard MAX_REQUESTS budget +
 * MAX_CANDIDATES cap keep the footprint small. A page that fails or comes back
 * empty stops that query's pagination without sinking the batch. Touches the
 * network + cache.
 */
export async function fetchAo3Candidates(
  queries: Ao3Query[],
  opts: { now?: number; cfg?: typeof AO3_SOURCE; delayMs?: number } = {},
): Promise<Candidate[]> {
  const cfg = opts.cfg ?? AO3_SOURCE
  const now = opts.now ?? Date.now()
  const delayMs = opts.delayMs ?? cfg.REQUEST_DELAY_MS
  const byId = new Map<string, Candidate>()
  let requests = 0

  for (const query of queries) {
    if (byId.size >= cfg.MAX_CANDIDATES || requests >= cfg.MAX_REQUESTS) break
    for (let page = 1; page <= cfg.PAGES_PER_QUERY; page++) {
      if (byId.size >= cfg.MAX_CANDIDATES || requests >= cfg.MAX_REQUESTS) break
      const url = ao3PageUrl(query, page)
      const key = `ao3:${url}`
      let cands = readCandidateCache<Candidate[]>(key, cfg.CACHE_TTL_MS, now)
      if (!cands) {
        if (delayMs > 0 && requests > 0) await sleep(delayMs)
        requests++
        try {
          cands = parseAo3ResultsPage(await fetchPage(url), cfg)
          writeCandidateCache(key, cands, now)
        } catch {
          cands = []
        }
      }
      for (const cand of cands) {
        if (byId.has(cand.sourceId)) continue
        byId.set(cand.sourceId, cand)
        if (byId.size >= cfg.MAX_CANDIDATES) break
      }
      if (cands.length === 0) break // no results → no further pages for this query
    }
  }
  return [...byId.values()]
}

export const ao3Source: CandidateSource = {
  name: 'ao3',
  async fetch(liked: LikedItem[]): Promise<Candidate[]> {
    // Resolve FFN-abbreviated tags → canonical AO3 vocab (cached) before querying.
    const seeds = await resolveAo3Seeds(buildAo3RawSeeds(liked))
    const queries = buildAo3Queries(seeds, buildLengthProfile(liked))
    if (queries.length === 0) return []
    return fetchAo3Candidates(queries)
  },
}
