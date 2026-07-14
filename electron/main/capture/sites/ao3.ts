import { JSDOM } from 'jsdom'
import { sanitize } from '../sanitizer'
import { fetchPage, fetchPagesWithSession } from '../fetch'
import type { SiteContent, SourceTag, SourceMeta, TagCategory } from '../fetch'
import type { ChapterRange } from '../index'

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const MAX_AO3_PAGES = 50

// ── Native metadata extraction (F1) ──────────────────────────────────────────
// AO3 renders a `dl.work.meta` tag block and a `dl.stats` block on the work page.
// captureAo3 already has that DOM in hand — parseAo3Metadata lifts the structured
// tags (fandom/relationship/character/freeform/warning) + stats (rating, kudos,
// words, complete-vs-WIP) that the recommender needs. Pure + defensive: every
// field is optional, so a layout change or a missing block yields a partial (or
// empty) result rather than throwing.

/** Parse "12,345" → 12345, or null for empty / non-numeric text. */
function parseIntLoose(text: string | null | undefined): number | null {
  const digits = (text ?? '').replace(/[^0-9]/g, '')
  if (!digits) return null
  const n = parseInt(digits, 10)
  return Number.isFinite(n) ? n : null
}

/** All `a.tag` texts under a `dd.<category>` group, as SourceTags. */
function collectAo3Tags(doc: Document, selector: string, category: TagCategory): SourceTag[] {
  return Array.from(doc.querySelectorAll(selector))
    .map((el) => el.textContent?.trim())
    .filter((t): t is string => !!t)
    .map((name) => ({ name, category }))
}

/** AO3 `dd.chapters` text is "X/Y": "5/?" or "5/10" → WIP, "5/5" → complete. */
function ao3Status(chaptersText: string): SourceMeta['status'] | undefined {
  const m = /^(\d+)\s*\/\s*(\S+)$/.exec(chaptersText.trim())
  if (!m) return undefined
  if (m[2] === '?') return 'in-progress'
  return m[1] === m[2] ? 'complete' : 'in-progress'
}

export function parseAo3Metadata(doc: Document): { tags: SourceTag[]; meta: SourceMeta } {
  const tags: SourceTag[] = [
    ...collectAo3Tags(doc, 'dd.fandom a.tag', 'fandom'),
    ...collectAo3Tags(doc, 'dd.relationship a.tag', 'relationship'),
    ...collectAo3Tags(doc, 'dd.character a.tag', 'character'),
    ...collectAo3Tags(doc, 'dd.freeform a.tag', 'freeform'),
    ...collectAo3Tags(doc, 'dd.warning a.tag', 'warning'),
  ]

  const meta: SourceMeta = {}
  const rating = doc.querySelector('dd.rating a.tag')?.textContent?.trim()
  if (rating) meta.rating = rating
  const kudos = parseIntLoose(doc.querySelector('dd.kudos')?.textContent)
  if (kudos != null) meta.kudos = kudos
  const words = parseIntLoose(doc.querySelector('dd.words')?.textContent)
  if (words != null) meta.words = words
  const status = ao3Status(doc.querySelector('dd.chapters')?.textContent ?? '')
  if (status) meta.status = status

  return { tags, meta }
}

