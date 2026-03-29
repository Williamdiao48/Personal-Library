import { JSDOM } from 'jsdom'
import { sanitize } from '../sanitizer'
import { fetchPage, fetchPagesWithSession } from '../fetch'
import type { SiteContent } from '../fetch'
import type { ChapterRange } from '../index'

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const MAX_AO3_PAGES = 50

// ── Chapter-count check (lightweight) ────────────────────────────────────────
// Fetches just the first chapter page (not full work) to read the metadata
// block which is server-rendered and shows "posted/planned" chapter counts.
export async function getAo3ChapterCount(url: string): Promise<number | null> {
  const m = /\/works\/(\d+)/.exec(url)
  if (!m) return null
  try {
    const html = await fetchPage(`https://archiveofourown.org/works/${m[1]}`)
    const doc  = new JSDOM(html).window.document
    // "dd.chapters" text is "X/Y" (complete) or "X/?" (WIP) — X = posted count.
    const text  = doc.querySelector('dd.chapters')?.textContent?.trim() ?? ''
    const match = /^(\d+)/.exec(text)
    return match ? parseInt(match[1], 10) : null
  } catch {
    return null
  }
}

// ── Full capture ──────────────────────────────────────────────────────────────

export async function captureAo3(
  url: string,
  onProgress?: (msg: string) => void,
  range?: ChapterRange,
): Promise<SiteContent> {
  const workIdMatch = /\/works\/(\d+)/.exec(url)
  if (!workIdMatch) throw new Error('Could not parse AO3 work ID from URL.')
  const workId = workIdMatch[1]

  // ── Page 1: metadata + first batch of chapters ────────────────────────────
  const page1Url  = `https://archiveofourown.org/works/${workId}?view_full_work=true`
  onProgress?.('Fetching story from AO3…')
  const page1Html = await fetchPage(page1Url)
  const page1Doc  = new JSDOM(page1Html, { url: page1Url }).window.document

  const title = page1Doc.querySelector('.title.heading')?.textContent?.trim() ?? 'Unknown Work'
  const author = page1Doc.querySelector('.byline.heading a[rel="author"]')?.textContent?.trim() ?? null
  const ogImg  = page1Doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null
  const coverUrl = ogImg && !ogImg.includes('/ao3_logos') && !ogImg.includes('/images/') ? ogImg : null

  const allChapterEls: Element[] = Array.from(page1Doc.querySelectorAll('#chapters .chapter'))
  const textParts: string[]      = [page1Doc.querySelector('#workskin')?.textContent ?? '']

  // ── Remaining pages: batch fetch in parallel ──────────────────────────────
  // Determine total page count from the highest page number in pagination links.
  const needsMore = !!page1Doc.querySelector('a[rel="next"]') &&
    !(range && allChapterEls.length >= range.end)

  if (needsMore) {
    // Find the highest page number from any pagination anchor
    let maxPage = 1
    for (const a of Array.from(page1Doc.querySelectorAll<HTMLAnchorElement>('ol.pagination a[href*="page="]'))) {
      const pm = /[?&]page=(\d+)/.exec(a.getAttribute('href') ?? '')
      if (pm) maxPage = Math.max(maxPage, parseInt(pm[1], 10))
    }
    // Clamp to safety limit
    maxPage = Math.min(maxPage, MAX_AO3_PAGES)

    if (maxPage > 1) {
      const remainingUrls = Array.from({ length: maxPage - 1 }, (_, i) =>
        `https://archiveofourown.org/works/${workId}?view_full_work=true&page=${i + 2}`,
      )

      onProgress?.(`Fetching ${maxPage} pages in parallel…`)
      const pages = await fetchPagesWithSession(remainingUrls, 200, (i) => {
        onProgress?.(`Fetching AO3 page ${i + 2} of ${maxPage}…`)
      })

      for (const html of pages) {
        if (!html) continue
        const doc = new JSDOM(html).window.document
        allChapterEls.push(...Array.from(doc.querySelectorAll('#chapters .chapter')))
        textParts.push(doc.querySelector('#workskin')?.textContent ?? '')
        if (range && allChapterEls.length >= range.end) break
      }
    } else {
      // Pagination present but max page not parseable — fall back to sequential
      for (let page = 2; page <= MAX_AO3_PAGES; page++) {
        const pageUrl = `https://archiveofourown.org/works/${workId}?view_full_work=true&page=${page}`
        onProgress?.(`Fetching AO3 chapters (page ${page})…`)
        const html = await fetchPage(pageUrl)
        const doc  = new JSDOM(html, { url: pageUrl }).window.document
        allChapterEls.push(...Array.from(doc.querySelectorAll('#chapters .chapter')))
        textParts.push(doc.querySelector('#workskin')?.textContent ?? '')
        if (range && allChapterEls.length >= range.end) break
        if (!doc.querySelector('a[rel="next"]')) break
      }
    }
  }

  // ── Slice to range and assemble ───────────────────────────────────────────
  const rangedEls = range ? allChapterEls.slice(range.start - 1, range.end) : allChapterEls

  let assembled: string
  if (rangedEls.length > 1) {
    assembled = rangedEls.map((el, i) => {
      const chapterTitle = el.querySelector('h3.title')?.textContent?.trim() ?? `Chapter ${(range?.start ?? 1) + i}`
      const content      = el.querySelector('.userstuff')?.innerHTML ?? ''
      return `<div class="chapter">
<h2 class="chapter-title">${escHtml(chapterTitle)}</h2>
<div class="chapter-content">${content}</div>
</div>`
    }).join('\n')
  } else {
    const userstuff = page1Doc.querySelector('#chapters .userstuff, .userstuff[role="article"]')
    assembled = userstuff?.innerHTML ?? ''
  }

  return {
    title,
    author,
    html:        sanitize(assembled),
    textContent: textParts.join(' '),
    coverUrl,
  }
}
