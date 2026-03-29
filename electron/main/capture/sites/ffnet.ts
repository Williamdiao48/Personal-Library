import { JSDOM } from 'jsdom'
import { sanitize } from '../sanitizer'
import { fetchPageWithBrowser, fetchPagesSequential, fetchPagesWithSession } from '../fetch'
import type { SiteContent } from '../fetch'
import type { ChapterRange } from '../index'

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// FF.net URL: https://www.fanfiction.net/s/{storyId}/{chapter}/{slug}
const FFN_PATH_RE = /\/s\/(\d+)\/\d+\/?([^/?#]*)/

function extractChapter(doc: Document, chapterNum: number): { html: string; text: string } {
  // Chapter title from the selected option: "N. Title" or just "N"
  const selectedOption = doc.querySelector('select#chap_select option[selected]')
  const rawTitle = selectedOption?.textContent?.trim() ?? ''
  const chapterTitle = /^\d+\.\s+(.+)$/.exec(rawTitle)?.[1]?.trim() ?? `Chapter ${chapterNum}`

  const content = doc.querySelector('#storytext')?.innerHTML ?? ''
  const text    = doc.querySelector('#storytext')?.textContent ?? ''

  const html = `<div class="chapter">
<h2 class="chapter-title">${escHtml(chapterTitle)}</h2>
<div class="chapter-content">${content}</div>
</div>`

  return { html, text }
}

// FF.net chapters are on separate pages and the site blocks plain HTTP fetches.
// We use a single BrowserWindow (real Chromium) that navigates chapter-by-chapter —
// faster than creating a new window each time because the session and cookies persist.
export async function captureFfnet(
  url: string,
  onProgress?: (msg: string) => void,
  range?: ChapterRange,
): Promise<SiteContent> {
  const match = FFN_PATH_RE.exec(url)
  if (!match) throw new Error('Could not parse fanfiction.net story ID from URL.')
  const [, storyId, slug] = match

  // Always start from chapter 1 so we get the full story metadata
  const ch1Url = `https://www.fanfiction.net/s/${storyId}/1/${slug}`

  // Load chapter 1 via a real BrowserWindow. This passes the CloudFlare JS
  // challenge and stores the resulting cf_clearance cookie in
  // session.defaultSession, which fetchPagesWithSession will then reuse.
  onProgress?.('Detecting chapter count…')
  const ch1Html = await fetchPageWithBrowser(ch1Url)
  const ch1Doc = new JSDOM(ch1Html, { url: ch1Url }).window.document

  const title  = ch1Doc.querySelector('#profile_top b.xcontrast_txt')?.textContent?.trim() ?? 'Unknown Story'
  const author = ch1Doc.querySelector('#profile_top a.xcontrast_txt[href*="/u/"]')?.textContent?.trim() ?? null

  // Chapter count: cross-check two sources and take the larger one.
  //
  // 1. select#chap_select options — rendered by JS; may be incomplete if
  //    did-finish-load fires before the nav script has run.
  // 2. "Chapters: N" in the story metadata block — server-rendered plain text,
  //    present even before any JS executes, so it's always reliable.
  //
  // Taking the max defends against JS-incomplete selects that under-count.
  const selectCount  = ch1Doc.querySelector('select#chap_select')?.querySelectorAll('option').length ?? 0
  const metaText     = ch1Doc.querySelector('#profile_top')?.textContent ?? ''
  const metaCount    = parseInt(/Chapters:\s*(\d+)/i.exec(metaText)?.[1] ?? '0', 10)
  const chapterCount = Math.max(selectCount, metaCount) || 1

  const effectiveStart = range?.start ?? 1
  const effectiveEnd   = range ? Math.min(range.end, chapterCount) : chapterCount

  const chapterHtmlParts: string[] = []
  const chapterTextParts: string[] = []

  // Include chapter 1 content only if the range starts at 1
  if (effectiveStart === 1) {
    onProgress?.(`Fetching chapter 1 of ${effectiveEnd}…`)
    const ch1 = extractChapter(ch1Doc, 1)
    chapterHtmlParts.push(ch1.html)
    chapterTextParts.push(ch1.text)
  }

  // Fetch remaining chapters via session.fetch() — plain HTTP with the CF
  // cookies already in session.defaultSession. No rendering overhead means
  // each chapter takes ~150–400ms instead of ~2000ms (8–10× faster).
  const rangeStart = Math.max(effectiveStart, 2)
  if (effectiveEnd >= rangeStart) {
    const remainingUrls = Array.from({ length: effectiveEnd - rangeStart + 1 }, (_, i) =>
      `https://www.fanfiction.net/s/${storyId}/${rangeStart + i}/${slug}`
    )
    // maxConsecutiveFailures=5: tolerate brief blips but bail fast once CF
    // consistently rate-limits so the browser batch-refetch takes over without
    // waiting 12+ seconds per chapter on the retry backoff.
    const pages = await fetchPagesWithSession(remainingUrls, 200, (idx) => {
      onProgress?.(`Fetching chapter ${rangeStart + idx} of ${effectiveEnd}…`)
    }, 5)

    // CF soft-blocks return 200 OK with a challenge page that has no #storytext.
    // Parse all pages first, collect blocked indices, then re-fetch them all in
    // a single fetchPagesSequential call — one shared BrowserWindow is far cheaper
    // than spawning a new window per chapter.
    const parsedDocs = pages.map((html, i) =>
      new JSDOM(html, { url: remainingUrls[i] }).window.document
    )

    const blockedIndices = parsedDocs
      .map((doc, i) => (doc.querySelector('#storytext') ? -1 : i))
      .filter(i => i >= 0)

    if (blockedIndices.length > 0) {
      onProgress?.(`Re-fetching ${blockedIndices.length} blocked chapter(s)…`)
      const blockedUrls = blockedIndices.map(i => remainingUrls[i])
      const rePages = await fetchPagesSequential(blockedUrls, 150, (j) => {
        onProgress?.(`Re-fetching chapter ${blockedIndices[j] + rangeStart} of ${effectiveEnd}…`)
      })
      rePages.forEach((html, j) => {
        const i = blockedIndices[j]
        parsedDocs[i] = new JSDOM(html, { url: remainingUrls[i] }).window.document
      })
    }

    parsedDocs.forEach((doc, i) => {
      const { html: chHtml, text } = extractChapter(doc, rangeStart + i)
      chapterHtmlParts.push(chHtml)
      chapterTextParts.push(text)
    })
  }

  // FFN story cover is an <img> inside #profile_top (absent when no cover is set).
  // URLs are protocol-relative (//img.fanfiction.net/…) — make them absolute.
  const rawCover = ch1Doc.querySelector('#profile_top img')?.getAttribute('src') ?? null
  const coverUrl = rawCover ? new URL(rawCover, 'https://www.fanfiction.net').href : null

  return {
    title,
    author,
    html: sanitize(chapterHtmlParts.join('\n')),
    textContent: chapterTextParts.join(' '),
    coverUrl,
  }
}
