import { describe, it, expect, vi, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'

// captureAo3's only coupling is the network layer (fetch.ts). Mock it and feed
// AO3-shaped HTML so the real extraction / sanitize / multi-chapter assembly /
// range-slicing logic runs without a BrowserWindow or network.
vi.mock('../fetch', () => ({
  fetchPage: vi.fn(),
  fetchPagesWithSession: vi.fn(),
}))

import { captureAo3, parseAo3Metadata } from './ao3'
import { fetchPage, fetchPagesWithSession } from '../fetch'

const mockFetchPage = vi.mocked(fetchPage)
const mockFetchPages = vi.mocked(fetchPagesWithSession)

// The AO3 tag + stats blocks as the real work page renders them.
const AO3_META = `
  <dl class="work meta group">
    <dd class="fandom tags"><ul class="commas"><li><a class="tag">Harry Potter - J. K. Rowling</a></li></ul></dd>
    <dd class="rating tags"><ul class="commas"><li><a class="tag">Explicit</a></li></ul></dd>
    <dd class="warning tags"><ul class="commas"><li><a class="tag">No Archive Warnings Apply</a></li></ul></dd>
    <dd class="relationship tags"><ul class="commas"><li><a class="tag">Hermione Granger/Draco Malfoy</a></li></ul></dd>
    <dd class="character tags"><ul class="commas">
      <li><a class="tag">Hermione Granger</a></li><li><a class="tag">Draco Malfoy</a></li></ul></dd>
    <dd class="freeform tags"><ul class="commas">
      <li><a class="tag">Enemies to Lovers</a></li><li><a class="tag">Slow Burn</a></li></ul></dd>
  </dl>
  <dl class="stats">
    <dd class="words">50,123</dd><dd class="chapters">5/5</dd><dd class="kudos">1,234</dd>
  </dl>`

// Mirrors AO3's real full-work markup: each chapter is a `<div class="chapter">`
// containing a `<div class="chapter preface group">` (which ALSO carries the
// `chapter` class) that holds the title and — when present — a summary rendered
// as its own `.userstuff`, followed by the actual chapter text in a
// `.userstuff.module[role="article"]`. A summary-less chapter has a preface with
// no `.userstuff` at all (the "blank chapter" trigger). Single-chapter works have
// no `.chapter` wrapper — the content sits directly under `#chapters`.
function chapterBlock(body: string, i: number, summary: boolean): string {
  return `
    <div class="chapter" id="chapter-${i + 1}">
      <div class="chapter preface group">
        <h3 class="title"><a href="/works/1/chapters/${i + 1}">Chapter ${i + 1}</a>: Title ${i + 1}</h3>
        ${
          summary
            ? `<div id="summary" class="summary module"><h3 class="heading">Summary:</h3>
               <blockquote class="userstuff">Summary of chapter ${i + 1}.</blockquote></div>`
            : ''
        }
      </div>
      <div class="userstuff module" role="article">
        <h3 class="landmark heading" id="work">Chapter Text</h3>
        ${body}
      </div>
    </div>`
}

function ao3Page(
  chapters: string[],
  opts: { next?: boolean; ogImage?: string; meta?: boolean; summaries?: boolean } = {},
): string {
  const inner =
    chapters.length > 1
      ? // Multi-chapter: alternate summary/no-summary so both the summary-capture
        // and the blank-preface paths are exercised.
        chapters.map((body, i) => chapterBlock(body, i, opts.summaries ?? i % 2 === 0)).join('')
      : `<h3 class="landmark heading" id="work">Work Text:</h3>
         <div class="userstuff" role="article">${chapters[0]}</div>`
  return `<!DOCTYPE html><html><head>
    ${opts.ogImage ? `<meta property="og:image" content="${opts.ogImage}">` : ''}
  </head><body>
    <h2 class="title heading">My Great Work</h2>
    <h3 class="byline heading"><a rel="author" href="/users/x">Author X</a></h3>
    ${opts.meta ? AO3_META : `<dd class="chapters">${chapters.length}/${chapters.length}</dd>`}
    <div id="workskin"><div id="chapters" role="article">${inner}</div></div>
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
      ao3Page(['<p>The body.</p><script>evil()</script>'], {
        ogImage: 'https://ao3.org/cover.jpg',
      }),
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
    mockFetchPage.mockResolvedValue(ao3Page(['<p>One.</p>', '<p>Two.</p>', '<p>Three.</p>']))
    const result = await captureAo3('https://archiveofourown.org/works/9')
    const blocks = result.html.match(/class="chapter"/g) ?? []
    expect(blocks.length).toBe(3)
    expect(result.html).toContain('One.')
    expect(result.html).toContain('Three.')
  })

  // Regression: AO3's per-chapter preface/notes blocks also carry the `chapter`
  // class, so a descendant `#chapters .chapter` selector scooped them up as extra
  // "chapters" — producing a blank chapter after every real one (flip to ch2 →
  // blank → flip again → real ch2). And because a chapter summary renders as a
  // `.userstuff` *before* the content, a bare `.userstuff` grabbed the summary as
  // the chapter body. Both are fixed by `#chapters > .chapter` + `.userstuff[role]`.
  it('emits exactly one block per real chapter and captures content, not prefaces/summaries', async () => {
    mockFetchPage.mockResolvedValue(
      ao3Page(['<p>Real one.</p>', '<p>Real two.</p>', '<p>Real three.</p>']),
    )
    const result = await captureAo3('https://archiveofourown.org/works/42')

    // Exactly three chapter blocks — no blank prefaces/notes inflating the count.
    const blocks = result.html.match(/class="chapter"/g) ?? []
    expect(blocks.length).toBe(3)
    // No empty chapter bodies.
    expect(result.html).not.toMatch(/<div class="chapter-content">\s*<\/div>/)
    // Real content is captured…
    expect(result.html).toContain('Real one.')
    expect(result.html).toContain('Real two.')
    expect(result.html).toContain('Real three.')
    // …and the summary (which precedes the content in the DOM) is not.
    expect(result.html).not.toContain('Summary of chapter')
  })

  it('honors a chapter range, slicing to the requested window', async () => {
    mockFetchPage.mockResolvedValue(ao3Page(['<p>One.</p>', '<p>Two.</p>', '<p>Three.</p>']))
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

  it('surfaces native AO3 tags + stats on the captured content (F1)', async () => {
    mockFetchPage.mockResolvedValue(ao3Page(['<p>x</p>'], { meta: true }))
    const result = await captureAo3('https://archiveofourown.org/works/5')
    expect(result.sourceTags).toContainEqual({ name: 'Enemies to Lovers', category: 'freeform' })
    expect(result.sourceTags).toContainEqual({
      name: 'Hermione Granger/Draco Malfoy',
      category: 'relationship',
    })
    expect(result.sourceMeta).toMatchObject({ kudos: 1234, words: 50123, status: 'complete' })
  })
})

describe('parseAo3Metadata', () => {
  const docOf = (html: string) => new JSDOM(html).window.document

  it('extracts categorized tags and stats from the work page', () => {
    const { tags, meta } = parseAo3Metadata(docOf(AO3_META))
    expect(tags).toContainEqual({ name: 'Harry Potter - J. K. Rowling', category: 'fandom' })
    expect(tags).toContainEqual({ name: 'Hermione Granger/Draco Malfoy', category: 'relationship' })
    expect(tags.filter((t) => t.category === 'character').map((t) => t.name)).toEqual([
      'Hermione Granger',
      'Draco Malfoy',
    ])
    expect(tags.filter((t) => t.category === 'freeform').map((t) => t.name)).toEqual([
      'Enemies to Lovers',
      'Slow Burn',
    ])
    expect(meta).toMatchObject({
      rating: 'Explicit',
      kudos: 1234,
      words: 50123,
      status: 'complete',
    })
  })

  it('marks a WIP work in-progress and tolerates a missing meta block', () => {
    expect(parseAo3Metadata(docOf('<dd class="chapters">3/?</dd>')).meta.status).toBe('in-progress')
    const empty = parseAo3Metadata(docOf('<p>no metadata here</p>'))
    expect(empty.tags).toEqual([])
    expect(empty.meta).toEqual({})
  })
})
