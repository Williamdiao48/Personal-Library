import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The AO3 source's only impure edges are fetchPage (network) + candidate_cache
// (DB). Mock fetchPage and drive the real query building / blurb parsing / dedup /
// pagination / cache against an in-memory DB (Node ABI). buildAo3Queries +
// parseAo3* + ao3PageUrl are pure.
vi.mock('../../capture/fetch', () => ({ fetchPage: vi.fn(), fetchJson: vi.fn() }))

import { JSDOM } from 'jsdom'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../../test/db/harness'
import { fetchPage, fetchJson } from '../../capture/fetch'
import {
  buildAo3Queries,
  ao3PageUrl,
  parseAo3ResultsPage,
  parseAo3Blurb,
  fetchAo3Candidates,
  ao3Source,
  AO3_SOURCE,
  type Ao3Query,
} from './ao3'
import type { Ao3TagSeeds, LengthProfile } from '../tasteSeeds'

const mockFetchPage = vi.mocked(fetchPage)
const mockFetchJson = vi.mocked(fetchJson)

const emptySeeds = (): Ao3TagSeeds => ({
  relationships: [],
  characters: [],
  fandoms: [],
  fandomsFreeText: [],
})
const noBand: LengthProfile = { completeOnly: false }

const RESULTS_HTML = `<ol class="work index group">
  <li class="work blurb group" id="work_1">
    <div class="header module">
      <h4 class="heading">
        <a href="/works/111">First Fic</a> by <a rel="author" href="/users/Ava/pseuds/Ava">Ava</a>
      </h4>
      <h5 class="fandoms heading"><a class="tag">Harry Potter - J. K. Rowling</a></h5>
    </div>
    <ul class="tags commas">
      <li class="relationships"><a class="tag">Hermione Granger/Draco Malfoy</a></li>
      <li class="characters"><a class="tag">Hermione Granger</a></li>
      <li class="freeforms"><a class="tag">Slow Burn</a></li>
    </ul>
  </li>
  <li class="work blurb group" id="work_2">
    <div class="header module">
      <h4 class="heading"><a href="/works/222">Second Fic</a> by <a rel="author" href="/u">Ben</a></h4>
      <h5 class="fandoms heading"><a class="tag">Naruto</a></h5>
    </div>
  </li>
</ol>`
const EMPTY_HTML = `<ol class="work index group"></ol>`

// ── buildAo3Queries (pure) ────────────────────────────────────────────────────
describe('buildAo3Queries', () => {
  it('anchors on pairings → characters → fandoms via AO3 EXACT named fields, in priority order', () => {
    const seeds: Ao3TagSeeds = {
      relationships: [{ term: 'Hermione Granger/Draco Malfoy', weight: 3 }],
      characters: [{ term: 'Hermione Granger', weight: 2 }],
      fandoms: [{ term: 'Harry Potter - J. K. Rowling', weight: 5 }],
      fandomsFreeText: [],
    }
    const qs = buildAo3Queries(seeds, noBand)
    // relationship first (highest priority signal), then character, then fandom.
    expect(qs.map((q) => q.term)).toEqual([
      'Hermione Granger/Draco Malfoy',
      'Hermione Granger',
      'Harry Potter - J. K. Rowling',
    ])
    expect(qs[0].params['work_search[relationship_names]']).toBe('Hermione Granger/Draco Malfoy')
    expect(qs[1].params['work_search[character_names]']).toBe('Hermione Granger')
    expect(qs[2].params['work_search[fandom_names]']).toBe('Harry Potter - J. K. Rowling')
    // named fields only — never the free-text `query` (that's the poisoning path).
    expect(qs.every((q) => !('work_search[query]' in q.params))).toBe(true)
    expect(qs[0].params['work_search[sort_column]']).toBe('kudos_count')
  })

  it('applies the soft length band (word floor/ceiling + complete) to every query', () => {
    const seeds: Ao3TagSeeds = { ...emptySeeds(), fandoms: [{ term: 'Naruto', weight: 1 }] }
    const long = buildAo3Queries(seeds, { wordFloor: 40000, completeOnly: true })[0]
    expect(long.params['work_search[word_count]']).toBe('>40000')
    expect(long.params['work_search[complete]']).toBe('T')

    const short = buildAo3Queries(seeds, { wordCeil: 20000, completeOnly: false })[0]
    expect(short.params['work_search[word_count]']).toBe('<20000')
    expect('work_search[complete]' in short.params).toBe(false)
  })

  it('falls back to a fuzzy free-text query on a non-AO3 fandom only with no canonical anchor', () => {
    const ffnOnly: Ao3TagSeeds = {
      ...emptySeeds(),
      fandomsFreeText: [{ term: 'Harry Potter', weight: 1 }],
    }
    const qs = buildAo3Queries(ffnOnly, noBand)
    expect(qs).toHaveLength(1)
    expect(qs[0].params['work_search[query]']).toBe('"Harry Potter"')
    // canonical anchors win — the free-text fallback is suppressed when any exists.
    const withCanonical: Ao3TagSeeds = { ...ffnOnly, fandoms: [{ term: 'Naruto', weight: 1 }] }
    expect(
      buildAo3Queries(withCanonical, noBand).every((q) => !('work_search[query]' in q.params)),
    ).toBe(true)
    expect(buildAo3Queries(emptySeeds(), noBand)).toEqual([])
  })
})

