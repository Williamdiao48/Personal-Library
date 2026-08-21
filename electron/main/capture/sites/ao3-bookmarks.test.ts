import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// discoverAo3Bookmarks couples only to fetch.ts (fetchPage per bookmark page).
// Mock it and feed AO3-shaped bookmark HTML so the pagination walk + parse run
// offline. parseAo3BookmarksPage itself is pure and tested directly.
vi.mock('../fetch', () => ({ fetchPage: vi.fn() }))

import { parseAo3BookmarksPage, discoverAo3Bookmarks } from './ao3-bookmarks'
import { fetchPage } from '../fetch'

const mockFetch = vi.mocked(fetchPage)

// Real AO3 markup uses SINGLE-QUOTED class attrs — the fixtures mirror that (a DOM
// parser normalizes it; the point is to exercise the real selector shapes).
function bookmark(opts: {
  href: string
  title?: string
  author?: string | null // omit / null → no author anchor (anonymous work)
}): string {
  const { href, title = 'A Work', author = 'Writer' } = opts
  return `<li id='bookmark_1' class='bookmark blurb group work-123 user-x' role='article'>
    <div class='header module'>
      <h4 class='heading'>
        <a href='${href}'>${title}</a>
        ${author != null ? `by <a rel='author' href='/users/writer'>${author}</a>` : ''}
      </h4>
    </div>
  </li>`
}

function bookmarksPage(items: string[], pages = 1): string {
  const pagination =
    pages > 1
      ? `<ol class='pagination actions' role='navigation'>
           ${Array.from({ length: pages }, (_, i) => `<li><a href='/users/x/bookmarks?page=${i + 1}'>${i + 1}</a></li>`).join('')}
           <li class='next'><a rel='next' href='/users/x/bookmarks?page=2'>Next</a></li>
         </ol>`
      : ''
  return `<html><body><ol class='bookmark index group'>${items.join('')}</ol>${pagination}</body></html>`
}

describe('parseAo3BookmarksPage', () => {
  it('extracts work bookmarks with title + author and a canonical work URL', () => {
    const html = bookmarksPage([
      bookmark({ href: '/works/123', title: 'First Work', author: 'Alice' }),
      bookmark({ href: '/works/456?some=query', title: 'Second Work', author: 'Bob' }),
    ])
    const { works, maxPage, skippedSeries, skippedExternal } = parseAo3BookmarksPage(html)
    expect(works).toEqual([
      { url: 'https://archiveofourown.org/works/123', title: 'First Work', author: 'Alice' },
      { url: 'https://archiveofourown.org/works/456', title: 'Second Work', author: 'Bob' },
    ])
    expect(maxPage).toBe(1)
    expect(skippedSeries).toBe(0)
    expect(skippedExternal).toBe(0)
  })

  it('yields null author for an anonymous/orphaned work (no author anchor)', () => {
    const { works } = parseAo3BookmarksPage(
      bookmarksPage([bookmark({ href: '/works/9', author: null })]),
    )
    expect(works).toHaveLength(1)
    expect(works[0].author).toBeNull()
  })

  it('filters out series and external bookmarks, counting each', () => {
    const html = bookmarksPage([
      bookmark({ href: '/works/1', title: 'Keep me' }),
      bookmark({ href: '/series/77', title: 'A Series' }),
      bookmark({ href: 'https://example.com/fic', title: 'Off-site' }),
    ])
    const { works, skippedSeries, skippedExternal } = parseAo3BookmarksPage(html)
    expect(works.map((w) => w.url)).toEqual(['https://archiveofourown.org/works/1'])
    expect(skippedSeries).toBe(1)
    expect(skippedExternal).toBe(1)
  })

  it('reads the highest page number from the pagination control', () => {
    const html = bookmarksPage([bookmark({ href: '/works/1' })], 4)
    expect(parseAo3BookmarksPage(html).maxPage).toBe(4)
  })

  it('returns an empty result for a page with no bookmarks', () => {
    expect(parseAo3BookmarksPage('<html><body></body></html>')).toEqual({
      works: [],
      maxPage: 1,
      skippedSeries: 0,
      skippedExternal: 0,
    })
  })
})

describe('discoverAo3Bookmarks', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('walks every page and concatenates works, aggregating skip counts', async () => {
    mockFetch
      .mockResolvedValueOnce(
        bookmarksPage(
          [bookmark({ href: '/works/1', title: 'One' }), bookmark({ href: '/series/9' })],
          2,
        ),
      )
      .mockResolvedValueOnce(
        bookmarksPage(
          [bookmark({ href: '/works/2', title: 'Two' }), bookmark({ href: 'https://ext.com/x' })],
          2,
        ),
      )

    const promise = discoverAo3Bookmarks('someuser')
    await vi.runAllTimersAsync()
    const result = await promise

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://archiveofourown.org/users/someuser/bookmarks?page=1',
    )
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://archiveofourown.org/users/someuser/bookmarks?page=2',
    )
    expect(result.works.map((w) => w.title)).toEqual(['One', 'Two'])
    expect(result.skippedSeries).toBe(1)
    expect(result.skippedExternal).toBe(1)
    expect(result.pagesFetched).toBe(2)
  })

  it('reports progress per page via the onPage callback', async () => {
    mockFetch
      .mockResolvedValueOnce(bookmarksPage([bookmark({ href: '/works/1' })], 2))
      .mockResolvedValueOnce(bookmarksPage([bookmark({ href: '/works/2' })], 2))
    const onPage = vi.fn()

    const promise = discoverAo3Bookmarks('u', onPage)
    await vi.runAllTimersAsync()
    await promise

    expect(onPage).toHaveBeenCalledWith(1, 2, 1)
    expect(onPage).toHaveBeenCalledWith(2, 2, 1)
  })

  it('fetches only page 1 for a single-page account', async () => {
    mockFetch.mockResolvedValueOnce(bookmarksPage([bookmark({ href: '/works/1' })]))
    const promise = discoverAo3Bookmarks('u')
    await vi.runAllTimersAsync()
    const result = await promise
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(result.pagesFetched).toBe(1)
  })
})
