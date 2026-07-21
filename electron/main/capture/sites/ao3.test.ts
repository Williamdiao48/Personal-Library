import { describe, it, expect, vi, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'

// captureAo3's only coupling is the network layer (fetch.ts). Mock it and feed
// AO3-shaped HTML so the real extraction / sanitize / multi-chapter assembly /
// range-slicing logic runs without a BrowserWindow or network.
vi.mock('../fetch', () => ({
  fetchPage: vi.fn(),
  fetchPagesWithSession: vi.fn(),
}))

import { captureAo3, parseAo3Metadata, getAo3ChapterCount } from './ao3'
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

// A minimal multi-page work builder: every page carries real `#chapters > .chapter`
// blocks so allChapterEls accumulates across pages. `pagination` emits the
// `ol.pagination` anchors captureAo3 reads to size the parallel batch; `next`
// emits the `a[rel="next"]` that gates whether more pages are fetched at all.
function paginatedPage(
  bodies: string[],
  opts: { next?: boolean; pagination?: number[]; titled?: boolean } = {},
): string {
  const chapters = bodies
    .map(
      (b, i) => `
      <div class="chapter" id="ch-${i}">
        <div class="chapter preface group">
          ${opts.titled === false ? '' : `<h3 class="title">Chapter ${i + 1}</h3>`}
        </div>
        <div class="userstuff module" role="article">${b}</div>
      </div>`,
    )
    .join('')
  const pag = opts.pagination
    ? `<ol class="pagination">${opts.pagination
        .map((p) => `<li><a href="?page=${p}">${p}</a></li>`)
        .join('')}</ol>`
    : ''
  return `<!DOCTYPE html><html><head></head><body>
    <h2 class="title heading">Work</h2>
    <h3 class="byline heading"><a rel="author" href="/users/x">Author</a></h3>
    <dd class="chapters">${bodies.length}/${bodies.length}</dd>
    <div id="workskin"><div id="chapters">${chapters}</div></div>
    ${pag}
    ${opts.next ? '<a rel="next" href="?page=2">Next</a>' : ''}
  </body></html>`
}

describe('captureAo3 — multi-page fetch', () => {
  it('batch-fetches the remaining pages in parallel using the pagination page count', async () => {
    mockFetchPage.mockResolvedValue(
      paginatedPage(['<p>Page1 chapter.</p>'], { next: true, pagination: [1, 2, 3] }),
    )
    mockFetchPages.mockImplementation((_urls, _delay, onProgress?: (i: number) => void) => {
      onProgress?.(0) // exercises the per-page progress-forwarding callback
      return Promise.resolve([
        paginatedPage(['<p>Page2 chapter.</p>']),
        paginatedPage(['<p>Page3 chapter.</p>']),
      ])
    })

    const progress: string[] = []
    const result = await captureAo3('https://archiveofourown.org/works/77', (m) => progress.push(m))

    // Two remaining pages (page 2 and page 3) fetched in one parallel batch.
    expect(mockFetchPages).toHaveBeenCalledOnce()
    expect(mockFetchPages.mock.calls[0][0]).toEqual([
      'https://archiveofourown.org/works/77?view_full_work=true&page=2',
      'https://archiveofourown.org/works/77?view_full_work=true&page=3',
    ])
    // Content from all three pages is assembled into chapter blocks.
    const blocks = result.html.match(/class="chapter"/g) ?? []
    expect(blocks.length).toBe(3)
    expect(result.html).toContain('Page1 chapter.')
    expect(result.html).toContain('Page3 chapter.')
    expect(progress.some((m) => /parallel/i.test(m))).toBe(true)
  })

  it('stops the parallel batch early once the requested chapter range is satisfied', async () => {
    mockFetchPage.mockResolvedValue(
      paginatedPage(['<p>C1.</p>'], { next: true, pagination: [1, 2, 3] }),
    )
    mockFetchPages.mockResolvedValue([
      paginatedPage(['<p>C2.</p>']),
      paginatedPage(['<p>C3.</p>']),
    ])
    const result = await captureAo3('https://archiveofourown.org/works/8', undefined, {
      start: 1,
      end: 2,
    })
    expect(result.html).toContain('C1.')
    expect(result.html).toContain('C2.')
    expect(result.html).not.toContain('C3.') // sliced out — batch broke at range.end
  })

  it('falls back to sequential paging when the page count is not parseable', async () => {
    // rel="next" present but NO ol.pagination anchors → maxPage stays 1 → the
    // sequential fallback loop fetches page 2, then stops (page 2 has no next).
    mockFetchPage
      .mockResolvedValueOnce(paginatedPage(['<p>Seq1.</p>'], { next: true }))
      .mockResolvedValueOnce(paginatedPage(['<p>Seq2.</p>'], { next: false }))

    const result = await captureAo3('https://archiveofourown.org/works/99')

    expect(mockFetchPage).toHaveBeenCalledTimes(2)
    expect(mockFetchPages).not.toHaveBeenCalled()
    const blocks = result.html.match(/class="chapter"/g) ?? []
    expect(blocks.length).toBe(2)
    expect(result.html).toContain('Seq1.')
    expect(result.html).toContain('Seq2.')
  })

  it('falls back to .userstuff.module when a chapter body lacks role="article"', async () => {
    // Content element selection is `.userstuff[role="article"]` ?? `.userstuff.module`
    // ?? `.userstuff`. Two chapters whose bodies are bare `.userstuff.module`
    // (no role) exercise the second selector in that chain.
    const chapter = (b: string, i: number) => `
      <div class="chapter" id="ch-${i}">
        <div class="chapter preface group"><h3 class="title">Chapter ${i + 1}</h3></div>
        <div class="userstuff module">${b}</div>
      </div>`
    mockFetchPage.mockResolvedValue(`<!DOCTYPE html><html><body>
      <h2 class="title heading">Work</h2>
      <h3 class="byline heading"><a rel="author" href="/u">A</a></h3>
      <dd class="chapters">2/2</dd>
      <div id="workskin"><div id="chapters">${chapter('<p>Body A.</p>', 0)}${chapter('<p>Body B.</p>', 1)}</div></div>
    </body></html>`)
    const result = await captureAo3('https://archiveofourown.org/works/66')
    expect(result.html).toContain('Body A.')
    expect(result.html).toContain('Body B.')
  })

  it('synthesizes a title from the chapter index when a chapter has no heading', async () => {
    // A multi-chapter work whose chapters carry no <h3 class="title"> → the
    // assembler synthesizes "Chapter N" from the (range-adjusted) index rather
    // than emitting a titleless block.
    mockFetchPage.mockResolvedValue(
      paginatedPage(['<p>First body.</p>', '<p>Second body.</p>'], { titled: false }),
    )
    const result = await captureAo3('https://archiveofourown.org/works/55')
    expect(result.html).toContain('First body.')
    expect(result.html).toContain('Second body.')
    expect(result.html).toContain('Chapter 1') // synthesized
    expect(result.html).toContain('Chapter 2') // synthesized fallback title
  })
})

describe('getAo3ChapterCount', () => {
  it('returns the posted chapter count from the "X/Y" chapters stat', async () => {
    mockFetchPage.mockResolvedValue('<dd class="chapters">7/12</dd>')
    expect(await getAo3ChapterCount('https://archiveofourown.org/works/123')).toBe(7)
  })

  it('reads the posted count for a WIP work ("X/?")', async () => {
    mockFetchPage.mockResolvedValue('<dd class="chapters">3/?</dd>')
    expect(await getAo3ChapterCount('https://archiveofourown.org/works/123/chapters/9')).toBe(3)
  })

  it('returns null when the URL has no parseable work id (no fetch)', async () => {
    expect(await getAo3ChapterCount('https://archiveofourown.org/tags/foo')).toBeNull()
    expect(mockFetchPage).not.toHaveBeenCalled()
  })

  it('returns null when the chapters stat is absent', async () => {
    mockFetchPage.mockResolvedValue('<html><body>no stats here</body></html>')
    expect(await getAo3ChapterCount('https://archiveofourown.org/works/1')).toBeNull()
  })

  it('degrades to null when the fetch throws', async () => {
    mockFetchPage.mockRejectedValue(new Error('network down'))
    expect(await getAo3ChapterCount('https://archiveofourown.org/works/1')).toBeNull()
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
