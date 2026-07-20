import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// openLibrarySource's impure edges are fetchCandidates (network, in candidates.ts)
// and resolveOwnedBookSubjects (cache-first network). Mock both and drive the real
// DB join (loadSeedSources) + real query building (buildSeedQueries) against an
// in-memory DB (Node ABI).
vi.mock('../candidates', () => ({
  fetchCandidates: vi.fn(async () => [] as unknown[]),
  CANDIDATES: { CACHE_TTL_MS: 1000, SOFT_FLOOR_MS: 60, DESCRIPTION_CONCURRENCY: 4 },
}))
vi.mock('../ownedBookSubjects', () => ({
  resolveOwnedBookSubjects: vi.fn(async () => new Map<string, string[]>()),
}))

import {
  openTestDb,
  closeTestDb,
  seedItem,
  seedTag,
  tagItem,
  type TestDb,
} from '../../../../test/db/harness'
import { fetchCandidates, CANDIDATES } from '../candidates'
import { resolveOwnedBookSubjects } from '../ownedBookSubjects'
import { openLibrarySource, prewarmBooks } from './openLibrary'

const mockFetch = vi.mocked(fetchCandidates)
const mockSubjects = vi.mocked(resolveOwnedBookSubjects)

/** Seed a book item (non-fic source_url so it counts as a book) with an optional tag. */
function seedBook(db: TestDb, over: { author?: string | null; tag?: string } = {}): string {
  const id = seedItem(db, { author: over.author ?? 'Ursula K. Le Guin', source_url: null })
  if (over.tag) tagItem(db, id, seedTag(db, over.tag))
  return id
}

describe('openLibrarySource', () => {
  let db: TestDb
  beforeEach(() => {
    db = openTestDb()
    mockFetch.mockReset().mockResolvedValue([])
    mockSubjects.mockReset().mockResolvedValue(new Map())
  })
  afterEach(() => closeTestDb())

  it('returns [] without fetching when there are no liked items', async () => {
    expect(await openLibrarySource.fetch([])).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns [] when a liked item yields no seed terms (no author, no tags)', async () => {
    const id = seedItem(db, { author: null, source_url: null })
    expect(await openLibrarySource.fetch([{ id, weight: 1 }])).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("builds subject: + author: queries from the item's tags and author", async () => {
    const id = seedBook(db, { author: 'Ursula K. Le Guin', tag: 'Fantasy' })
    const out = [{ title: 'A Wizard of Earthsea' }]
    mockFetch.mockResolvedValue(out as never)

    const result = await openLibrarySource.fetch([{ id, weight: 1 }])

    expect(result).toBe(out) // passes fetchCandidates' result straight through
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const queries = mockFetch.mock.calls[0][0] as { q: string }[]
    const qs = queries.map((q) => q.q)
    expect(qs).toContain('subject:"Fantasy"')
    expect(qs).toContain('author:"Ursula K. Le Guin"')
  })

  it('folds resolved OpenLibrary subjects into the subject: seeds', async () => {
    const id = seedBook(db, { tag: 'Fantasy' })
    mockSubjects.mockResolvedValue(new Map([[id, ['Science Fiction']]]))

    await openLibrarySource.fetch([{ id, weight: 1 }])
    const queries = mockFetch.mock.calls[0][0] as { q: string }[]
    expect(queries.map((q) => q.q)).toContain('subject:"Science Fiction"')
  })

  it('a fresh Refresh tightens the search cache TTL to the soft floor', async () => {
    const id = seedBook(db, { tag: 'Fantasy' })
    await openLibrarySource.fetch([{ id, weight: 1 }], { fresh: true })
    const opts = mockFetch.mock.calls[0][1] as { cfg: { CACHE_TTL_MS: number } }
    expect(opts.cfg.CACHE_TTL_MS).toBe(CANDIDATES.SOFT_FLOOR_MS)
  })

  it('leaves the default cache TTL untouched when not fresh', async () => {
    const id = seedBook(db, { tag: 'Fantasy' })
    await openLibrarySource.fetch([{ id, weight: 1 }])
    const opts = mockFetch.mock.calls[0][1] as { cfg: { CACHE_TTL_MS: number } }
    expect(opts.cfg.CACHE_TTL_MS).toBe(CANDIDATES.CACHE_TTL_MS)
  })

  it('passes the page window through to fetchCandidates', async () => {
    const id = seedBook(db, { tag: 'Fantasy' })
    await openLibrarySource.fetch([{ id, weight: 1 }], { page: 2 })
    const opts = mockFetch.mock.calls[0][1] as { page?: number }
    expect(opts.page).toBe(2)
  })
})

describe('prewarmBooks', () => {
  let db: TestDb
  beforeEach(() => {
    db = openTestDb()
    mockFetch.mockReset().mockResolvedValue([])
    mockSubjects.mockReset().mockResolvedValue(new Map())
  })
  afterEach(() => closeTestDb())

  it('returns 0 without fetching when there are no seed queries', async () => {
    expect(await prewarmBooks([])).toBe(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('fetches at the gentler prewarm description concurrency and returns the pool size', async () => {
    const id = seedBook(db, { tag: 'Fantasy' })
    mockFetch.mockResolvedValue([{ title: 'A' }, { title: 'B' }, { title: 'C' }] as never)

    const n = await prewarmBooks([{ id, weight: 1 }])

    expect(n).toBe(3)
    const opts = mockFetch.mock.calls[0][1] as { cfg: { DESCRIPTION_CONCURRENCY: number } }
    expect(opts.cfg.DESCRIPTION_CONCURRENCY).toBe(2) // PREWARM_DESCRIPTION_CONCURRENCY
  })
})
