import { describe, it, expect, vi, beforeEach } from 'vitest'

// captureXenForo couples only to fetch.ts: fetchPage for the threadmarks list
// (paginated) + the thread's first page (metadata), and fetchPagesWithSession for
// the post pages. fetchPage is routed by URL so one mock serves both roles.
vi.mock('../fetch', () => ({
  fetchPage: vi.fn(),
  fetchPagesWithSession: vi.fn(),
}))

import { captureXenForo, getXenForoChapterCount } from './forums'
import { fetchPage, fetchPagesWithSession } from '../fetch'

const mockFetchPage = vi.mocked(fetchPage)
const mockSession = vi.mocked(fetchPagesWithSession)

const SV = 'https://forums.sufficientvelocity.com/threads/my-story.123'
const SB = 'https://forums.spacebattles.com/threads/sb-story.99'
const perma = (thread: string, n: number): string => `/threads/${thread}/post-${n}`

// A threadmarks list page. `selector` picks which of the parser's selector-ladder
// container classes wraps the links; `next` adds a rel="next" pager link.
function tmPage(hrefs: string[], opts: { next?: boolean; selector?: string } = {}): string {
  const cls = opts.selector ?? 'block-body--threadmarkBody'
  const links = hrefs.map((h) => `<a href="${h}">tm</a>`).join('')
  return `<html><body>
    <div class="${cls}">${links}</div>
    ${opts.next ? '<a rel="next" href="?page=2">Next</a>' : ''}
  </body></html>`
}

function firstPage(
  opts: { title?: string | null; h1?: string; author?: string | null; cover?: string | null } = {},
): string {
  const {
    title = 'Forum Story',
    h1,
    author = 'ForumAuthor',
    cover = 'https://sv.test/og.png',
  } = opts
  return `<!DOCTYPE html><html><head>
    ${cover != null ? `<meta property="og:image" content="${cover}">` : ''}
  </head><body>
    ${title != null ? `<h1 class="p-title-value">${title}</h1>` : ''}
    ${h1 ? `<h1>${h1}</h1>` : ''}
    ${author != null ? `<span class="username">${author}</span>` : ''}
  </body></html>`
}

const article = (id: number, body: string): string =>
  `<article id="post-${id}"><div class="message-body"><div class="bbWrapper">${body}</div></div></article>`

// Route fetchPage: threadmarks page 2 → tm2, any other threadmarks URL → tm1,
// everything else → the thread's first page.
function wireFetchPage(pages: { tm1: string; tm2?: string; first: string }): void {
  mockFetchPage.mockImplementation(async (url: string) => {
    if (pages.tm2 && url.includes('page=2')) return pages.tm2
    if (url.includes('threadmarks')) return pages.tm1
    return pages.first
  })
}

beforeEach(() => {
  mockFetchPage.mockReset()
  mockSession.mockReset()
})

