import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The AO3 source's only impure edges are fetchPage (network) + candidate_cache
// (DB). Mock fetchPage and drive the real query building / blurb parsing / dedup /
// cache against an in-memory DB (Node ABI). buildAo3Queries + parseAo3* are pure.
vi.mock('../../capture/fetch', () => ({ fetchPage: vi.fn() }))

import { JSDOM } from 'jsdom'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../../test/db/harness'
import { fetchPage } from '../../capture/fetch'
import {
  buildAo3Queries,
  parseAo3ResultsPage,
  parseAo3Blurb,
  fetchAo3Candidates,
  ao3Source,
  AO3_SOURCE,
  type Ao3Query,
} from './ao3'
import type { TasteSeeds } from '../tasteSeeds'

const mockFetchPage = vi.mocked(fetchPage)

const emptySeeds = (): TasteSeeds => ({
  authors: [],
  fandoms: [],
  relationships: [],
  characters: [],
  freeforms: [],
  genres: [],
})

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

// ── buildAo3Queries (pure) ────────────────────────────────────────────────────
describe('buildAo3Queries', () => {
  it('anchors one query per top fandom, folding in the top relationship/freeform terms', () => {
    const seeds: TasteSeeds = {
      ...emptySeeds(),
      fandoms: [
        { term: 'Harry Potter', weight: 3 },
        { term: 'Naruto', weight: 1 },
      ],
      relationships: [{ term: 'Enemies to Lovers', weight: 2 }],
      freeforms: [{ term: 'Slow Burn', weight: 1 }],
    }
    const qs = buildAo3Queries(seeds)
    expect(qs.map((q) => q.term)).toEqual(['Harry Potter', 'Naruto'])
    // URLSearchParams encodes spaces as '+' (form-encoding); normalize to check terms.
    const q0 = decodeURIComponent(qs[0].url).replace(/\+/g, ' ')
    expect(q0).toContain('"Harry Potter"')
    expect(q0).toContain('"Enemies to Lovers"') // top extra folded in
    expect(q0).toContain('"Slow Burn"')
    expect(qs[0].url).toContain('sort_column')
  })

  it('falls back to a single freeform query with no fandoms, and returns [] with nothing', () => {
    const noFandom: TasteSeeds = { ...emptySeeds(), freeforms: [{ term: 'Fluff', weight: 1 }] }
    expect(buildAo3Queries(noFandom)).toHaveLength(1)
    expect(buildAo3Queries(emptySeeds())).toEqual([])
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
  const query = (url: string): Ao3Query => ({ term: 't', url, weight: 1 })

  beforeEach(() => {
    db = openTestDb()
    mockFetchPage.mockReset()
  })
  afterEach(() => closeTestDb())

  it('fetches + parses + dedups, then serves a cache hit without re-fetching', async () => {
    mockFetchPage.mockResolvedValue(RESULTS_HTML)
    const q = query('https://archiveofourown.org/works/search?work_search%5Bquery%5D=x')

    const out = await fetchAo3Candidates([q], { now: 1000 })
    expect(out.map((c) => c.sourceId)).toEqual([
      'https://archiveofourown.org/works/111',
      'https://archiveofourown.org/works/222',
    ])

    const cached = await fetchAo3Candidates([q], { now: 2000 }) // within TTL
    expect(mockFetchPage).toHaveBeenCalledTimes(1)
    expect(cached.map((c) => c.title)).toEqual(['First Fic', 'Second Fic'])
  })

  it('re-fetches once the cache entry is older than the TTL', async () => {
    mockFetchPage.mockResolvedValue(RESULTS_HTML)
    const q = query('https://archiveofourown.org/works/search?work_search%5Bquery%5D=y')
    await fetchAo3Candidates([q], { now: 1000 })
    await fetchAo3Candidates([q], { now: 1000 + AO3_SOURCE.CACHE_TTL_MS + 1 })
    expect(mockFetchPage).toHaveBeenCalledTimes(2)
  })

  it('soft-fails a query whose fetch throws, without sinking the batch', async () => {
    mockFetchPage.mockRejectedValue(new Error('network down'))
    expect(
      await fetchAo3Candidates([query('https://archiveofourown.org/works/search?q=z')]),
    ).toEqual([])
  })

  it('ao3Source.fetch builds fandom-anchored queries from the liked items and returns fics', async () => {
    const id = seedItem(db, { author: 'Owner' })
    db.prepare(
      `INSERT INTO item_source_tags (item_id, name, category) VALUES (?, 'Harry Potter', 'fandom')`,
    ).run(id)
    mockFetchPage.mockResolvedValue(RESULTS_HTML)

    const out = await ao3Source.fetch([{ id, weight: 1 }])
    expect(mockFetchPage).toHaveBeenCalledTimes(1)
    expect(out.map((c) => c.title)).toEqual(['First Fic', 'Second Fic'])
    expect(out.every((c) => c.source === 'ao3')).toBe(true)
  })

  it('ao3Source.fetch returns [] for a library with no fanfic tags', async () => {
    const id = seedItem(db, { author: 'Owner' }) // no source tags
    const out = await ao3Source.fetch([{ id, weight: 1 }])
    expect(out).toEqual([])
    expect(mockFetchPage).not.toHaveBeenCalled()
  })
})
