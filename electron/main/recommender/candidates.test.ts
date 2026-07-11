import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { okJson, notOk, type FakeResponse } from '../../../test/stubs/httpResponse'
import { openTestDb, closeTestDb, type TestDb } from '../../../test/db/harness'
import {
  normalizeOpenLibraryDoc,
  coverUrlFromId,
  fetchCandidates,
  extractOlDescription,
  cleanOlDescription,
  CANDIDATES,
  type OpenLibraryDoc,
  type CandidatesConfig,
} from './candidates'
import type { SeedQuery } from './seedQueries'

// The normalizer is pure; fetchCandidates touches candidate_cache (openTestDb,
// Node ABI) and the global fetch (stubbed).

const doc = (over: Partial<OpenLibraryDoc> = {}): OpenLibraryDoc => ({
  key: '/works/OL1W',
  title: 'A Book',
  author_name: ['An Author'],
  subject: ['Fantasy'],
  cover_i: 42,
  isbn: ['9780000000001'],
  ...over,
})

const query = (q: string, over: Partial<SeedQuery> = {}): SeedQuery => ({
  kind: 'subject',
  term: q,
  q,
  weight: 1,
  ...over,
})

describe('coverUrlFromId', () => {
  it('builds a cover URL from a numeric id', () => {
    expect(coverUrlFromId(42)).toBe('https://covers.openlibrary.org/b/id/42-M.jpg')
  })
  it('returns null when there is no cover id', () => {
    expect(coverUrlFromId(undefined)).toBeNull()
  })
})

describe('normalizeOpenLibraryDoc', () => {
  it('maps a full doc to a Candidate', () => {
    expect(normalizeOpenLibraryDoc(doc())).toEqual({
      title: 'A Book',
      author: 'An Author',
      subjects: ['Fantasy'],
      coverUrl: 'https://covers.openlibrary.org/b/id/42-M.jpg',
      sourceId: '/works/OL1W',
      isbn: '9780000000001',
      description: null, // search.json has no blurb — books stay metadata-only
      source: 'book',
    })
  })

  it('drops a doc with no usable title', () => {
    expect(normalizeOpenLibraryDoc(doc({ title: '   ' }))).toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ title: undefined }))).toBeNull()
  })

  it('tolerates every optional field being absent', () => {
    const c = normalizeOpenLibraryDoc({ title: 'Bare' })
    expect(c).toMatchObject({
      title: 'Bare',
      author: null,
      subjects: [],
      coverUrl: null,
      isbn: null,
      description: null,
    })
  })

  it('caps subjects and trims/drops blanks', () => {
    const many = Array.from({ length: CANDIDATES.MAX_SUBJECTS_PER_DOC + 5 }, (_, i) => `s${i}`)
    const c = normalizeOpenLibraryDoc(doc({ subject: ['  Fantasy  ', '', ...many] }))!
    expect(c.subjects).toHaveLength(CANDIDATES.MAX_SUBJECTS_PER_DOC)
    expect(c.subjects[0]).toBe('Fantasy') // trimmed, blank dropped
  })

  it('takes the first author and first isbn', () => {
    const c = normalizeOpenLibraryDoc(
      doc({ author_name: ['First', 'Second'], isbn: ['i1', 'i2'] }),
    )!
    expect(c.author).toBe('First')
    expect(c.isbn).toBe('i1')
  })

  it('synthesizes a sourceId when the work key is missing', () => {
    const c = normalizeOpenLibraryDoc(
      doc({ key: undefined, title: 'Dune', author_name: ['Herbert'] }),
    )!
    expect(c.sourceId).toBe('synthetic:dune|herbert')
  })
})

describe('extractOlDescription', () => {
  it('reads a plain-string description', () => {
    expect(extractOlDescription({ description: 'A lonely lighthouse keeper.' })).toBe(
      'A lonely lighthouse keeper.',
    )
  })
  it('reads a { type, value } description', () => {
    expect(
      extractOlDescription({ description: { type: '/type/text', value: 'Rival chefs collide.' } }),
    ).toBe('Rival chefs collide.')
  })
  it('returns null when the work carries no description', () => {
    expect(extractOlDescription({})).toBeNull()
    expect(extractOlDescription(null)).toBeNull()
    expect(extractOlDescription({ description: { type: '/type/text' } })).toBeNull()
  })
})

describe('cleanOlDescription', () => {
  it('strips the trailing source-attribution block and collapses whitespace', () => {
    const raw = 'A sweeping saga.\r\n\r\n----------\r\n\r\n[1]: https://en.wikipedia.org/wiki/Book'
    expect(cleanOlDescription(raw)).toBe('A sweeping saga.')
  })
  it('drops leftover markdown link-definition lines', () => {
    expect(cleanOlDescription('Line one.\n[source]: http://example.com/x')).toBe('Line one.')
  })
  it('returns null for empty / whitespace-only / missing input', () => {
    expect(cleanOlDescription('   ')).toBeNull()
    expect(cleanOlDescription(null)).toBeNull()
    expect(cleanOlDescription(undefined)).toBeNull()
  })
})