// ── Chapter-count check (lightweight) ────────────────────────────────────────
// Fetches just the first chapter page (not full work) to read the metadata
// block which is server-rendered and shows "posted/planned" chapter counts.
export async function getAo3ChapterCount(url: string): Promise<number | null> {
  const m = /\/works\/(\d+)/.exec(url)
  if (!m) return null
  try {
    const html = await fetchPage(`https://archiveofourown.org/works/${m[1]}`)
    const doc = new JSDOM(html).window.document
    // "dd.chapters" text is "X/Y" (complete) or "X/?" (WIP) — X = posted count.
    const text = doc.querySelector('dd.chapters')?.textContent?.trim() ?? ''
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
  const page1Url = `https://archiveofourown.org/works/${workId}?view_full_work=true`
  onProgress?.('Fetching story from AO3…')
  const page1Html = await fetchPage(page1Url)
  const page1Doc = new JSDOM(page1Html, { url: page1Url }).window.document

  const title = page1Doc.querySelector('.title.heading')?.textContent?.trim() ?? 'Unknown Work'
  const author =
    page1Doc.querySelector('.byline.heading a[rel="author"]')?.textContent?.trim() ?? null
  const ogImg = page1Doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null
  const coverUrl =
    ogImg && !ogImg.includes('/ao3_logos') && !ogImg.includes('/images/') ? ogImg : null

  // NB: `#chapters > .chapter` (direct children only). AO3's per-chapter preface
  // and end-note blocks also carry the `chapter` class (`div.chapter.preface.group`),
  // so a descendant `#chapters .chapter` scoops them up too — inserting a blank
  // "chapter" (no `.userstuff` content) after every real one. The child combinator
  // matches only the real chapter containers.
  const allChapterEls: Element[] = Array.from(page1Doc.querySelectorAll('#chapters > .chapter'))
  const textParts: string[] = [page1Doc.querySelector('#workskin')?.textContent ?? '']

  // ── Remaining pages: batch fetch in parallel ──────────────────────────────
  // Determine total page count from the highest page number in pagination links.
  const needsMore =
    !!page1Doc.querySelector('a[rel="next"]') && !(range && allChapterEls.length >= range.end)

  if (needsMore) {
    // Find the highest page number from any pagination anchor
    let maxPage = 1
    for (const a of Array.from(
      page1Doc.querySelectorAll<HTMLAnchorElement>('ol.pagination a[href*="page="]'),
    )) {
      const pm = /[?&]page=(\d+)/.exec(a.getAttribute('href') ?? '')
      if (pm) maxPage = Math.max(maxPage, parseInt(pm[1], 10))
    }
    // Clamp to safety limit
    maxPage = Math.min(maxPage, MAX_AO3_PAGES)

    if (maxPage > 1) {
      const remainingUrls = Array.from(
        { length: maxPage - 1 },
        (_, i) => `https://archiveofourown.org/works/${workId}?view_full_work=true&page=${i + 2}`,
      )

      onProgress?.(`Fetching ${maxPage} pages in parallel…`)
      const pages = await fetchPagesWithSession(remainingUrls, 200, (i) => {
        onProgress?.(`Fetching AO3 page ${i + 2} of ${maxPage}…`)
      })

      for (const html of pages) {
        if (!html) continue
        const doc = new JSDOM(html).window.document
        allChapterEls.push(...Array.from(doc.querySelectorAll('#chapters > .chapter')))
        textParts.push(doc.querySelector('#workskin')?.textContent ?? '')
        if (range && allChapterEls.length >= range.end) break
      }
    } else {
      // Pagination present but max page not parseable — fall back to sequential
      for (let page = 2; page <= MAX_AO3_PAGES; page++) {
        const pageUrl = `https://archiveofourown.org/works/${workId}?view_full_work=true&page=${page}`
        onProgress?.(`Fetching AO3 chapters (page ${page})…`)
        const html = await fetchPage(pageUrl)
        const doc = new JSDOM(html, { url: pageUrl }).window.document
        allChapterEls.push(...Array.from(doc.querySelectorAll('#chapters > .chapter')))
        textParts.push(doc.querySelector('#workskin')?.textContent ?? '')
        if (range && allChapterEls.length >= range.end) break
        if (!doc.querySelector('a[rel="next"]')) break
      }
    }
  }

  // ── Slice to range and assemble ───────────────────────────────────────────
  const rangedEls = range ? allChapterEls.slice(range.start - 1, range.end) : allChapterEls

  // Sanitize each chapter's untrusted content individually, then wrap it in
  // the trusted div.chapter marker AFTER sanitizing — sanitizing the fully
  // assembled string would strip the class attribute (sanitizer.ts omits
  // class/id to prevent clickjacking) and break multi-chapter file splitting
  // (extractChapterDivs in capture/index.ts depends on div.chapter surviving).
  let assembled: string
  if (rangedEls.length > 1) {
    assembled = rangedEls
      .map((el, i) => {
        const chapterTitle =
          el.querySelector('h3.title')?.textContent?.trim() ?? `Chapter ${(range?.start ?? 1) + i}`
        // The chapter *text* is the `role="article"` userstuff. A chapter with a
        // summary/notes renders those as their own `.userstuff` earlier in the DOM,
        // so a bare `.userstuff` would capture the summary instead of the content.
        const contentEl =
          el.querySelector('.userstuff[role="article"]') ??
          el.querySelector('.userstuff.module') ??
          el.querySelector('.userstuff')
        const content = sanitize(contentEl?.innerHTML ?? '')
        return `<div class="chapter">
<h2 class="chapter-title">${escHtml(chapterTitle)}</h2>
<div class="chapter-content">${content}</div>
</div>`
      })
      .join('\n')
  } else {
    const userstuff = page1Doc.querySelector('#chapters .userstuff, .userstuff[role="article"]')
    assembled = sanitize(userstuff?.innerHTML ?? '')
  }

  // Native tags + stats come from the work page (page 1); the recommender reads
  // them post-capture (F2 persistence).
  const { tags, meta } = parseAo3Metadata(page1Doc)

  return {
    title,
    author,
    html: assembled,
    textContent: textParts.join(' '),
    coverUrl,
    sourceTags: tags,
    sourceMeta: meta,
  }
}