// ── ao3PageUrl (pure) ─────────────────────────────────────────────────────────
describe('ao3PageUrl', () => {
  it('omits page for page 1 and appends it thereafter', () => {
    const q: Ao3Query = { term: 't', weight: 1, params: { 'work_search[fandom_names]': 'Naruto' } }
    expect(ao3PageUrl(q, 1)).not.toContain('page=')
    expect(ao3PageUrl(q, 3)).toContain('page=3')
    expect(ao3PageUrl(q, 1)).toContain('/works/search?')
  })
})

// ── parseAo3ResultsPage / parseAo3Blurb (pure) ────────────────────────────────
describe('parseAo3ResultsPage', () => {
  it('parses each blurb into a fic Candidate with an absolute work URL + native tags', () => {
    const cands = parseAo3ResultsPage(RESULTS_HTML)
    expect(cands.map((c) => c.title)).toEqual(['First Fic', 'Second Fic'])
    expect(cands[0]).toMatchObject({
      title: 'First Fic',
      author: 'Ava',
      sourceId: 'https://archiveofourown.org/works/111',
      source: 'ao3',
      isbn: null,
      coverUrl: null,
    })
    expect(cands[0].subjects).toEqual([
      'Harry Potter - J. K. Rowling',
      'Hermione Granger/Draco Malfoy',
      'Hermione Granger',
      'Slow Burn',
    ])
  })

  it('drops a blurb with no work link', () => {
    const doc = new JSDOM(`<li class="work blurb"><h4 class="heading">No link here</h4></li>`)
      .window.document
    expect(parseAo3Blurb(doc.querySelector('li')!)).toBeNull()
  })
})

