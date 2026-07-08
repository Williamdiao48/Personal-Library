import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { okJson, notOk } from '../../../test/stubs/httpResponse'
import { openTestDb, closeTestDb } from '../../../test/db/harness'
import {
  normalizeOpenLibraryDoc,
  coverUrlFromId,
  fetchCandidates,
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

describe('fetchCandidates', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    openTestDb()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    closeTestDb()
  })

  it('normalizes, dedups by sourceId across queries, and drops title-less docs', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okJson({ docs: [doc({ key: '/works/A' }), doc({ title: undefined })] }),
      )
      .mockResolvedValueOnce(okJson({ docs: [doc({ key: '/works/A' }), doc({ key: '/works/B' })] }))
    const out = await fetchCandidates([query('subject:"X"'), query('subject:"Y"')])
    expect(out.map((c) => c.sourceId)).toEqual(['/works/A', '/works/B'])
  })

  it('caps the merged set at MAX_CANDIDATES', async () => {
    const cfg: CandidatesConfig = { ...CANDIDATES, MAX_CANDIDATES: 2 }
    fetchMock.mockResolvedValue(
      okJson({
        docs: [doc({ key: '/works/A' }), doc({ key: '/works/B' }), doc({ key: '/works/C' })],
      }),
    )
    const out = await fetchCandidates([query('subject:"X"')], { cfg })
    expect(out).toHaveLength(2)
  })

  it('soft-fails a non-2xx query without sinking the batch', async () => {
    fetchMock
      .mockResolvedValueOnce(notOk(500))
      .mockResolvedValueOnce(okJson({ docs: [doc({ key: '/works/B' })] }))
    const out = await fetchCandidates([query('subject:"bad"'), query('subject:"good"')])
    expect(out.map((c) => c.sourceId)).toEqual(['/works/B'])
  })

  it('serves a cache hit without re-fetching', async () => {
    fetchMock.mockResolvedValue(okJson({ docs: [doc({ key: '/works/A' })] }))
    const now = 1_000_000
    await fetchCandidates([query('subject:"X"')], { now })
    const out = await fetchCandidates([query('subject:"X"')], { now: now + 1000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out.map((c) => c.sourceId)).toEqual(['/works/A'])
  })

  it('re-fetches once the cache entry is older than the TTL', async () => {
    fetchMock.mockResolvedValue(okJson({ docs: [doc({ key: '/works/A' })] }))
    const now = 1_000_000
    await fetchCandidates([query('subject:"X"')], { now })
    await fetchCandidates([query('subject:"X"')], { now: now + CANDIDATES.CACHE_TTL_MS + 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
