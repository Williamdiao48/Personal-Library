import { describe, it, expect, vi, beforeEach } from 'vitest'

// captureFfnet couples only to the network layer (fetch.ts): a BrowserWindow load
// for chapter 1, session fetches for the rest, and a sequential browser re-fetch
// for CloudFlare-soft-blocked pages. Mock all three and feed FFN-shaped HTML so
// the real count cross-check / range / re-fetch / extraction logic runs offline.
vi.mock('../fetch', () => ({
  fetchPageWithBrowser: vi.fn(),
  fetchPagesWithSession: vi.fn(),
  fetchPagesSequential: vi.fn(),
}))

import { captureFfnet } from './ffnet'
import { fetchPageWithBrowser, fetchPagesWithSession, fetchPagesSequential } from '../fetch'

const mockBrowser = vi.mocked(fetchPageWithBrowser)
const mockSession = vi.mocked(fetchPagesWithSession)
const mockSequential = vi.mocked(fetchPagesSequential)

// Chapter-1 page: carries story metadata in #profile_top plus the chapter <select>.
function ffnCh1(
  opts: {
    title?: string | null
    author?: string | null
    options?: string[] // <option> texts; index 0 is marked selected
    chaptersMeta?: number | null // "Chapters: N" server-rendered text
    story?: string
    cover?: string | null // #profile_top img src
  } = {},
): string {
  const {
    title = 'FFN Story',
    author = 'FFN Author',
    options = ['1. First'],
    chaptersMeta = null,
    story = '<p>Chapter one.</p>',
    cover = null,
  } = opts
  const optionEls = options
    .map((t, i) => `<option value="${i + 1}"${i === 0 ? ' selected' : ''}>${t}</option>`)
    .join('')
  return `<html><body>
    <div id="profile_top">
      ${title != null ? `<b class="xcontrast_txt">${title}</b>` : ''}
      ${author != null ? `<a class="xcontrast_txt" href="/u/1/x">${author}</a>` : ''}
      ${cover != null ? `<img src="${cover}">` : ''}
      ${chaptersMeta != null ? `<span>Rated: T - Chapters: ${chaptersMeta} - Words: 9000</span>` : ''}
    </div>
    <select id="chap_select">${optionEls}</select>
    <div id="storytext">${story}</div>
  </body></html>`
}

// A later chapter page fetched via session. `story: null` simulates a CloudFlare
// soft-block (200 OK but no #storytext), which triggers the sequential re-fetch.
function ffnChapter(story: string | null, selectedOption?: string): string {
  return `<html><body>
    ${selectedOption ? `<select id="chap_select"><option selected>${selectedOption}</option></select>` : ''}
    ${story != null ? `<div id="storytext">${story}</div>` : ''}
  </body></html>`
}

beforeEach(() => {
  mockBrowser.mockReset()
  mockSession.mockReset()
  mockSequential.mockReset()
})