// ── fetchAo3Candidates + ao3Source (network + cache) ──────────────────────────
describe('fetchAo3Candidates', () => {
  let db: TestDb
  const query = (params: Record<string, string>): Ao3Query => ({ term: 't', weight: 1, params })
  const relQ = query({ 'work_search[relationship_names]': 'A/B' })

  beforeEach(() => {
    db = openTestDb()
    mockFetchPage.mockReset()
    mockFetchJson.mockReset()
  })
  afterEach(() => closeTestDb())

  it('paginates deep, dedups across pages, then serves a cache hit without re-fetching', async () => {
    // page 1 = the 2 fics; page 2 = a distinct third fic (proves deep pagination + dedup).
    const PAGE2 = RESULTS_HTML.replace('/works/111', '/works/333').replace('First Fic', 'Third Fic')
    mockFetchPage.mockResolvedValueOnce(RESULTS_HTML).mockResolvedValueOnce(PAGE2)

    const out = await fetchAo3Candidates([relQ], { now: 1000, delayMs: 0 })
    expect(mockFetchPage).toHaveBeenCalledTimes(2) // PAGES_PER_QUERY
    expect(out.map((c) => c.title)).toEqual(['First Fic', 'Second Fic', 'Third Fic'])

    const cached = await fetchAo3Candidates([relQ], { now: 2000, delayMs: 0 }) // within TTL
    expect(mockFetchPage).toHaveBeenCalledTimes(2) // no new fetches
    expect(cached.map((c) => c.title)).toEqual(['First Fic', 'Second Fic', 'Third Fic'])
  })

  it('stops paginating a query as soon as a page comes back empty', async () => {
    mockFetchPage.mockResolvedValueOnce(EMPTY_HTML)
    const out = await fetchAo3Candidates([relQ], { now: 1000, delayMs: 0 })
    expect(mockFetchPage).toHaveBeenCalledTimes(1) // page 1 empty → no page 2
    expect(out).toEqual([])
  })

  it('honors the hard MAX_REQUESTS budget across queries', async () => {
    mockFetchPage.mockResolvedValue(RESULTS_HTML)
    const many = Array.from({ length: 20 }, (_, i) =>
      query({ 'work_search[relationship_names]': `Ship ${i}` }),
    )
    await fetchAo3Candidates(many, {
      now: 1000,
      delayMs: 0,
      cfg: { ...AO3_SOURCE, MAX_CANDIDATES: 999 },
    })
    expect(mockFetchPage.mock.calls.length).toBeLessThanOrEqual(AO3_SOURCE.MAX_REQUESTS)
  })

  it('re-fetches once the cache entry is older than the TTL', async () => {
    mockFetchPage.mockResolvedValue(RESULTS_HTML)
    await fetchAo3Candidates([relQ], { now: 1000, delayMs: 0 })
    await fetchAo3Candidates([relQ], { now: 1000 + AO3_SOURCE.CACHE_TTL_MS + 1, delayMs: 0 })
    // 2 pages × 2 runs = 4 (cache expired between runs).
    expect(mockFetchPage).toHaveBeenCalledTimes(4)
  })

  it('soft-fails a query whose fetch throws, without sinking the batch', async () => {
    mockFetchPage.mockRejectedValue(new Error('network down'))
    expect(await fetchAo3Candidates([relQ], { delayMs: 0 })).toEqual([])
  })

  it('ao3Source.fetch anchors on the liked items’ AO3-canonical pairings and returns fics', async () => {
    const id = seedItem(db, { author: 'Owner', source_url: 'https://archiveofourown.org/works/9' })
    db.prepare(
      `INSERT INTO item_source_tags (item_id, name, category)
       VALUES (?, 'Hermione Granger/Draco Malfoy', 'relationship')`,
    ).run(id)
    // page 1 has fics, page 2 empty → one query, no delay incurred (single request).
    mockFetchPage.mockResolvedValueOnce(RESULTS_HTML).mockResolvedValue(EMPTY_HTML)

    const out = await ao3Source.fetch([{ id, weight: 1 }])
    const relUrl = decodeURIComponent(mockFetchPage.mock.calls[0][0]).replace(/\+/g, ' ')
    expect(relUrl).toContain('work_search[relationship_names]=Hermione Granger/Draco Malfoy')
    expect(out.map((c) => c.title)).toEqual(['First Fic', 'Second Fic'])
    expect(out.every((c) => c.source === 'ao3')).toBe(true)
  })

  it('ao3Source.fetch resolves an FFN-abbreviated relationship to canonical before querying', async () => {
    // An FFN-origin item: its abbreviated relationship must be autocomplete-resolved
    // to the canonical AO3 tag, which THEN fills the exact named field.
    const id = seedItem(db, { author: 'Owner', source_url: 'https://www.fanfiction.net/s/9' })
    db.prepare(
      `INSERT INTO item_source_tags (item_id, name, category) VALUES (?, 'Harry P./Fleur D.', 'relationship')`,
    ).run(id)
    // autocomplete (fetchJson) resolves the abbreviation; search (fetchPage) fetches fics.
    mockFetchJson.mockResolvedValue(JSON.stringify([{ name: 'Fleur Delacour/Harry Potter' }]))
    mockFetchPage.mockImplementation(async (url: string) =>
      url.includes('page=') ? EMPTY_HTML : RESULTS_HTML,
    )

    const out = await ao3Source.fetch([{ id, weight: 1 }])
    const searchCall = mockFetchPage.mock.calls.find((c) => c[0].includes('/works/search'))!
    const searchUrl = decodeURIComponent(searchCall[0]).replace(/\+/g, ' ')
    // the CANONICAL name (not the FFN abbreviation) fills the named field
    expect(searchUrl).toContain('work_search[relationship_names]=Fleur Delacour/Harry Potter')
    expect(out.map((c) => c.title)).toEqual(['First Fic', 'Second Fic'])
  })

  it('ao3Source.fetch returns [] for a library with no fanfic tags', async () => {
    const id = seedItem(db, { author: 'Owner' })
    const out = await ao3Source.fetch([{ id, weight: 1 }])
    expect(out).toEqual([])
    expect(mockFetchPage).not.toHaveBeenCalled()
  })
})
