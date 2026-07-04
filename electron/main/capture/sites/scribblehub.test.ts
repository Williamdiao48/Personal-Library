import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { okText, notOk } from '../../../../test/stubs/httpResponse'

// captureScribbleHub uses fetch.ts for the series page + chapter bodies, but pulls
// the chapter list from a WordPress AJAX endpoint via the *global* fetch. Mock the
// module for the former and stub global fetch for the latter, then feed SH-shaped
// HTML so the real reverse-ordering / extraction / range logic runs offline.
vi.mock('../fetch', () => ({
  fetchPage: vi.fn(),
  fetchPagesWithSession: vi.fn(),
  BROWSER_HEADERS: { 'User-Agent': 'test-ua' },
}))

import { captureScribbleHub, getScribbleHubChapterCount } from './scribblehub'
import { fetchPage, fetchPagesWithSession } from '../fetch'

const mockFetchPage = vi.mocked(fetchPage)
const mockSession = vi.mocked(fetchPagesWithSession)
let fetchMock: ReturnType<typeof vi.fn>

function seriesPage(
  opts: {
    title?: string | null
    ogTitleFallback?: string // h1 fallback
    author?: string | null
    metaAuthor?: string
    cover?: string | null
    ogImage?: string
  } = {},
): string {
  const {
    title = 'SH Story',
    ogTitleFallback,
    author = 'SH Author',
    metaAuthor,
    cover = 'https://sh.test/c.jpg',
    ogImage,
  } = opts
  return `<!DOCTYPE html><html><head>
    ${metaAuthor ? `<meta name="author" content="${metaAuthor}">` : ''}
    ${ogImage ? `<meta property="og:image" content="${ogImage}">` : ''}
  </head><body>
    ${title != null ? `<div class="fic-title">${title}</div>` : ''}
    ${ogTitleFallback ? `<h1>${ogTitleFallback}</h1>` : ''}
    ${author != null ? `<span class="auth_name_fic">${author}</span>` : ''}
    ${cover != null ? `<div class="fic-image"><img src="${cover}"></div>` : ''}
  </body></html>`
}

// AJAX TOC — newest-first, as Scribble Hub returns it.
function tocHtml(hrefs: string[]): string {
  const items = hrefs.map((h) => `<li class="toc_w"><a href="${h}">t</a></li>`).join('')
  return `<ul>${items}</ul>`
}

function shChapter(title: string, body: string): string {
  return `<html><body>
    <div class="chapter-inner-header"><h1>${title}</h1></div>
    <div class="chp-raw">${body}</div>
  </body></html>`
}

