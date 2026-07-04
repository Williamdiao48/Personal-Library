import { describe, it, expect, vi, beforeEach } from 'vitest'

// captureRoyalRoad's only coupling is the network layer (fetch.ts). Mock it and
// feed Royal-Road-shaped HTML so the real extraction / sanitize / multi-chapter
// assembly / range-slicing logic runs without a BrowserWindow or network.
vi.mock('../fetch', () => ({
  fetchPage: vi.fn(),
  fetchPagesWithSession: vi.fn(),
}))

import { captureRoyalRoad, getRoyalRoadChapterCount } from './royalroad'
import { fetchPage, fetchPagesWithSession } from '../fetch'

const mockFetchPage = vi.mocked(fetchPage)
const mockFetchPages = vi.mocked(fetchPagesWithSession)

// A fiction page. `chapterHrefs` populates <table id="chapters">; omit an element
// (title/author/cover) to exercise the fallback ladders.
function rrFiction(
  opts: {
    chapterHrefs?: string[]
    title?: string | null
    ogTitle?: string
    author?: string | null
    metaAuthor?: string
    cover?: string | null
    ogImage?: string
  } = {},
): string {
  const {
    chapterHrefs = ['/fiction/1/slug/chapter/1/a', '/fiction/1/slug/chapter/2/b'],
    title = 'My RR Story',
    ogTitle,
    author = 'RR Author',
    metaAuthor,
    cover = 'https://rr.test/cover.jpg',
    ogImage,
  } = opts
  const rows = chapterHrefs
    .map((href) => `<tr><td><a href="${href}">chapter</a></td></tr>`)
    .join('')
  return `<!DOCTYPE html><html><head>
    ${ogTitle ? `<meta property="og:title" content="${ogTitle}">` : ''}
    ${metaAuthor ? `<meta name="author" content="${metaAuthor}">` : ''}
    ${ogImage ? `<meta property="og:image" content="${ogImage}">` : ''}
  </head><body>
    ${title != null ? `<h1>${title}</h1>` : ''}
    <div class="fic-header">
      ${author != null ? `<a href="/profile/9/x">${author}</a>` : ''}
    </div>
    ${cover != null ? `<img class="thumbnail" src="${cover}">` : ''}
    <table id="chapters"><tbody>${rows}</tbody></table>
  </body></html>`
}

function rrChapter(title: string, body: string): string {
  return `<html><body>
    <h1 class="chapter-title">${title}</h1>
    <div class="chapter-content">${body}</div>
  </body></html>`
}

beforeEach(() => {
  mockFetchPage.mockReset()
  mockFetchPages.mockReset()
})

