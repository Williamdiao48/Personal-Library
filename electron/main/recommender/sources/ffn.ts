import { JSDOM } from 'jsdom'
import { fetchPagesSequential } from '../../capture/fetch'
import { classifyFfnMetaLine } from '../../capture/sites/ffnet'
import type { LikedItem } from '../taste'
import type { CandidateSource } from '../candidateSource'
import { CANDIDATE_TEXT_VERSION, type Candidate } from '../candidates'
import { buildTasteSeeds, type TasteSeeds } from '../tasteSeeds'
import { readCandidateCache, writeCandidateCache } from '../candidateCache'

// F5 — the FFN candidate source. FFN has no API and sits behind Cloudflare, so
// this is the fragile part of the feature (D1): fandom-anchored keyword search
// fetched through the same CF-passing BrowserWindow the capture path uses, behind
// an aggressive cache, user-triggered only, sequenced AFTER AO3 so the feature
// still ships on AO3 if FFN breaks. The query builder + blurb parser are pure;
// only fetchFfnCandidates touches the browser + cache. Reuses the story-page
// metadata classifier (classifyFfnMetaLine) — search blurbs carry the same line.

export const FFN_SOURCE = {
  MAX_FANDOM_QUERIES: 3, // one keyword query per top fandom (expensive — keep low)
  EXTRA_TERMS: 2, // top freeform/genre terms folded into every query
  MAX_SUBJECTS_PER_BLURB: 10,
  MAX_CANDIDATES: 40,
  CACHE_TTL_MS: 14 * 24 * 60 * 60 * 1000, // 14 days — FFN is costly, cache hard
  REQUEST_DELAY_MS: 1200, // polite delay between pages in the shared CF window
}

export interface FfnQuery {
  term: string
  url: string
  weight: number
}

const FFN_ORIGIN = 'https://www.fanfiction.net'

function ffnSearchUrl(keywords: string): string {
  const params = new URLSearchParams()
  params.set('keywords', keywords)
  params.set('type', 'story')
  params.set('ready', '1')
  return `${FFN_ORIGIN}/search/?${params.toString()}`
}

/**
 * Build FFN story-search queries: one per top fandom, keyword = fandom + the top
 * freeform/genre terms. FFN keyword search without a fandom anchor is pure noise,
 * so with no fandoms we return `[]` (skip FFN for this library).
 */
export function buildFfnQueries(seeds: TasteSeeds, cfg = FFN_SOURCE): FfnQuery[] {
  const extras = [...seeds.freeforms, ...seeds.genres]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, cfg.EXTRA_TERMS)
    .map((t) => t.term)

  const queries: FfnQuery[] = []
  for (const f of seeds.fandoms.slice(0, cfg.MAX_FANDOM_QUERIES)) {
    const keywords = [f.term, ...extras].join(' ')
    queries.push({ term: f.term, url: ffnSearchUrl(keywords), weight: f.weight })
  }
  return queries
}

/**
 * Parse one FFN search-result `<div.z-list>` into a fic Candidate, or null with no
 * story link. `subjects` reuses the shared metadata classifier over the blurb's
 * `.xgray` line (genres + characters). Pure.
 */
export function parseFfnBlurb(el: Element, cfg = FFN_SOURCE): Candidate | null {
  const titleEl = el.querySelector('a.stitle')
  const href = titleEl?.getAttribute('href')
  const title = titleEl?.textContent?.trim()
  const idMatch = href ? /\/s\/(\d+)/.exec(href) : null
  if (!title || !idMatch) return null

  const author = el.querySelector('a[href^="/u/"]')?.textContent?.trim() || null
  const metaText =
    el.querySelector('.z-padtop2.xgray')?.textContent ??
    el.querySelector('.xgray')?.textContent ??
    ''
  const subjects = classifyFfnMetaLine(metaText)
    .tags.map((t) => t.name)
    .slice(0, cfg.MAX_SUBJECTS_PER_BLURB)
  // The summary + meta line share the `.z-indent` wrapper; clone it and drop the
  // nested `.xgray` meta so `description` is the blurb text alone (no "Rated: …").
  let description: string | null = null
  const indent = el.querySelector('.z-indent')
  if (indent) {
    const clone = indent.cloneNode(true) as Element
    clone.querySelector('.xgray')?.remove()
    description = clone.textContent?.trim() || null
  }

  return {
    title,
    author,
    subjects,
    coverUrl: null,
    sourceId: `${FFN_ORIGIN}/s/${idMatch[1]}`,
    isbn: null,
    description,
    source: 'ffn',
  }
}

