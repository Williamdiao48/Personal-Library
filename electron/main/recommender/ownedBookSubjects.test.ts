import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { okJson, notOk } from '../../../test/stubs/httpResponse'
import { openTestDb, closeTestDb } from '../../../test/db/harness'
import {
  ownedBookQuery,
  extractSubjects,
  resolveOwnedBookSubjects,
  type OwnedBook,
} from './ownedBookSubjects'

// The resolver's parse helpers are pure; resolveOwnedBookSubjects touches the global
// fetch (mocked) + candidate_cache (Node ABI via the in-memory test DB).

describe('ownedBookQuery (pure)', () => {
  it('anchors on title and narrows by author when present', () => {
    expect(ownedBookQuery('The Left Hand of Darkness', 'Ursula K. Le Guin')).toBe(
      'The Left Hand of Darkness author:"Ursula K. Le Guin"',
    )
  })

  it('drops the author clause when there is no author, and strips quotes', () => {
    expect(ownedBookQuery('A "Great" Book', null)).toBe('A Great Book')
  })
})

describe('extractSubjects (pure)', () => {
  it('trims, drops blanks, and caps to the limit', () => {
    expect(extractSubjects({ subject: [' Fantasy ', '', 'Adventure', 'War'] }, 2)).toEqual([
      'Fantasy',
      'Adventure',
    ])
  })

  it('returns [] for a missing doc or subject-less doc', () => {
    expect(extractSubjects(undefined, 8)).toEqual([])
    expect(extractSubjects({ title: 'x' }, 8)).toEqual([])
  })
})

describe('resolveOwnedBookSubjects', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const book = (over: Partial<OwnedBook> = {}): OwnedBook => ({
    id: 'i1',
    title: 'The Left Hand of Darkness',
    author: 'Ursula K. Le Guin',
    ...over,
  })

  beforeEach(() => {
    openTestDb()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    closeTestDb()
  })

  it('returns an empty map (and never fetches) for no books', async () => {
    const out = await resolveOwnedBookSubjects([])
    expect(out.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("resolves a book's OpenLibrary subjects and keys them by item id", async () => {
    fetchMock.mockResolvedValue(
      okJson({ docs: [{ key: '/works/OL1W', subject: ['Science Fiction', 'Gender'] }] }),
    )
    const out = await resolveOwnedBookSubjects([book()])
    expect(out.get('i1')).toEqual(['Science Fiction', 'Gender'])
  })

  it('is cache-first — a second resolve of the same book does not re-fetch', async () => {
    fetchMock.mockResolvedValue(okJson({ docs: [{ subject: ['Fantasy'] }] }))
    await resolveOwnedBookSubjects([book()])
    await resolveOwnedBookSubjects([book()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caches an empty result so a subject-less book is not re-fetched', async () => {
    fetchMock.mockResolvedValue(okJson({ docs: [{ key: '/works/OL9W' }] }))
    expect((await resolveOwnedBookSubjects([book()])).get('i1')).toEqual([])
    await resolveOwnedBookSubjects([book()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('degrades to [] on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(notOk(503))
    expect((await resolveOwnedBookSubjects([book()])).get('i1')).toEqual([])
  })

  it('degrades to [] when the fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    expect((await resolveOwnedBookSubjects([book()])).get('i1')).toEqual([])
  })
})