beforeEach(() => {
  mockFetchPage.mockReset()
  mockSession.mockReset()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('captureScribbleHub', () => {
  it('reverses the newest-first AJAX TOC into reading order and assembles chapters', async () => {
    mockFetchPage.mockResolvedValue(seriesPage())
    // TOC arrives newest-first: chapter 3, 2, 1.
    fetchMock.mockResolvedValue(okText(tocHtml(['/read/3-c', '/read/2-b', '/read/1-a'])))
    mockSession.mockResolvedValue([
      shChapter('One', '<p>Alpha.</p>'),
      shChapter('Two', '<p>Beta.</p>'),
      shChapter('Three', '<p>Gamma.</p>'),
    ])

    const result = await captureScribbleHub('https://www.scribblehub.com/series/55/slug/')

    // Chapters fetched in reading order (1 → 3), i.e. the TOC was reversed.
    const urls = mockSession.mock.calls[0][0] as string[]
    expect(urls[0]).toContain('/read/1-a')
    expect(urls[2]).toContain('/read/3-c')
    expect(result.title).toBe('SH Story')
    expect(result.author).toBe('SH Author')
    expect(result.coverUrl).toBe('https://sh.test/c.jpg')
    expect((result.html.match(/class="chapter"/g) ?? []).length).toBe(3)
    expect(result.html.indexOf('Alpha.')).toBeLessThan(result.html.indexOf('Gamma.'))
  })

  it('throws when the AJAX TOC request is not ok', async () => {
    mockFetchPage.mockResolvedValue(seriesPage())
    fetchMock.mockResolvedValue(notOk(503))
    await expect(captureScribbleHub('https://www.scribblehub.com/series/55/')).rejects.toThrow(
      /TOC request returned 503/i,
    )
  })

  it('falls back to h1 / meta author / og:image, then Unknown Story / null', async () => {
    mockFetchPage.mockResolvedValue(
      seriesPage({
        title: null,
        ogTitleFallback: 'H1 Title',
        author: null,
        metaAuthor: 'Meta A',
        cover: null,
        ogImage: 'https://sh.test/og.png',
      }),
    )
    fetchMock.mockResolvedValue(okText(tocHtml(['/read/1-a'])))
    mockSession.mockResolvedValue([shChapter('One', '<p>x</p>')])

    const result = await captureScribbleHub('https://www.scribblehub.com/series/55/')
    expect(result.title).toBe('H1 Title')
    expect(result.author).toBe('Meta A')
    expect(result.coverUrl).toBe('https://sh.test/og.png')

    // And with nothing at all → hard defaults.
    mockFetchPage.mockResolvedValue(seriesPage({ title: null, author: null, cover: null }))
    fetchMock.mockResolvedValue(okText(tocHtml(['/read/1-a'])))
    mockSession.mockResolvedValue([shChapter('One', '<p>x</p>')])
    const bare = await captureScribbleHub('https://www.scribblehub.com/series/55/')
    expect(bare.title).toBe('Unknown Story')
    expect(bare.author).toBeNull()
    expect(bare.coverUrl).toBeNull()
  })

  it('sanitizes script out of chapter bodies', async () => {
    mockFetchPage.mockResolvedValue(seriesPage())
    fetchMock.mockResolvedValue(okText(tocHtml(['/read/1-a'])))
    mockSession.mockResolvedValue([shChapter('One', '<p>Safe.</p><script>evil()</script>')])

    const result = await captureScribbleHub('https://www.scribblehub.com/series/55/')
    expect(result.html).toContain('Safe.')
    expect(result.html).not.toMatch(/script/i)
  })

  it('honors a chapter range against the reading-order list', async () => {
    mockFetchPage.mockResolvedValue(seriesPage())
    fetchMock.mockResolvedValue(okText(tocHtml(['/read/3-c', '/read/2-b', '/read/1-a'])))
    mockSession.mockResolvedValue([
      shChapter('Two', '<p>Two.</p>'),
      shChapter('Three', '<p>Three.</p>'),
    ])

    await captureScribbleHub('https://www.scribblehub.com/series/55/', undefined, {
      start: 2,
      end: 3,
    })
    const urls = mockSession.mock.calls[0][0] as string[]
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('/read/2-b')
    expect(urls[1]).toContain('/read/3-c')
  })

  it('throws when the TOC has no chapters', async () => {
    mockFetchPage.mockResolvedValue(seriesPage())
    fetchMock.mockResolvedValue(okText(tocHtml([])))
    await expect(captureScribbleHub('https://www.scribblehub.com/series/55/')).rejects.toThrow(
      /No chapters found/i,
    )
  })

  it('throws when chapter pages have no extractable content', async () => {
    mockFetchPage.mockResolvedValue(seriesPage())
    fetchMock.mockResolvedValue(okText(tocHtml(['/read/1-a'])))
    mockSession.mockResolvedValue(['<html><body><p>nothing here</p></body></html>'])
    await expect(captureScribbleHub('https://www.scribblehub.com/series/55/')).rejects.toThrow(
      /Could not extract/i,
    )
  })

  it('throws when the URL is neither a series nor a read page', async () => {
    await expect(captureScribbleHub('https://www.scribblehub.com/profile/9')).rejects.toThrow(
      /series ID/i,
    )
  })
})

describe('getScribbleHubChapterCount', () => {
  it('counts TOC chapter links via the AJAX endpoint', async () => {
    fetchMock.mockResolvedValue(okText(tocHtml(['/read/1-a', '/read/2-b'])))
    expect(await getScribbleHubChapterCount('https://www.scribblehub.com/series/55/')).toBe(2)
  })

  it('accepts a /read/ chapter URL', async () => {
    fetchMock.mockResolvedValue(okText(tocHtml(['/read/1-a'])))
    expect(await getScribbleHubChapterCount('https://www.scribblehub.com/read/999-slug')).toBe(1)
  })

  it('returns null for an unparseable URL', async () => {
    expect(await getScribbleHubChapterCount('https://www.scribblehub.com/profile/9')).toBeNull()
  })

  it('returns null when the AJAX request is not ok', async () => {
    fetchMock.mockResolvedValue(notOk(500))
    expect(await getScribbleHubChapterCount('https://www.scribblehub.com/series/55/')).toBeNull()
  })
})