/** Parse every story row in an FFN search-results page. Pure. */
export function parseFfnResultsPage(html: string, cfg = FFN_SOURCE): Candidate[] {
  const doc = new JSDOM(html).window.document
  const out: Candidate[] = []
  for (const el of Array.from(doc.querySelectorAll('div.z-list'))) {
    const cand = parseFfnBlurb(el, cfg)
    if (cand) out.push(cand)
  }
  return out
}

/**
 * Fetch, parse, dedup and cap FFN candidates for a batch of queries. Cache-first
 * (`ffn:<url>`, long TTL): only the cache-miss URLs go to the network, and they all
 * ride ONE reused BrowserWindow (`fetchPagesSequential`) so Cloudflare is solved
 * once and the session is shared — instead of spawning a fresh window (and a fresh
 * CF challenge) per query. The batch fetch rejects on any main-frame failure, so we
 * catch it and fall back to whatever was cached: one bad fetch never sinks the
 * source. Touches the browser + cache.
 */
export async function fetchFfnCandidates(
  queries: FfnQuery[],
  opts: { now?: number; cfg?: typeof FFN_SOURCE } = {},
): Promise<Candidate[]> {
  const cfg = opts.cfg ?? FFN_SOURCE
  const now = opts.now ?? Date.now()

  // Split into cache hits vs. the URLs we must fetch.
  const cached = new Map<string, Candidate[]>()
  const misses: FfnQuery[] = []
  for (const q of queries) {
    const hit = readCandidateCache<Candidate[]>(
      `ffn:v${CANDIDATE_TEXT_VERSION}:${q.url}`,
      cfg.CACHE_TTL_MS,
      now,
    )
    if (hit) cached.set(q.url, hit)
    else misses.push(q)
  }

  // Fetch every miss through a single shared window; parse + persist each.
  const fetched = new Map<string, Candidate[]>()
  if (misses.length > 0) {
    try {
      const htmls = await fetchPagesSequential(
        misses.map((q) => q.url),
        cfg.REQUEST_DELAY_MS,
      )
      misses.forEach((q, i) => {
        const cands = parseFfnResultsPage(htmls[i] ?? '', cfg)
        writeCandidateCache(`ffn:v${CANDIDATE_TEXT_VERSION}:${q.url}`, cands, now)
        fetched.set(q.url, cands)
      })
    } catch {
      // Whole batch failed (e.g. Cloudflare) — keep the cached results and move on.
    }
  }

  // Merge in query order, dedup by sourceId, cap.
  const byId = new Map<string, Candidate>()
  for (const q of queries) {
    if (byId.size >= cfg.MAX_CANDIDATES) break
    for (const cand of cached.get(q.url) ?? fetched.get(q.url) ?? []) {
      if (byId.has(cand.sourceId)) continue
      byId.set(cand.sourceId, cand)
      if (byId.size >= cfg.MAX_CANDIDATES) break
    }
  }
  return [...byId.values()]
}

export const ffnSource: CandidateSource = {
  name: 'ffn',
  async fetch(liked: LikedItem[]): Promise<Candidate[]> {
    const queries = buildFfnQueries(buildTasteSeeds(liked))
    if (queries.length === 0) return []
    return fetchFfnCandidates(queries)
  },
}
