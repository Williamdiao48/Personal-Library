import { describe, it, expect, vi, beforeEach } from 'vitest'

// captureAo3's only coupling is the network layer (fetch.ts). Mock it and feed
// AO3-shaped HTML so the real extraction / sanitize / multi-chapter assembly /
// range-slicing logic runs without a BrowserWindow or network.
vi.mock('../fetch', () => ({
  fetchPage: vi.fn(),
  fetchPagesWithSession: vi.fn(),
}))

import { captureAo3 } from './ao3'
import { fetchPage, fetchPagesWithSession } from '../fetch'

const mockFetchPage = vi.mocked(fetchPage)
const mockFetchPages = vi.mocked(fetchPagesWithSession)

function ao3Page(chapters: string[], opts: { next?: boolean; ogImage?: string } = {}): string {
  const chapterEls = chapters
    .map(
      (body, i) => `
      <div class="chapter" id="chapter-${i + 1}">
        <h3 class="title">Chapter ${i + 1}</h3>
        <div class="userstuff" role="article">${body}</div>
      </div>`,
    )
    .join('')
  return `<!DOCTYPE html><html><head>
    ${opts.ogImage ? `<meta property="og:image" content="${opts.ogImage}">` : ''}
  </head><body>
    <h2 class="title heading">My Great Work</h2>
    <h3 class="byline heading"><a rel="author" href="/users/x">Author X</a></h3>
    <dd class="chapters">${chapters.length}/${chapters.length}</dd>
    <div id="workskin"><div id="chapters">${chapterEls}</div></div>
    ${opts.next ? '<a rel="next" href="?page=2">Next</a>' : ''}
  </body></html>`
}

beforeEach(() => {
  mockFetchPage.mockReset()
  mockFetchPages.mockReset()
})

describe('captureAo3', () => {
  it('extracts metadata and sanitized content for a single-chapter work', async () => {
    mockFetchPage.mockResolvedValue(
      ao3Page(['<p>The body.</p><script>evil()</script>'], { ogImage: 'https://ao3.org/cover.jpg' }),
    )

    const result = await captureAo3('https://archiveofourown.org/works/123')

    expect(result.title).toBe('My Great Work')
    expect(result.author).toBe('Author X')
    expect(result.coverUrl).toBe('https://ao3.org/cover.jpg')
    expect(result.html).toContain('The body.')
    expect(result.html).not.toMatch(/script/i) // sanitized
    expect(result.textContent).toContain('The body.')
  })

  it('ignores AO3 logo/placeholder og:image as a cover', async () => {
    mockFetchPage.mockResolvedValue(
      ao3Page(['<p>x</p>'], { ogImage: 'https://ao3.org/images/ao3_logos/logo.png' }),
    )
    const result = await captureAo3('https://archiveofourown.org/works/1')
    expect(result.coverUrl).toBeNull()
  })

  it('assembles multiple chapters into div.chapter blocks', async () => {
    mockFetchPage.mockResolvedValue(
      ao3Page(['<p>One.</p>', '<p>Two.</p>', '<p>Three.</p>']),
    )
    const result = await captureAo3('https://archiveofourown.org/works/9')
    const blocks = result.html.match(/class="chapter"/g) ?? []
    expect(blocks.length).toBe(3)
    expect(result.html).toContain('One.')
    expect(result.html).toContain('Three.')
  })

  it('honors a chapter range, slicing to the requested window', async () => {
    mockFetchPage.mockResolvedValue(
      ao3Page(['<p>One.</p>', '<p>Two.</p>', '<p>Three.</p>']),
    )
    const result = await captureAo3('https://archiveofourown.org/works/9', undefined, {
      start: 1,
      end: 2,
    })
    expect(result.html).toContain('One.')
    expect(result.html).toContain('Two.')
    expect(result.html).not.toContain('Three.')
  })

  it('throws when the URL has no parseable work id', async () => {
    await expect(captureAo3('https://archiveofourown.org/not-a-work')).rejects.toThrow(/work ID/i)
  })
})
