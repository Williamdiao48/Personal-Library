import { JSDOM } from 'jsdom'
import { fetchPageWithBrowser } from '../../capture/fetch'
import { classifyFfnMetaLine } from '../../capture/sites/ffnet'
import type { LikedItem } from '../taste'
import type { CandidateSource } from '../candidateSource'
import type { Candidate } from '../candidates'
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

  return {
    title,
    author,
    subjects,
    coverUrl: null,
    sourceId: `${FFN_ORIGIN}/s/${idMatch[1]}`,
    isbn: null,
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
 * Fetch (via the CF BrowserWindow), parse, dedup and cap FFN candidates for a batch
 * of queries. Cache-first (`ffn:<url>`, long TTL). A single query failing yields
 * `[]` so one bad query never sinks the batch. Touches the browser + cache.
 */
export async function fetchFfnCandidates(
  queries: FfnQuery[],
  opts: { now?: number; cfg?: typeof FFN_SOURCE } = {},
): Promise<Candidate[]> {
  const cfg = opts.cfg ?? FFN_SOURCE
  const now = opts.now ?? Date.now()
  const byId = new Map<string, Candidate>()
  for (const query of queries) {
    if (byId.size >= cfg.MAX_CANDIDATES) break
    const key = `ffn:${query.url}`
    let cands = readCandidateCache<Candidate[]>(key, cfg.CACHE_TTL_MS, now)
    if (!cands) {
      try {
        cands = parseFfnResultsPage(await fetchPageWithBrowser(query.url), cfg)
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
