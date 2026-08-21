import { describe, it, expect, vi, beforeEach } from 'vitest'

// bulkImport touches the DB only through db.all (owned-id lookup) and the two site
// discoverers. Mock all three so the validation + dedup + annotation logic runs
// offline and ABI-free (no better-sqlite3 load).
vi.mock('../db', () => ({ all: vi.fn(() => []) }))
vi.mock('./sites/ao3-bookmarks', () => ({ discoverAo3Bookmarks: vi.fn() }))
vi.mock('./sites/ffnet-favorites', () => ({ discoverFfnetFavorites: vi.fn() }))

import { canonicalWorkId, normalizeAccountRef, discoverFavorites } from './bulkImport'
import { all } from '../db'
import { discoverAo3Bookmarks } from './sites/ao3-bookmarks'
import { discoverFfnetFavorites } from './sites/ffnet-favorites'

const mockAll = vi.mocked(all)
const mockAo3 = vi.mocked(discoverAo3Bookmarks)
const mockFfn = vi.mocked(discoverFfnetFavorites)

/** Seed the owned-id DB lookup with the given source_urls. */
function owned(...urls: string[]): void {
  mockAll.mockReturnValue(urls.map((source_url) => ({ source_url })))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAll.mockReturnValue([]) // empty library by default
})

describe('canonicalWorkId', () => {
  it('reduces AO3 work URLs (query / chapter / scheme variants) to one id', () => {
    for (const url of [
      'https://archiveofourown.org/works/123',
      'https://archiveofourown.org/works/123?view_full_work=true',
      'https://archiveofourown.org/works/123/chapters/456',
      'http://archiveofourown.org/works/123',
    ]) {
      expect(canonicalWorkId(url)).toEqual({ kind: 'ao3', id: '123' })
    }
  })

  it('reduces FFN story URLs (with/without chapter+slug) to one id', () => {
    expect(canonicalWorkId('https://www.fanfiction.net/s/999/1/My-Slug')).toEqual({
      kind: 'ffn',
      id: '999',
    })
    expect(canonicalWorkId('https://www.fanfiction.net/s/999')).toEqual({ kind: 'ffn', id: '999' })
  })

  it('returns null for non-work URLs and cross-host mismatches', () => {
    expect(canonicalWorkId('https://example.com/works/1')).toBeNull() // /works/ but not AO3
    expect(canonicalWorkId('https://archiveofourown.org/users/x/bookmarks')).toBeNull()
    expect(canonicalWorkId('not a url')).toBeNull()
  })
})

describe('normalizeAccountRef', () => {
  it('accepts a bare AO3 username and extracts one from a profile URL', () => {
    expect(normalizeAccountRef('ao3', 'Some_User1')).toBe('Some_User1')
    expect(
      normalizeAccountRef('ao3', 'https://archiveofourown.org/users/Some_User1/bookmarks'),
    ).toBe('Some_User1')
  })

  it('accepts a bare FFN id and extracts one from a profile URL', () => {
    expect(normalizeAccountRef('ffn', '12345')).toBe('12345')
    expect(normalizeAccountRef('ffn', 'https://www.fanfiction.net/u/12345/Some-Name')).toBe('12345')
  })

  it('rejects refs that could inject path segments or are otherwise invalid', () => {
    expect(() => normalizeAccountRef('ao3', '../../etc')).toThrow(/valid AO3 username/)
    expect(() => normalizeAccountRef('ao3', 'has space')).toThrow(/valid AO3 username/)
    expect(() => normalizeAccountRef('ao3', '')).toThrow(/Enter an account reference/)
    expect(() => normalizeAccountRef('ffn', 'abc')).toThrow(/valid FanFiction/)
    expect(() => normalizeAccountRef('ffn', '12/../3')).toThrow(/valid FanFiction/)
  })
})

describe('discoverFavorites — AO3', () => {
  it('validates the ref, dispatches to the AO3 discoverer, and passes counts through', async () => {
    mockAo3.mockResolvedValue({
      works: [
        { url: 'https://archiveofourown.org/works/1', title: 'One', author: 'A' },
        { url: 'https://archiveofourown.org/works/2', title: 'Two', author: null },
      ],
      skippedSeries: 3,
      skippedExternal: 1,
      pagesFetched: 1,
    })

    const res = await discoverFavorites('ao3', 'https://archiveofourown.org/users/reader/bookmarks')

    expect(mockAo3).toHaveBeenCalledWith('reader', undefined)
    expect(res.ref).toBe('reader') // normalized out of the pasted URL
    expect(res.total).toBe(2)
    expect(res.skippedSeries).toBe(3)
    expect(res.skippedExternal).toBe(1)
    expect(res.alreadyInLibrary).toBe(0)
  })

  it('flags works already in the library by canonical id (ignoring URL variants)', async () => {
    // Library owns work 1 under a chapter-URL variant — must still match /works/1.
    owned('https://archiveofourown.org/works/1/chapters/99')
    mockAo3.mockResolvedValue({
      works: [
        {
          url: 'https://archiveofourown.org/works/1?view_full_work=true',
          title: 'Owned',
          author: null,
        },
        { url: 'https://archiveofourown.org/works/2', title: 'New', author: null },
      ],
      skippedSeries: 0,
      skippedExternal: 0,
      pagesFetched: 1,
    })

    const res = await discoverFavorites('ao3', 'reader')

    expect(res.alreadyInLibrary).toBe(1)
    expect(res.works.find((w) => w.title === 'Owned')?.alreadyInLibrary).toBe(true)
    expect(res.works.find((w) => w.title === 'New')?.alreadyInLibrary).toBe(false)
  })

  it('de-duplicates the same work appearing twice within one batch', async () => {
    mockAo3.mockResolvedValue({
      works: [
        { url: 'https://archiveofourown.org/works/5', title: 'Dup A', author: null },
        { url: 'https://archiveofourown.org/works/5/chapters/1', title: 'Dup B', author: null },
        { url: 'https://archiveofourown.org/works/6', title: 'Unique', author: null },
      ],
      skippedSeries: 0,
      skippedExternal: 0,
      pagesFetched: 1,
    })

    const res = await discoverFavorites('ao3', 'reader')

    expect(res.total).toBe(2) // works 5 (first-seen) + 6
    expect(res.works.map((w) => w.title)).toEqual(['Dup A', 'Unique'])
  })

  it('rejects an invalid ref before any network call', async () => {
    await expect(discoverFavorites('ao3', '!!bad!!')).rejects.toThrow(/valid AO3 username/)
    expect(mockAo3).not.toHaveBeenCalled()
  })
})

describe('discoverFavorites — FFN', () => {
  it('dispatches to the FFN discoverer and reports a single-page progress tick', async () => {
    mockFfn.mockResolvedValue([
      { url: 'https://www.fanfiction.net/s/1/1/x', title: 'Fic', author: 'W', fandom: 'HP' },
    ])
    const onProgress = vi.fn()

    const res = await discoverFavorites('ffn', 'https://www.fanfiction.net/u/42/Name', onProgress)

    expect(mockFfn).toHaveBeenCalledWith('42')
    expect(res.ref).toBe('42')
    expect(res.total).toBe(1)
    expect(res.skippedSeries).toBe(0)
    expect(res.skippedExternal).toBe(0)
    expect(onProgress).toHaveBeenCalledWith(1, 1, 1)
  })
})
