import { describe, it, expect, vi, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'

// captureUniversal couples only to fetch.ts (no global fetch, no better-sqlite3 →
// no ABI toggle). Mock the module so the real detection / Readability / assembly
// logic runs offline; the pure helpers are exported and tested directly.
vi.mock('../fetch', () => ({
  fetchPage: vi.fn(),
  fetchPagesWithSession: vi.fn(),
  fetchPagesSequential: vi.fn(),
}))

import {
  captureUniversal,
  probePageType,
  normalizeUrl,
  resolveUrl,
  findNextLink,
  findPrevLink,
  findTocLink,
  extractTocLinks,
  detectNumericChapter,
  extractChapterCount,
  extractSeriesTitle,
  extractAuthor,
  extractCoverUrl,
  readChapterPage,
} from './universal'
import { fetchPage, fetchPagesWithSession, fetchPagesSequential } from '../fetch'

const mockFetchPage = vi.mocked(fetchPage)
const mockSession = vi.mocked(fetchPagesWithSession)
const mockSequential = vi.mocked(fetchPagesSequential)

const docOf = (html: string, url = 'https://example.com/'): Document =>
  new JSDOM(html, { url }).window.document

// Readability needs a real block of prose (its default charThreshold is ~500) and
// batchFetchChapters discards pages under 100 chars as soft-blocked, so chapter
// fixtures carry several lorem paragraphs plus a unique marker to assert ordering.
const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam quis nostrud.'
function longProse(marker = ''): string {
  return Array.from(
    { length: 6 },
    (_, i) => `<p>${LOREM} ${marker} sentence ${i + 1}. ${LOREM}</p>`,
  ).join('')
}

// A full chapter page: an <article> of prose plus optional nav / toc-link / <select>.
function chapterPage(
  opts: {
    title?: string
    marker?: string
    next?: string
    prev?: string
    tocLink?: string
    selectCount?: number
    author?: string
    cover?: string
  } = {},
): string {
  const { title = 'A Story', marker = '', next, prev, tocLink, selectCount, author, cover } = opts
  const nav: string[] = []
  if (prev) nav.push(`<a rel="prev" href="${prev}">Previous</a>`)
  if (next) nav.push(`<a rel="next" href="${next}">Next</a>`)
  if (tocLink) nav.push(`<a href="${tocLink}">Table of Contents</a>`)
  const select = selectCount
    ? `<select>${Array.from({ length: selectCount }, (_, i) => `<option>Ch ${i + 1}</option>`).join('')}</select>`
    : ''
  return `<!DOCTYPE html><html><head>
    <title>${title}</title>
    ${author ? `<meta name="author" content="${author}">` : ''}
    ${cover ? `<meta property="og:image" content="${cover}">` : ''}
  </head><body>
    <nav>${nav.join('')}</nav>
    ${select}
    <article><h1>${title}</h1>${longProse(marker)}</article>
  </body></html>`
}

// A table-of-contents index page.
function tocPage(opts: {
  title?: string
  author?: string
  cover?: string
  chapters: { text: string; href: string }[]
}): string {
  const { title = 'TOC Story', author, cover, chapters } = opts
  const links = chapters.map((c) => `<a href="${c.href}">${c.text}</a>`).join('')
  return `<!DOCTYPE html><html><head>
    <title>${title}</title>
    ${author ? `<meta name="author" content="${author}">` : ''}
    ${cover ? `<meta property="og:image" content="${cover}">` : ''}
  </head><body>
    <h1>${title}</h1>
    <div class="toc">${links}</div>
  </body></html>`
}

beforeEach(() => {
  mockFetchPage.mockReset()
  mockSession.mockReset()
  mockSequential.mockReset()
})

// ── URL utilities ─────────────────────────────────────────────────────────────
describe('normalizeUrl / resolveUrl', () => {
  it('normalizeUrl strips trailing slash + fragment and lowercases origin', () => {
    expect(normalizeUrl('https://EXAMPLE.com/ch/3/#top')).toBe(
      normalizeUrl('https://example.com/ch/3'),
    )
  })

  it('normalizeUrl keeps the query string', () => {
    expect(normalizeUrl('https://example.com/ch/3?p=2')).toBe('https://example.com/ch/3?p=2')
  })

  it('normalizeUrl falls back to lowercase for an unparseable input', () => {
    expect(normalizeUrl('NOT A URL')).toBe('not a url')
  })

  it('resolveUrl resolves against a base', () => {
    expect(resolveUrl('/a', 'https://example.com/b')).toBe('https://example.com/a')
  })

  it('resolveUrl returns empty string on an unparseable href/base', () => {
    expect(resolveUrl('/a', 'not-a-base')).toBe('')
  })
})

// ── Page-type detection ────────────────────────────────────────────────────────
describe('probePageType', () => {
  const NEUTRAL = 'https://example.com/read/abc'

  it('detects a chapter from <link rel="next"> in head', () => {
    expect(
      probePageType(
        docOf('<head><link rel="next" href="/n"></head><body><p>x</p></body>', NEUTRAL),
        NEUTRAL,
      ),
    ).toBe('chapter')
  })

  it('detects a chapter from <a rel="next"> in body', () => {
    expect(
      probePageType(docOf('<body><a rel="next" href="/n">go</a></body>', NEUTRAL), NEUTRAL),
    ).toBe('chapter')
  })

  it('detects a chapter from visible next/prev nav text', () => {
    expect(
      probePageType(docOf('<body><a href="/n">Next Chapter</a></body>', NEUTRAL), NEUTRAL),
    ).toBe('chapter')
  })

  it('detects a chapter from a /chapter/N URL segment', () => {
    expect(
      probePageType(
        docOf('<body><p>plain</p></body>', 'https://example.com/chapter/3'),
        'https://example.com/chapter/3',
      ),
    ).toBe('chapter')
  })

  it('detects a TOC from >=3 chapter-labelled anchors', () => {
    const html =
      '<body><a href="/a">Chapter 1</a><a href="/b">Chapter 2</a><a href="/c">Prologue</a></body>'
    expect(probePageType(docOf(html, 'https://example.com/toc'), 'https://example.com/toc')).toBe(
      'toc',
    )
  })

  it('detects a TOC from a work-index URL with many same-prefix links', () => {
    const url = 'https://example.com/fiction/9/title'
    const html =
      '<body><a href="/fiction/9/x">Read</a><a href="/fiction/9/y">Read</a><a href="/fiction/9/z">Read</a></body>'
    expect(probePageType(docOf(html, url), url)).toBe('toc')
  })

  it('returns article when no serial signals are present', () => {
    expect(
      probePageType(
        docOf('<body><p>just an ordinary article</p></body>', 'https://example.com/about'),
        'https://example.com/about',
      ),
    ).toBe('article')
  })

  // Headline: chapter signals are checked before TOC signals, so a page with BOTH
  // nav links and >=3 chapter anchors is a chapter, not a TOC.
  it('prefers chapter over TOC when both signals are present', () => {
    const html =
      '<body><a href="/n">Next Chapter</a>' +
      '<a href="/a">Chapter 1</a><a href="/b">Chapter 2</a><a href="/c">Chapter 3</a></body>'
    expect(probePageType(docOf(html, NEUTRAL), NEUTRAL)).toBe('chapter')
  })
})

// ── Navigation link detection ──────────────────────────────────────────────────
describe('findNextLink / findPrevLink', () => {
  it('prefers <head> link[rel=next] over a body text match', () => {
    const html =
      '<head><link rel="next" href="/n1"></head><body><a href="/n3">Next Chapter</a></body>'
    expect(findNextLink(docOf(html), 'https://example.com/')).toBe('https://example.com/n1')
  })

  it('uses <a rel="next"> in the body', () => {
    expect(
      findNextLink(
        docOf('<body><a rel="next" href="/n2">whatever</a></body>'),
        'https://example.com/',
      ),
    ).toBe('https://example.com/n2')
  })

  it('matches next/prev by anchor text', () => {
    expect(
      findNextLink(docOf('<body><a href="/n3">Next Chapter</a></body>'), 'https://example.com/'),
    ).toBe('https://example.com/n3')
    expect(
      findPrevLink(docOf('<body><a href="/p">Previous</a></body>'), 'https://example.com/'),
    ).toBe('https://example.com/p')
  })

  it('skips fragment-only (#) hrefs', () => {
    expect(
      findNextLink(docOf('<body><a href="#">Next Chapter</a></body>'), 'https://example.com/'),
    ).toBeNull()
  })

  // Headline: NEXT_TEXT_RE matches the whole trimmed string, so "next" embedded in
  // longer prose is not mistaken for a navigation link.
  it('does not match "next" embedded in longer anchor text', () => {
    expect(
      findNextLink(
        docOf('<body><a href="/bad">See what happens next in Book 2</a></body>'),
        'https://example.com/',
      ),
    ).toBeNull()
  })
})

// ── TOC link + chapter extraction ──────────────────────────────────────────────
describe('extractTocLinks / findTocLink', () => {
  it('extracts same-origin chapter links, dropping self/external/dupes', () => {
    const url = 'https://x.com/fiction/1'
    const html =
      '<body>' +
      '<a href="/fiction/1/ch1">Chapter 1</a>' +
      '<a href="/fiction/1/ch2">Chapter 2</a>' +
      '<a href="/fiction/1/ch2">Chapter 2 again</a>' + // dup by path
      '<a href="https://other.com/x">Chapter X</a>' + // external
      '<a href="/fiction/1">Chapter Self</a>' + // self
      '<a href="/fiction/1/home">Home</a>' + // no chapter word
      '</body>'
    expect(extractTocLinks(docOf(html, url), url)).toEqual([
      'https://x.com/fiction/1/ch1',
      'https://x.com/fiction/1/ch2',
    ])
  })

  it('findTocLink prefers an explicit "Table of Contents" text link', () => {
    expect(
      findTocLink(
        docOf('<body><a href="/toc">Table of Contents</a></body>', 'https://x.com/read/5'),
        'https://x.com/read/5',
      ),
    ).toBe('https://x.com/toc')
  })

  it('findTocLink falls back to the deepest breadcrumb prefix ancestor', () => {
    const html = '<body><nav><a href="/fiction">Home</a><a href="/fiction/1">Story</a></nav></body>'
    expect(
      findTocLink(docOf(html, 'https://x.com/fiction/1/ch/5'), 'https://x.com/fiction/1/ch/5'),
    ).toBe('https://x.com/fiction/1')
  })

  it('findTocLink returns null when nothing matches', () => {
    expect(
      findTocLink(docOf('<body><p>x</p></body>', 'https://x.com/read/5'), 'https://x.com/read/5'),
    ).toBeNull()
  })
})

// ── Numeric chapter optimisation ───────────────────────────────────────────────
describe('detectNumericChapter / extractChapterCount', () => {
  // Headline: build(n) substitutes the number, keeping the keyword prefix + suffix.
  it('detectNumericChapter parses the number and builds sibling URLs', () => {
    const numeric = detectNumericChapter('https://x.com/story/chapter/3/slug')
    expect(numeric).not.toBeNull()
    expect(numeric!.current).toBe(3)
    expect(numeric!.build(5)).toBe('https://x.com/story/chapter5/slug')
  })

  it('detectNumericChapter returns null for an opaque URL', () => {
    expect(detectNumericChapter('https://x.com/story/opaque-slug')).toBeNull()
  })

  it('extractChapterCount reads a <select> dropdown (>=2 options)', () => {
    expect(
      extractChapterCount(
        docOf(
          '<body><select><option>a</option><option>b</option><option>c</option></select></body>',
        ),
      ),
    ).toBe(3)
  })

  it('extractChapterCount reads "N chapters" from body text', () => {
    expect(
      extractChapterCount(docOf('<body><p>This story has 42 chapters total.</p></body>')),
    ).toBe(42)
  })

  it('extractChapterCount ignores a count below 2', () => {
    expect(extractChapterCount(docOf('<body>Only 1 chapter here</body>'))).toBeNull()
  })

  it('extractChapterCount returns null when there is no signal', () => {
    expect(extractChapterCount(docOf('<body><p>no numbers</p></body>'))).toBeNull()
  })
})

// ── Metadata extraction ────────────────────────────────────────────────────────
describe('extractSeriesTitle / extractAuthor / extractCoverUrl', () => {
  it('extractSeriesTitle strips a "— Chapter N" suffix from og:title', () => {
    expect(
      extractSeriesTitle(
        docOf(
          '<head><meta property="og:title" content="My Story — Chapter 3"></head><body></body>',
        ),
        'fb',
      ),
    ).toBe('My Story')
  })

  it('extractSeriesTitle strips a ": Chapter N" suffix from <title>', () => {
    expect(
      extractSeriesTitle(
        docOf('<head><title>My Story: Chapter 5</title></head><body></body>'),
        'fb',
      ),
    ).toBe('My Story')
  })

  it('extractSeriesTitle returns the fallback when nothing cleaner is found', () => {
    expect(extractSeriesTitle(docOf('<head></head><body></body>'), 'Fallback Title')).toBe(
      'Fallback Title',
    )
  })

  it('extractAuthor prefers meta[name=author]', () => {
    expect(
      extractAuthor(docOf('<head><meta name="author" content="Jane Doe"></head><body></body>')),
    ).toBe('Jane Doe')
  })

  it('extractAuthor falls back to a /user/ profile link', () => {
    expect(extractAuthor(docOf('<body><a href="/user/bob">bob</a></body>'))).toBe('bob')
  })

  it('extractAuthor returns null when absent', () => {
    expect(extractAuthor(docOf('<body><p>x</p></body>'))).toBeNull()
  })

  it('extractCoverUrl returns og:image', () => {
    expect(
      extractCoverUrl(
        docOf(
          '<head><meta property="og:image" content="https://x.com/cover.jpg"></head><body></body>',
        ),
      ),
    ).toBe('https://x.com/cover.jpg')
  })

  it('extractCoverUrl rejects generic logo/avatar images', () => {
    expect(
      extractCoverUrl(
        docOf(
          '<head><meta property="og:image" content="https://x.com/logo.png"></head><body></body>',
        ),
      ),
    ).toBeNull()
  })

  it('extractCoverUrl returns null when there is no og:image', () => {
    expect(extractCoverUrl(docOf('<body><p>x</p></body>'))).toBeNull()
  })
})

// ── Chapter content parsing ────────────────────────────────────────────────────
describe('readChapterPage', () => {
  it('extracts prose via Readability and sanitizes script out', () => {
    const html = `<html><head><title>Chapter One</title></head><body><article><h1>Chapter One</h1>${longProse('KEEPME')}<script>evil()</script></article></body></html>`
    const result = readChapterPage(docOf(html, 'https://x.com/ch/1'), 'https://x.com/ch/1', 1)
    expect(result).not.toBeNull()
    expect(result!.html).toContain('KEEPME')
    expect(result!.html).not.toMatch(/script/i)
    expect(result!.text.length).toBeGreaterThan(0)
  })

  it('returns null for an empty document', () => {
    expect(
      readChapterPage(
        docOf('<html><body></body></html>', 'https://x.com/ch/1'),
        'https://x.com/ch/1',
        1,
      ),
    ).toBeNull()
  })
})

// ── Integration: captureUniversal end-to-end (../fetch mocked) ──────────────────
describe('captureUniversal', () => {
  it('returns null for a plain article page (falls through to generic)', async () => {
    mockFetchPage.mockResolvedValue(
      `<html><head><title>Blog</title></head><body><article><h1>Hello</h1>${longProse('x')}</article></body></html>`,
    )
    expect(await captureUniversal('https://blog.example.com/post/hello')).toBeNull()
  })

  it('crawls a TOC index page into an assembled multi-chapter work', async () => {
    const url = 'https://example.com/fiction/77'
    mockFetchPage.mockResolvedValue(
      tocPage({
        title: 'Great Story',
        author: 'Ann',
        cover: 'https://example.com/cover.jpg',
        chapters: [
          { text: 'Chapter 1', href: '/fiction/77/ch1' },
          { text: 'Chapter 2', href: '/fiction/77/ch2' },
          { text: 'Chapter 3', href: '/fiction/77/ch3' },
        ],
      }),
    )
    mockSession.mockResolvedValue([
      chapterPage({ title: 'C1', marker: 'ONEE' }),
      chapterPage({ title: 'C2', marker: 'TWOO' }),
      chapterPage({ title: 'C3', marker: 'THREEE' }),
    ])

    const result = await captureUniversal(url)
    expect(result).not.toBeNull()
    expect(result!.title).toBe('Great Story')
    expect(result!.author).toBe('Ann')
    expect(result!.coverUrl).toBe('https://example.com/cover.jpg')
    expect((result!.html.match(/class="chapter"/g) ?? []).length).toBe(3)
    expect(result!.html.indexOf('ONEE')).toBeLessThan(result!.html.indexOf('THREEE'))
  })

  it('recovers a soft-blocked TOC chapter via the sequential re-fetch', async () => {
    const url = 'https://example.com/fiction/77'
    mockFetchPage.mockResolvedValue(
      tocPage({
        title: 'Great Story',
        chapters: [
          { text: 'Chapter 1', href: '/fiction/77/ch1' },
          { text: 'Chapter 2', href: '/fiction/77/ch2' },
          { text: 'Chapter 3', href: '/fiction/77/ch3' },
        ],
      }),
    )
    // First chapter comes back as a short challenge stub (<100 chars) → blocked.
    mockSession.mockResolvedValue([
      '<html><body>blocked</body></html>',
      chapterPage({ marker: 'TWOO' }),
      chapterPage({ marker: 'THREEE' }),
    ])
    mockSequential.mockResolvedValue([chapterPage({ marker: 'RECOV' })])

    const result = await captureUniversal(url)
    expect(result).not.toBeNull()
    expect(result!.html).toContain('RECOV')
    expect(result!.html).toContain('TWOO')
    const reUrls = mockSequential.mock.calls[0][0] as string[]
    expect(reUrls[0]).toContain('/fiction/77/ch1')
  })

  it('follows an explicit Table-of-Contents link from a chapter page (Option 1)', async () => {
    const url = 'https://example.com/read/xyz'
    mockFetchPage.mockImplementation(async (u: string) => {
      if (u.includes('/toc')) {
        return tocPage({
          title: 'Linked Story',
          chapters: [
            { text: 'Chapter 1', href: '/read/a' },
            { text: 'Chapter 2', href: '/read/b' },
          ],
        })
      }
      return chapterPage({
        title: 'Start',
        marker: 'STARTMARK',
        next: '/read/xyz2',
        tocLink: '/toc',
      })
    })
    mockSession.mockResolvedValue([chapterPage({ marker: 'AAA' }), chapterPage({ marker: 'BBB' })])

    const result = await captureUniversal(url)
    expect(result).not.toBeNull()
    expect(result!.html).toContain('AAA')
    expect(result!.html).toContain('BBB')
    expect(mockFetchPage.mock.calls.some(([u]) => u.includes('/toc'))).toBe(true)
  })

  it('builds sibling URLs from a numeric chapter + count (Option 2)', async () => {
    const url = 'https://example.com/story/chapter/1'
    mockFetchPage.mockResolvedValue(chapterPage({ title: 'Numeric', selectCount: 3 }))
    mockSession.mockResolvedValue([
      chapterPage({ marker: 'N1' }),
      chapterPage({ marker: 'N2' }),
      chapterPage({ marker: 'N3' }),
    ])

    const result = await captureUniversal(url)
    expect(result).not.toBeNull()
    expect((result!.html.match(/class="chapter"/g) ?? []).length).toBe(3)
    const urls = mockSession.mock.calls[0][0] as string[]
    expect(urls).toContain('https://example.com/story/chapter2')
    expect(urls).toContain('https://example.com/story/chapter3')
  })

  // Headline: the backward pass is stored newest-first and reversed before being
  // joined with the forward pass, so the assembled order reads ch1 → chN.
  it('walks prev/next links bidirectionally and assembles in reading order (Option 3)', async () => {
    const url = 'https://example.com/read/ch-c' // start mid-series (3rd of 4)
    mockFetchPage.mockImplementation(async (u: string) => {
      if (u.includes('ch-a'))
        return chapterPage({ title: 'A', marker: 'ALPHA', next: '/read/ch-b' })
      if (u.includes('ch-b'))
        return chapterPage({ title: 'B', marker: 'BRAVO', prev: '/read/ch-a', next: '/read/ch-c' })
      if (u.includes('ch-d'))
        return chapterPage({ title: 'D', marker: 'DELTA', prev: '/read/ch-c' })
      return chapterPage({ title: 'C', marker: 'CHARLIE', prev: '/read/ch-b', next: '/read/ch-d' })
    })

    const result = await captureUniversal(url)
    expect(result).not.toBeNull()
    expect((result!.html.match(/class="chapter"/g) ?? []).length).toBe(4)
    const html = result!.html
    expect(html.indexOf('ALPHA')).toBeLessThan(html.indexOf('BRAVO'))
    expect(html.indexOf('BRAVO')).toBeLessThan(html.indexOf('CHARLIE'))
    expect(html.indexOf('CHARLIE')).toBeLessThan(html.indexOf('DELTA'))
  })

  it('stops the forward walk on a self-referential loop (visited guard)', async () => {
    const url = 'https://example.com/read/ch-a'
    mockFetchPage.mockImplementation(async (u: string) => {
      if (u.includes('ch-b'))
        return chapterPage({ title: 'B', marker: 'BRAVO', next: '/read/ch-a' })
      return chapterPage({ title: 'A', marker: 'ALPHA', next: '/read/ch-b' })
    })

    const result = await captureUniversal(url)
    expect(result).not.toBeNull()
    expect((result!.html.match(/class="chapter"/g) ?? []).length).toBe(2)
  })
})