describe('captureFfnet', () => {
  it('throws when the URL has no parseable story id', async () => {
    await expect(captureFfnet('https://www.fanfiction.net/u/123/someone')).rejects.toThrow(
      /story ID/i,
    )
  })

  it('captures a single-chapter story without any session fetch', async () => {
    mockBrowser.mockResolvedValue(
      ffnCh1({ options: ['1. Prologue'], story: '<p>The only chapter.</p>' }),
    )

    const result = await captureFfnet('https://www.fanfiction.net/s/12345/1/my-slug')

    expect(mockBrowser).toHaveBeenCalledWith('https://www.fanfiction.net/s/12345/1/my-slug')
    expect(mockSession).not.toHaveBeenCalled()
    expect(result.title).toBe('FFN Story')
    expect(result.author).toBe('FFN Author')
    expect((result.html.match(/class="chapter"/g) ?? []).length).toBe(1)
    expect(result.html).toContain('The only chapter.')
    // Selected option "1. Prologue" → chapter heading "Prologue"
    expect(result.html).toContain('>Prologue<')
  })

  it('uses max(select count, "Chapters:" meta) — meta wins over a JS-incomplete select', async () => {
    // select renders only 2 options, but the server-rendered meta says 5.
    mockBrowser.mockResolvedValue(ffnCh1({ options: ['1. A', '2. B'], chaptersMeta: 5 }))
    mockSession.mockResolvedValue([
      ffnChapter('<p>Two.</p>'),
      ffnChapter('<p>Three.</p>'),
      ffnChapter('<p>Four.</p>'),
      ffnChapter('<p>Five.</p>'),
    ])

    const result = await captureFfnet('https://www.fanfiction.net/s/12345/1/my-slug')

    // Chapters 2..5 fetched — the meta count (5) beat the select count (2).
    const urls = mockSession.mock.calls[0][0] as string[]
    expect(urls).toHaveLength(4)
    expect(urls[0]).toContain('/s/12345/2/')
    expect(urls[3]).toContain('/s/12345/5/')
    expect((result.html.match(/class="chapter"/g) ?? []).length).toBe(5)
    expect(mockSequential).not.toHaveBeenCalled()
  })

  it('re-fetches CloudFlare-soft-blocked chapters via the sequential browser path', async () => {
    mockBrowser.mockResolvedValue(ffnCh1({ options: ['1. A'], chaptersMeta: 3 }))
    // Chapter 2 comes back blocked (no #storytext); chapter 3 is fine.
    mockSession.mockResolvedValue([ffnChapter(null), ffnChapter('<p>Three.</p>')])
    mockSequential.mockResolvedValue([ffnChapter('<p>Two recovered.</p>')])

    const result = await captureFfnet('https://www.fanfiction.net/s/12345/1/my-slug')

    // Only the blocked chapter-2 URL is re-fetched sequentially.
    const reUrls = mockSequential.mock.calls[0][0] as string[]
    expect(reUrls).toHaveLength(1)
    expect(reUrls[0]).toContain('/s/12345/2/')
    expect(result.html).toContain('Two recovered.')
    expect(result.html).toContain('Three.')
    expect((result.html.match(/class="chapter"/g) ?? []).length).toBe(3)
  })

  it('honors a range starting past chapter 1, excluding the ch1 body', async () => {
    mockBrowser.mockResolvedValue(
      ffnCh1({ options: ['1. A'], chaptersMeta: 5, story: '<p>CH1.</p>' }),
    )
    mockSession.mockResolvedValue([ffnChapter('<p>Two.</p>'), ffnChapter('<p>Three.</p>')])

    const result = await captureFfnet('https://www.fanfiction.net/s/12345/1/my-slug', undefined, {
      start: 2,
      end: 3,
    })

    const urls = mockSession.mock.calls[0][0] as string[]
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('/s/12345/2/')
    expect(result.html).not.toContain('CH1.')
    expect((result.html.match(/class="chapter"/g) ?? []).length).toBe(2)
  })

  it('parses a bare numeric option to "Chapter N" and absolutizes a protocol-relative cover', async () => {
    mockBrowser.mockResolvedValue(
      ffnCh1({ options: ['1'], cover: '//img.fanfiction.net/story/cover.jpg' }),
    )
    const result = await captureFfnet('https://www.fanfiction.net/s/12345/1/my-slug')
    expect(result.html).toContain('>Chapter 1<')
    expect(result.coverUrl).toBe('https://img.fanfiction.net/story/cover.jpg')
  })

  it('falls back to Unknown Story / null author when metadata is missing', async () => {
    mockBrowser.mockResolvedValue(ffnCh1({ title: null, author: null, cover: null }))
    const result = await captureFfnet('https://www.fanfiction.net/s/12345/1/my-slug')
    expect(result.title).toBe('Unknown Story')
    expect(result.author).toBeNull()
    expect(result.coverUrl).toBeNull()
  })

  it('sanitizes script out of the chapter body', async () => {
    mockBrowser.mockResolvedValue(ffnCh1({ story: '<p>Clean.</p><script>evil()</script>' }))
    const result = await captureFfnet('https://www.fanfiction.net/s/12345/1/my-slug')
    expect(result.html).toContain('Clean.')
    expect(result.html).not.toMatch(/script/i)
  })
})