describe('captureXenForo', () => {
  it('throws when the URL is not a SV/SB thread', async () => {
    await expect(captureXenForo('https://example.com/threads/x.1')).rejects.toThrow(/thread URL/i)
  })

  it('extracts metadata and one chapter per threadmark (titled Chapter N)', async () => {
    wireFetchPage({
      tm1: tmPage([perma('my-story.123', 1), perma('my-story.123', 2)]),
      first: firstPage(),
    })
    mockSession.mockResolvedValue([article(1, '<p>Post one.</p>'), article(2, '<p>Post two.</p>')])

    const result = await captureXenForo(SV)

    expect(result.title).toBe('Forum Story')
    expect(result.author).toBe('ForumAuthor')
    expect(result.coverUrl).toBe('https://sv.test/og.png')
    expect((result.html.match(/class="chapter"/g) ?? []).length).toBe(2)
    expect(result.html).toContain('>Chapter 1<')
    expect(result.html).toContain('>Chapter 2<')
    expect(result.html).toContain('Post one.')
  })

  it('parses spacebattles thread URLs too', async () => {
    wireFetchPage({ tm1: tmPage([perma('sb-story.99', 1)]), first: firstPage() })
    mockSession.mockResolvedValue([article(1, '<p>SB body.</p>')])
    const result = await captureXenForo(SB)
    expect(result.html).toContain('SB body.')
  })

  it('follows threadmark pagination and concatenates links across pages', async () => {
    wireFetchPage({
      tm1: tmPage([perma('my-story.123', 1), perma('my-story.123', 2)], { next: true }),
      tm2: tmPage([perma('my-story.123', 3)]),
      first: firstPage(),
    })
    mockSession.mockResolvedValue([
      article(1, '<p>One.</p>'),
      article(2, '<p>Two.</p>'),
      article(3, '<p>Three.</p>'),
    ])

    await captureXenForo(SV)
    const urls = mockSession.mock.calls[0][0] as string[]
    expect(urls).toHaveLength(3)
    expect(urls[2]).toContain('/post-3')
  })

  it('targets the specific post by id, ignoring other posts on the page', async () => {
    wireFetchPage({ tm1: tmPage([perma('my-story.123', 500)]), first: firstPage() })
    // The post page contains an unrelated post first, then the target.
    mockSession.mockResolvedValue([article(999, 'OTHER') + article(500, 'TARGET')])

    const result = await captureXenForo(SV)
    expect(result.html).toContain('TARGET')
    expect(result.html).not.toContain('OTHER')
  })

  it('falls back to the first post when the target id is absent', async () => {
    wireFetchPage({ tm1: tmPage([perma('my-story.123', 500)]), first: firstPage() })
    // No post-500 on the page → fall back to the first article.
    mockSession.mockResolvedValue([article(999, 'FALLBACK')])

    const result = await captureXenForo(SV)
    expect(result.html).toContain('FALLBACK')
  })

  it('collects links via a later selector in the ladder (.threadmarkList)', async () => {
    wireFetchPage({
      tm1: tmPage([perma('my-story.123', 1)], { selector: 'threadmarkList' }),
      first: firstPage(),
    })
    mockSession.mockResolvedValue([article(1, '<p>Body.</p>')])
    const result = await captureXenForo(SV)
    expect(result.html).toContain('Body.')
  })

  it('deduplicates threadmark links that differ only by fragment', async () => {
    const href = perma('my-story.123', 7)
    wireFetchPage({ tm1: tmPage([href, `${href}#post-7`]), first: firstPage() })
    mockSession.mockResolvedValue([article(7, '<p>Once.</p>')])

    await captureXenForo(SV)
    const urls = mockSession.mock.calls[0][0] as string[]
    expect(urls).toHaveLength(1)
  })

  it('falls back to Unknown Story / null when metadata is missing', async () => {
    wireFetchPage({
      tm1: tmPage([perma('my-story.123', 1)]),
      first: firstPage({ title: null, author: null, cover: null }),
    })
    mockSession.mockResolvedValue([article(1, '<p>x</p>')])
    const result = await captureXenForo(SV)
    expect(result.title).toBe('Unknown Story')
    expect(result.author).toBeNull()
    expect(result.coverUrl).toBeNull()
  })

  it('sanitizes script out of post bodies', async () => {
    wireFetchPage({ tm1: tmPage([perma('my-story.123', 1)]), first: firstPage() })
    mockSession.mockResolvedValue([article(1, '<p>Safe.</p><script>evil()</script>')])
    const result = await captureXenForo(SV)
    expect(result.html).toContain('Safe.')
    expect(result.html).not.toMatch(/script/i)
  })

  it('honors a chapter range, slicing the threadmark list', async () => {
    wireFetchPage({
      tm1: tmPage([perma('my-story.123', 1), perma('my-story.123', 2), perma('my-story.123', 3)]),
      first: firstPage(),
    })
    mockSession.mockResolvedValue([article(2, '<p>Two.</p>'), article(3, '<p>Three.</p>')])

    await captureXenForo(SV, undefined, { start: 2, end: 3 })
    const urls = mockSession.mock.calls[0][0] as string[]
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('/post-2')
  })

  it('throws when the thread has no threadmarks', async () => {
    wireFetchPage({ tm1: tmPage([]), first: firstPage() })
    await expect(captureXenForo(SV)).rejects.toThrow(/No threadmarks found/i)
  })

  it('throws when post pages have no extractable body', async () => {
    wireFetchPage({ tm1: tmPage([perma('my-story.123', 1)]), first: firstPage() })
    mockSession.mockResolvedValue(['<html><body><p>no article here</p></body></html>'])
    await expect(captureXenForo(SV)).rejects.toThrow(/Could not extract/i)
  })
})

describe('getXenForoChapterCount', () => {
  it('counts threadmark links', async () => {
    wireFetchPage({
      tm1: tmPage([perma('my-story.123', 1), perma('my-story.123', 2)]),
      first: firstPage(),
    })
    expect(await getXenForoChapterCount(SV)).toBe(2)
  })

  it('returns null for a non-SV/SB URL', async () => {
    expect(await getXenForoChapterCount('https://example.com/threads/x.1')).toBeNull()
  })

  it('returns null when the fetch fails', async () => {
    mockFetchPage.mockRejectedValue(new Error('network'))
    expect(await getXenForoChapterCount(SV)).toBeNull()
  })
})
