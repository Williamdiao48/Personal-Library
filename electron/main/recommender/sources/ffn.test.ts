import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The FFN source's impure edges are the CF browser fetch + the cache (DB). It now
// fetches all cache-miss URLs through ONE reused window via fetchPagesSequential
// (which returns one HTML string per URL), so we mock that and drive real query
// building / blurb parsing / dedup / cache against an in-memory DB (Node ABI).
// Builders + parsers are pure.
vi.mock('../../capture/fetch', () => ({
  fetchPageWithBrowser: vi.fn(),
  fetchPagesWithSession: vi.fn(),
  fetchPagesSequential: vi.fn(),
}))

import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../../test/db/harness'
import { fetchPagesSequential } from '../../capture/fetch'
import {
  buildFfnQueries,
  parseFfnResultsPage,
  fetchFfnCandidates,
  ffnSource,
  FFN_SOURCE,
  type FfnQuery,
} from './ffn'
import type { TasteSeeds } from '../tasteSeeds'
import { CANDIDATE_TEXT_VERSION } from '../candidates'

// fetchPagesSequential resolves to one HTML string per requested URL, in order.
const mockFetch = vi.mocked(fetchPagesSequential)

const emptySeeds = (): TasteSeeds => ({
  authors: [],
  fandoms: [],
  relationships: [],
  characters: [],
  freeforms: [],
  genres: [],
})

// Story One mirrors real FFN markup: the summary and the `.xgray` meta line share
// the `.z-indent` wrapper. Story Two has no summary wrapper (meta only) to prove the
// null path — and that subjects still parse from a non-nested `.xgray`.
const RESULTS_HTML = `<div id="content_wrapper">
  <div class="z-list zhover">
    <a class="stitle" href="/s/111/1/Story-One">Story One</a>
    <a href="/u/5/Ava">Ava</a>
    <div class="z-indent z-padtop">Harry finds a mysterious map that changes everything.<div class="z-padtop2 xgray">Rated: T - English - Adventure/Romance - Harry P., Hermione G. - Chapters: 5 - Words: 10,000 - Favs: 100 - Status: Complete - id: 111</div></div>
  </div>
  <div class="z-list zhover">
    <a class="stitle" href="/s/222/1/Story-Two">Story Two</a>
    <a href="/u/6/Ben">Ben</a>
    <div class="z-padtop2 xgray">Rated: M - English - Angst - Chapters: 1 - Words: 500</div>
  </div>
</div>`

// ── buildFfnQueries (pure) ────────────────────────────────────────────────────
describe('buildFfnQueries', () => {
  it('anchors one keyword query per top fandom, folding in freeform/genre terms', () => {
    const seeds: TasteSeeds = {
      ...emptySeeds(),
      fandoms: [{ term: 'Harry Potter', weight: 3 }],
      freeforms: [{ term: 'Time Travel', weight: 2 }],
      genres: [{ term: 'Adventure', weight: 1 }],
    }
    const qs = buildFfnQueries(seeds)
    expect(qs).toHaveLength(1)
    const kw = decodeURIComponent(qs[0].url).replace(/\+/g, ' ')
    expect(kw).toContain('Harry Potter')
    expect(kw).toContain('Time Travel')
    expect(qs[0].url).toContain('type=story')
  })

  it('returns [] with no fandom to anchor on (FFN keyword search would be noise)', () => {
    expect(buildFfnQueries({ ...emptySeeds(), genres: [{ term: 'Drama', weight: 1 }] })).toEqual([])
  })
})

// ── parseFfnResultsPage (pure) ────────────────────────────────────────────────
describe('parseFfnResultsPage', () => {
  it('parses each z-list row into a fic Candidate with an /s/<id> source URL + tags', () => {
    const cands = parseFfnResultsPage(RESULTS_HTML)
    expect(cands.map((c) => c.title)).toEqual(['Story One', 'Story Two'])
    expect(cands[0]).toMatchObject({
      title: 'Story One',
      author: 'Ava',
      sourceId: 'https://www.fanfiction.net/s/111',
      source: 'ffn',
    })
    expect(cands[0].subjects).toEqual(
      expect.arrayContaining(['Adventure', 'Romance', 'Harry P.', 'Hermione G.']),
    )
    expect(cands[1].subjects).toEqual(['Angst'])
    // The summary is folded into `description`, excluding the nested `.xgray` meta;
    // a row without a `.z-indent` wrapper yields null.
    expect(cands[0].description).toBe('Harry finds a mysterious map that changes everything.')
    expect(cands[1].description).toBeNull()
  })
})