describe('fetchCandidates', () => {
  let db: TestDb
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    db = openTestDb()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    closeTestDb()
  })

  // The N+1 means a refresh now issues BOTH search.json calls and per-work
  // `/works/<key>.json` calls, so we route the stubbed fetch by URL: search calls
  // are served from a queue (in query order, as before), works calls by work key.
  function stubFetch(searchQueue: FakeResponse[], works: (key: string) => FakeResponse): void {
    const queue = [...searchQueue]
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url)
      if (u.includes('/search.json')) return queue.shift() ?? okJson({ docs: [] })
      const m = u.match(/(\/works\/[^.]+)\.json/)
      return works(m ? m[1] : '/works/?')
    })
  }

  const noDescriptions = (): FakeResponse => notOk(404)
  const searchCalls = (): unknown[] =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes('/search.json'))
  const worksCalls = (key: string): unknown[] =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes(`${key}.json`))

  it('normalizes, dedups by sourceId across queries, and drops title-less docs', async () => {
    stubFetch(
      [
        okJson({ docs: [doc({ key: '/works/A' }), doc({ title: undefined })] }),
        okJson({ docs: [doc({ key: '/works/A' }), doc({ key: '/works/B' })] }),
      ],
      noDescriptions,
    )
    const out = await fetchCandidates([query('subject:"X"'), query('subject:"Y"')])
    expect(out.map((c) => c.sourceId)).toEqual(['/works/A', '/works/B'])
  })

  it('caps the merged set at MAX_CANDIDATES', async () => {
    const cfg: CandidatesConfig = { ...CANDIDATES, MAX_CANDIDATES: 2 }
    stubFetch(
      [
        okJson({
          docs: [doc({ key: '/works/A' }), doc({ key: '/works/B' }), doc({ key: '/works/C' })],
        }),
      ],
      noDescriptions,
    )
    const out = await fetchCandidates([query('subject:"X"')], { cfg })
    expect(out).toHaveLength(2)
  })

  it('soft-fails a non-2xx query without sinking the batch', async () => {
    stubFetch([notOk(500), okJson({ docs: [doc({ key: '/works/B' })] })], noDescriptions)
    const out = await fetchCandidates([query('subject:"bad"'), query('subject:"good"')])
    expect(out.map((c) => c.sourceId)).toEqual(['/works/B'])
  })

  it('serves a search cache hit without re-fetching', async () => {
    stubFetch([okJson({ docs: [doc({ key: '/works/A' })] })], noDescriptions)
    const now = 1_000_000
    await fetchCandidates([query('subject:"X"')], { now })
    const out = await fetchCandidates([query('subject:"X"')], { now: now + 1000 })
    expect(searchCalls()).toHaveLength(1)
    expect(out.map((c) => c.sourceId)).toEqual(['/works/A'])
  })

  it('re-fetches search once the cache entry is older than the TTL', async () => {
    stubFetch(
      [okJson({ docs: [doc({ key: '/works/A' })] }), okJson({ docs: [doc({ key: '/works/A' })] })],
      noDescriptions,
    )
    const now = 1_000_000
    await fetchCandidates([query('subject:"X"')], { now })
    await fetchCandidates([query('subject:"X"')], { now: now + CANDIDATES.CACHE_TTL_MS + 1 })
    expect(searchCalls()).toHaveLength(2)
  })

  // ── book descriptions (the OpenLibrary N+1) ───────────────────────────────────

  it('enriches each book candidate with its work description and caches it per-work', async () => {
    stubFetch([okJson({ docs: [doc({ key: '/works/A' })] })], (key) =>
      key === '/works/A' ? okJson({ description: 'A haunted lighthouse.' }) : notOk(404),
    )
    const now = 2_000_000
    const out = await fetchCandidates([query('subject:"X"')], { now })
    expect(out[0].description).toBe('A haunted lighthouse.')

    // Second refresh: the description is served from the oldesc: cache (no re-fetch).
    await fetchCandidates([query('subject:"X"')], { now: now + 1000 })
    expect(worksCalls('/works/A')).toHaveLength(1)
    const row = db
      .prepare(`SELECT query_key FROM candidate_cache WHERE query_key = 'oldesc:/works/A'`)
      .get()
    expect(row).toBeTruthy()
  })

  it('caches a null description so a blurb-less work is not re-fetched', async () => {
    stubFetch([okJson({ docs: [doc({ key: '/works/A' })] })], () => okJson({})) // work has no blurb
    const now = 3_000_000
    const out = await fetchCandidates([query('subject:"X"')], { now })
    expect(out[0].description).toBeNull()
    await fetchCandidates([query('subject:"X"')], { now: now + 1000 })
    expect(worksCalls('/works/A')).toHaveLength(1)
  })

  it('degrades to a null description when the work fetch fails, keeping the candidate', async () => {
    stubFetch([okJson({ docs: [doc({ key: '/works/A' })] })], () => notOk(500))
    const out = await fetchCandidates([query('subject:"X"')], { now: 4_000_000 })
    expect(out.map((c) => c.sourceId)).toEqual(['/works/A'])
    expect(out[0].description).toBeNull()
  })

  it('skips the works fetch for a synthetic (keyless) candidate', async () => {
    stubFetch(
      [okJson({ docs: [doc({ key: undefined, title: 'Bare', author_name: ['X'] })] })],
      () => okJson({ description: 'should never be fetched' }),
    )
    const out = await fetchCandidates([query('subject:"X"')], { now: 5_000_000 })
    expect(out[0].sourceId).toBe('synthetic:bare|x')
    expect(out[0].description).toBeNull()
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/works/'))).toHaveLength(0)
  })
})