describe('captureRoyalRoad', () => {
  it('extracts metadata and assembles multi-chapter content', async () => {
    mockFetchPage.mockResolvedValue(rrFiction())
    mockFetchPages.mockResolvedValue([
      rrChapter('One', '<p>Alpha.</p>'),
      rrChapter('Two', '<p>Beta.</p>'),
    ])

    const result = await captureRoyalRoad('https://www.royalroad.com/fiction/1/slug')

    expect(result.title).toBe('My RR Story')
    expect(result.author).toBe('RR Author')
    expect(result.coverUrl).toBe('https://rr.test/cover.jpg')
    expect((result.html.match(/class="chapter"/g) ?? []).length).toBe(2)
    expect(result.html).toContain('Alpha.')
    expect(result.html).toContain('Beta.')
    expect(result.textContent).toContain('Alpha.')
  })

  it('sanitizes script out of chapter bodies', async () => {
    mockFetchPage.mockResolvedValue(rrFiction({ chapterHrefs: ['/fiction/1/s/chapter/1'] }))
    mockFetchPages.mockResolvedValue([rrChapter('One', '<p>Safe.</p><script>evil()</script>')])

    const result = await captureRoyalRoad('https://www.royalroad.com/fiction/1')
    expect(result.html).toContain('Safe.')
    expect(result.html).not.toMatch(/script/i)
  })

  it('falls back to og:title / meta author / og:image when primary selectors miss', async () => {
    mockFetchPage.mockResolvedValue(
      rrFiction({
        chapterHrefs: ['/fiction/1/s/chapter/1'],
        title: null,
        author: null,
        cover: null,
        ogTitle: 'OG Title',
        metaAuthor: 'Meta Author',
        ogImage: 'https://rr.test/og.png',
      }),
    )
    mockFetchPages.mockResolvedValue([rrChapter('One', '<p>x</p>')])

    const result = await captureRoyalRoad('https://www.royalroad.com/fiction/1')
    expect(result.title).toBe('OG Title')
    expect(result.author).toBe('Meta Author')
    expect(result.coverUrl).toBe('https://rr.test/og.png')
  })

  it('uses Unknown Story / null when no metadata is present at all', async () => {
    mockFetchPage.mockResolvedValue(
      rrFiction({
        chapterHrefs: ['/fiction/1/s/chapter/1'],
        title: null,
        author: null,
        cover: null,
      }),
    )
    mockFetchPages.mockResolvedValue([rrChapter('One', '<p>x</p>')])

    const result = await captureRoyalRoad('https://www.royalroad.com/fiction/1')
    expect(result.title).toBe('Unknown Story')
    expect(result.author).toBeNull()
    expect(result.coverUrl).toBeNull()
  })

  it('honors a chapter range, slicing the fetched links to the window', async () => {
    mockFetchPage.mockResolvedValue(
      rrFiction({
        chapterHrefs: [
          '/fiction/1/s/chapter/1',
          '/fiction/1/s/chapter/2',
          '/fiction/1/s/chapter/3',
        ],
      }),
    )
    mockFetchPages.mockResolvedValue([
      rrChapter('Two', '<p>Two.</p>'),
      rrChapter('Three', '<p>Three.</p>'),
    ])

    const result = await captureRoyalRoad('https://www.royalroad.com/fiction/1', undefined, {
      start: 2,
      end: 3,
    })

    const fetched = mockFetchPages.mock.calls[0][0] as string[]
    expect(fetched).toHaveLength(2)
    expect(fetched[0]).toContain('/chapter/2')
    expect(fetched[1]).toContain('/chapter/3')
    expect(result.html).toContain('Two.')
    expect(result.html).not.toContain('One.')
  })

  it('deduplicates repeated chapter links before fetching', async () => {
    // Same href twice in the table — the parser must fetch it once.
    mockFetchPage.mockResolvedValue(
      rrFiction({ chapterHrefs: ['/fiction/1/s/chapter/1', '/fiction/1/s/chapter/1'] }),
    )
    mockFetchPages.mockResolvedValue([rrChapter('One', '<p>Once.</p>')])

    await captureRoyalRoad('https://www.royalroad.com/fiction/1')
    const fetched = mockFetchPages.mock.calls[0][0] as string[]
    expect(fetched).toHaveLength(1)
  })

  it('throws when the URL has no parseable fiction id', async () => {
    await expect(captureRoyalRoad('https://www.royalroad.com/profile/9')).rejects.toThrow(
      /fiction ID/i,
    )
  })

  it('throws when the fiction page lists no chapters', async () => {
    mockFetchPage.mockResolvedValue(rrFiction({ chapterHrefs: [] }))
    await expect(captureRoyalRoad('https://www.royalroad.com/fiction/1')).rejects.toThrow(
      /No chapters found/i,
    )
  })

  it('throws when chapter pages lack extractable content', async () => {
    mockFetchPage.mockResolvedValue(rrFiction({ chapterHrefs: ['/fiction/1/s/chapter/1'] }))
    mockFetchPages.mockResolvedValue(['<html><body><p>no chapter-content here</p></body></html>'])

    await expect(captureRoyalRoad('https://www.royalroad.com/fiction/1')).rejects.toThrow(
      /Could not extract/i,
    )
  })
})

describe('getRoyalRoadChapterCount', () => {
  it('counts chapter links on the fiction page', async () => {
    mockFetchPage.mockResolvedValue(
      rrFiction({ chapterHrefs: ['/fiction/1/s/chapter/1', '/fiction/1/s/chapter/2'] }),
    )
    expect(await getRoyalRoadChapterCount('https://www.royalroad.com/fiction/1')).toBe(2)
  })

  it('returns null for an unparseable URL', async () => {
    expect(await getRoyalRoadChapterCount('https://www.royalroad.com/profile/9')).toBeNull()
  })

  it('returns null when the fetch fails', async () => {
    mockFetchPage.mockRejectedValue(new Error('network'))
    expect(await getRoyalRoadChapterCount('https://www.royalroad.com/fiction/1')).toBeNull()
  })
})