// ── fetchFfnCandidates + ffnSource (browser + cache) ──────────────────────────
describe('fetchFfnCandidates', () => {
  let db: TestDb
  const query = (url: string): FfnQuery => ({ term: 't', url, weight: 1 })

  beforeEach(() => {
    db = openTestDb()
    mockFetch.mockReset()
  })
  afterEach(() => closeTestDb())

  it('fetches + parses + dedups, then serves a cache hit without re-fetching', async () => {
    mockFetch.mockResolvedValue([RESULTS_HTML])
    const q = query('https://www.fanfiction.net/search/?keywords=x&type=story&ready=1')

    const out = await fetchFfnCandidates([q], { now: 1000 })
    expect(out.map((c) => c.sourceId)).toEqual([
      'https://www.fanfiction.net/s/111',
      'https://www.fanfiction.net/s/222',
    ])
    await fetchFfnCandidates([q], { now: 2000 }) // within TTL
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // The cache key carries the embed-text version so a recipe bump re-scrapes.
    const key = db.prepare(`SELECT query_key FROM candidate_cache LIMIT 1`).get() as {
      query_key: string
    }
    expect(key.query_key.startsWith(`ffn:v${CANDIDATE_TEXT_VERSION}:`)).toBe(true)
  })

  it('soft-fails when the batch fetch throws, without sinking the source', async () => {
    mockFetch.mockRejectedValue(new Error('cloudflare'))
    expect(await fetchFfnCandidates([query('https://www.fanfiction.net/search/?q=z')])).toEqual([])
  })

  it('a Refresh (soft-floor cfg) re-scrapes a pool the default TTL would still serve', async () => {
    // Aged past the 24 h soft floor but well inside the 14 d hard TTL: a normal read
    // serves cache; a fresh Refresh (soft-floor cfg) re-scrapes the CF window.
    mockFetch.mockResolvedValue([RESULTS_HTML])
    const q = query('https://www.fanfiction.net/search/?keywords=x&type=story&ready=1')
    const t0 = 1000
    await fetchFfnCandidates([q], { now: t0 })
    const aged = t0 + FFN_SOURCE.SOFT_FLOOR_MS + 1

    await fetchFfnCandidates([q], { now: aged }) // default TTL → cache hit
    expect(mockFetch).toHaveBeenCalledTimes(1)

    await fetchFfnCandidates([q], {
      now: aged,
      cfg: { ...FFN_SOURCE, CACHE_TTL_MS: FFN_SOURCE.SOFT_FLOOR_MS },
    })
    expect(mockFetch).toHaveBeenCalledTimes(2) // re-scraped
  })

  it('fetches all cache-miss queries through a single shared window', async () => {
    mockFetch.mockResolvedValue([RESULTS_HTML, ''])
    const qs = [
      query('https://www.fanfiction.net/search/?keywords=a&type=story&ready=1'),
      query('https://www.fanfiction.net/search/?keywords=b&type=story&ready=1'),
    ]
    await fetchFfnCandidates(qs, { now: 1000 })
    // One call, both miss URLs passed together (one window, CF solved once).
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][0]).toEqual(qs.map((q) => q.url))
  })

  it('ffnSource.fetch builds fandom-anchored queries from liked items and returns fics', async () => {
    const id = seedItem(db, { author: 'Owner' })
    db.prepare(
      `INSERT INTO item_source_tags (item_id, name, category) VALUES (?, 'Harry Potter', 'fandom')`,
    ).run(id)
    mockFetch.mockResolvedValue([RESULTS_HTML])

    const out = await ffnSource.fetch([{ id, weight: 1 }])
    expect(out.map((c) => c.title)).toEqual(['Story One', 'Story Two'])
    expect(out.every((c) => c.source === 'ffn')).toBe(true)
  })

  it('ffnSource.fetch returns [] for a library with no fandom tags', async () => {
    const id = seedItem(db, { author: 'Owner' })
    expect(await ffnSource.fetch([{ id, weight: 1 }])).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
