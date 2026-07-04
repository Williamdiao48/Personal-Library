import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { okJson, notOk } from '../../../../test/stubs/httpResponse'

// captureWattpad reads story metadata + the part list from the Wattpad JSON API
// (global fetch), then pulls each chapter body via fetch.ts. Mock the module and
// stub global fetch so the real pagination / re-fetch / assembly logic runs offline.
vi.mock('../fetch', () => ({
  fetchPagesWithSession: vi.fn(),
  fetchPagesSequential: vi.fn(),
  BROWSER_HEADERS: { 'User-Agent': 'test-ua' },
}))

import { captureWattpad, getWattpadChapterCount } from './wattpad'
import { fetchPagesWithSession, fetchPagesSequential } from '../fetch'

const mockSession = vi.mocked(fetchPagesWithSession)
const mockSequential = vi.mocked(fetchPagesSequential)
let fetchMock: ReturnType<typeof vi.fn>

function part(id: number, title = `Part ${id}`): { id: number; title: string; url: string } {
  return { id, title, url: `https://www.wattpad.com/${id}-x` }
}

// One page of the Wattpad API v3 story response.
function apiPage(opts: {
  parts: Array<{ id: number; title: string; url: string }>
  total?: number
  title?: string | null
  author?: string | null
  cover?: string | null
}) {
  const {
    parts,
    total,
    title = 'WP Story',
    author = 'WP Author',
    cover = 'https://wp.test/c.jpg',
  } = opts
  const body: Record<string, unknown> = {
    id: 1,
    user: author === null ? null : { name: author },
    cover,
    total: total ?? parts.length,
    parts,
  }
  if (title !== null) body.title = title
  return okJson(body)
}

const storytext = (body: string): string => `<p>${body}</p>`

beforeEach(() => {
  mockSession.mockReset()
  mockSequential.mockReset()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('captureWattpad', () => {
  it('throws when the URL has no parseable story id', async () => {
    await expect(captureWattpad('https://www.wattpad.com/user/someone')).rejects.toThrow(
      /story ID/i,
    )
  })

  it('extracts JSON metadata and uses each part title as its chapter heading', async () => {
    fetchMock.mockResolvedValue(
      apiPage({ parts: [part(10, 'Alpha Ch'), part(11, 'Beta Ch')], total: 2 }),
    )
    mockSession.mockResolvedValue([storytext('Alpha body.'), storytext('Beta body.')])

    const result = await captureWattpad('https://www.wattpad.com/story/777-title')

    expect(fetchMock).toHaveBeenCalledTimes(1) // single page, no pagination
    expect(result.title).toBe('WP Story')
    expect(result.author).toBe('WP Author')
    expect(result.coverUrl).toBe('https://wp.test/c.jpg')
    expect((result.html.match(/class="chapter"/g) ?? []).length).toBe(2)
    expect(result.html).toContain('Alpha Ch') // part.title as heading
    expect(result.html).toContain('Beta body.')
    // storytext fetched from the apiv2 endpoint keyed by part id
    const urls = mockSession.mock.calls[0][0] as string[]
    expect(urls[0]).toContain('storytext?id=10')
  })

  it('paginates the part list when total exceeds the page limit', async () => {
    const firstPage = Array.from({ length: 200 }, (_, i) => part(i + 1))
    fetchMock
      .mockResolvedValueOnce(apiPage({ parts: firstPage, total: 201 }))
      .mockResolvedValueOnce(apiPage({ parts: [part(201)], total: 201 }))
    mockSession.mockResolvedValue(Array.from({ length: 201 }, () => storytext('x')))

    await captureWattpad('https://www.wattpad.com/story/777')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toContain('offset=200')
  })

  it('re-fetches empty (soft-blocked) storytext responses via the sequential path', async () => {
    fetchMock.mockResolvedValue(apiPage({ parts: [part(10), part(11)], total: 2 }))
    // First part comes back empty → must be re-fetched via browser.
    mockSession.mockResolvedValue(['', storytext('Two body.')])
    mockSequential.mockResolvedValue([storytext('One recovered.')])

    const result = await captureWattpad('https://www.wattpad.com/story/777')

    const reUrls = mockSequential.mock.calls[0][0] as string[]
    expect(reUrls).toHaveLength(1)
    expect(reUrls[0]).toContain('storytext?id=10')
    expect(result.html).toContain('One recovered.')
    expect(result.html).toContain('Two body.')
    expect((result.html.match(/class="chapter"/g) ?? []).length).toBe(2)
  })

  it('sanitizes script out of chapter bodies', async () => {
    fetchMock.mockResolvedValue(apiPage({ parts: [part(10)], total: 1 }))
    mockSession.mockResolvedValue(['<p>Safe.</p><script>evil()</script>'])
    const result = await captureWattpad('https://www.wattpad.com/story/777')
    expect(result.html).toContain('Safe.')
    expect(result.html).not.toMatch(/script/i)
  })

  it('falls back to Unknown Story / null author when the JSON omits them', async () => {
    fetchMock.mockResolvedValue(
      apiPage({ parts: [part(10)], total: 1, title: null, author: null, cover: null }),
    )
    mockSession.mockResolvedValue([storytext('x')])
    const result = await captureWattpad('https://www.wattpad.com/story/777')
    expect(result.title).toBe('Unknown Story')
    expect(result.author).toBeNull()
    expect(result.coverUrl).toBeNull()
  })

  it('honors a chapter range, slicing the part list', async () => {
    fetchMock.mockResolvedValue(apiPage({ parts: [part(10), part(11), part(12)], total: 3 }))
    mockSession.mockResolvedValue([storytext('Two.'), storytext('Three.')])

    await captureWattpad('https://www.wattpad.com/story/777', undefined, { start: 2, end: 3 })
    const urls = mockSession.mock.calls[0][0] as string[]
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('storytext?id=11')
    expect(urls[1]).toContain('storytext?id=12')
  })

  it('throws when the API response is not ok', async () => {
    fetchMock.mockResolvedValue(notOk(500, 'Server Error'))
    await expect(captureWattpad('https://www.wattpad.com/story/777')).rejects.toThrow(
      /Wattpad API returned 500/i,
    )
  })

  it('throws when the story has no parts', async () => {
    fetchMock.mockResolvedValue(apiPage({ parts: [], total: 0 }))
    await expect(captureWattpad('https://www.wattpad.com/story/777')).rejects.toThrow(
      /No chapters found/i,
    )
  })
})

describe('getWattpadChapterCount', () => {
  it('returns the total from the JSON API', async () => {
    fetchMock.mockResolvedValue(okJson({ total: 42 }))
    expect(await getWattpadChapterCount('https://www.wattpad.com/story/777')).toBe(42)
  })

  it('returns null for an unparseable URL', async () => {
    expect(await getWattpadChapterCount('https://www.wattpad.com/user/x')).toBeNull()
  })

  it('returns null when the API request is not ok', async () => {
    fetchMock.mockResolvedValue(notOk(429))
    expect(await getWattpadChapterCount('https://www.wattpad.com/story/777')).toBeNull()
  })

  it('returns null when total is not a number', async () => {
    fetchMock.mockResolvedValue(okJson({ total: 'lots' }))
    expect(await getWattpadChapterCount('https://www.wattpad.com/story/777')).toBeNull()
  })
})
