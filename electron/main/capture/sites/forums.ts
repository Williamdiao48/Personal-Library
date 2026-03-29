import { JSDOM } from 'jsdom'
import { sanitize } from '../sanitizer'
import { fetchPage, fetchPagesWithSession } from '../fetch'
import type { SiteContent } from '../fetch'
import type { ChapterRange } from '../index'

// Handles Sufficient Velocity (forums.sufficientvelocity.com) and
// Spacebattles (forums.spacebattles.com) — both run XenForo 2 with
// the same threadmarks system.
//
// Strategy:
//   1. Resolve the thread's threadmarks page from any thread URL.
//   2. Collect all threadmark post permalinks (handles pagination).
//   3. Batch-fetch each post page; each permalink redirects to the thread page
//      containing that post — extract the specific <article> from the result.
//   4. Assemble chapters from post bodies (.bbWrapper).

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Matches thread URLs on either host.
// Groups: (host, threadSlug, threadId)
const XENFORO_THREAD_RE =
  /https?:\/\/(forums\.sufficientvelocity\.com|forums\.spacebattles\.com)\/(threads\/[^/?#]+\.(\d+))/

export async function captureXenForo(
  url: string,
  onProgress?: (msg: string) => void,
  range?: ChapterRange,
): Promise<SiteContent> {
  const m = XENFORO_THREAD_RE.exec(url)
  if (!m) throw new Error('Could not parse Sufficient Velocity / Spacebattles thread URL.')
  const [, host, threadPath] = m

  const threadBase     = `https://${host}/${threadPath}/`
  const threadmarksUrl = `${threadBase}threadmarks`

  onProgress?.('Fetching threadmarks…')
  const postLinks = await collectThreadmarkLinks(threadmarksUrl, onProgress)
  if (postLinks.length === 0) throw new Error('No threadmarks found for this thread.')

  const rangedLinks = range ? postLinks.slice(range.start - 1, range.end) : postLinks
  onProgress?.(`Found ${rangedLinks.length} chapters…`)

  // Resolve metadata from the thread's first page
  const firstPageHtml = await fetchPage(threadBase)
  const firstPageDoc  = new JSDOM(firstPageHtml, { url: threadBase }).window.document

  const title  = firstPageDoc.querySelector('h1.p-title-value')?.textContent?.trim()
    ?? firstPageDoc.querySelector('h1')?.textContent?.trim()
    ?? 'Unknown Story'
  const author = firstPageDoc.querySelector('.username')?.textContent?.trim() ?? null
  const coverUrl = firstPageDoc.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null

  // Batch-fetch post pages.  Each permalink resolves to the thread page
  // containing that post, so we need to extract only the target post.
  const pages = await fetchPagesWithSession(rangedLinks, 300, (i) => {
    onProgress?.(`Fetching chapter ${i + 1} of ${rangedLinks.length}…`)
  })

  const chapters: { title: string; html: string; text: string }[] = []
  for (let i = 0; i < pages.length; i++) {
    const html = pages[i]
    if (!html) continue

    // Extract post ID from the permalink URL (ends in /post-NNN)
    const postIdMatch = /post-(\d+)$/.exec(rangedLinks[i])
    const postId      = postIdMatch?.[1]

    const pdoc = new JSDOM(html, { url: rangedLinks[i] }).window.document

    // Target the specific post, or fall back to the first post on the page
    const postEl = postId
      ? (pdoc.getElementById(`post-${postId}`) ?? pdoc.querySelector<HTMLElement>('article[id^="post-"]'))
      : pdoc.querySelector<HTMLElement>('article[id^="post-"]')

    const bbWrapper = postEl?.querySelector('.bbWrapper, .message-body .bbWrapper')
    if (!bbWrapper) continue

    // Chapter title: the threadmark title, grabbed from the threadmarks list
    // (the post page doesn't always show it). Fall back to "Chapter N".
    const chTitle = `Chapter ${i + 1}`

    chapters.push({
      title: chTitle,
      html:  bbWrapper.innerHTML,
      text:  bbWrapper.textContent ?? '',
    })
  }
  if (chapters.length === 0) throw new Error('Could not extract post content from thread.')

  const assembled = chapters.map(ch =>
    `<div class="chapter">\n` +
    `<h2 class="chapter-title">${escHtml(ch.title)}</h2>\n` +
    `<div class="chapter-content">${ch.html}</div>\n` +
    `</div>`,
  ).join('\n')

  return {
    title,
    author,
    html:        sanitize(assembled),
    textContent: chapters.map(c => c.text).join(' '),
    coverUrl,
  }
}

// ── Chapter-count check (lightweight) ────────────────────────────────────────
export async function getXenForoChapterCount(url: string): Promise<number | null> {
  const m = XENFORO_THREAD_RE.exec(url)
  if (!m) return null
  try {
    const threadBase     = `https://${m[1]}/${m[2]}/`
    const threadmarksUrl = `${threadBase}threadmarks`
    const links = await collectThreadmarkLinks(threadmarksUrl)
    return links.length > 0 ? links.length : null
  } catch {
    return null
  }
}

// ── Threadmark collection ─────────────────────────────────────────────────────

// XenForo 2 paginates the threadmarks list at /threadmarks?page=N.
// We collect links from all pages.
async function collectThreadmarkLinks(
  threadmarksUrl: string,
  onProgress?:    (msg: string) => void,
): Promise<string[]> {
  const links:  string[] = []
  let   pageUrl          = threadmarksUrl
  let   pageNum          = 1
  const MAX_PAGES        = 50

  while (pageNum <= MAX_PAGES) {
    const html = await fetchPage(pageUrl)
    const doc  = new JSDOM(html, { url: pageUrl }).window.document

    // XenForo 2 threadmarks list — links to individual posts
    const pageLinks = extractThreadmarkLinks(doc, pageUrl)
    links.push(...pageLinks)

    // Follow the "Next page" link if present
    const nextEl  = doc.querySelector<HTMLAnchorElement>('a[rel="next"], .pageNav-jump--next')
    const nextHref = nextEl?.getAttribute('href')
    if (!nextHref) break

    pageUrl = new URL(nextHref, pageUrl).href
    pageNum++
    onProgress?.(`Fetching threadmark page ${pageNum}…`)
  }

  return links
}

function extractThreadmarkLinks(doc: Document, baseUrl: string): string[] {
  const links: string[] = []
  const seen  = new Set<string>()

  // XenForo 2 threadmark rows contain <a> tags whose href ends in /post-NNN
  const selectors = [
    '.block-body--threadmarkBody a[href*="/post-"]',
    '.threadmarkList a[href*="/post-"]',
    'a.threadmark-title[href*="/post-"]',
  ]

  for (const sel of selectors) {
    for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>(sel))) {
      const href = a.getAttribute('href')
      if (!href) continue
      const resolved = new URL(href, baseUrl).href
      const key      = resolved.split('#')[0]  // deduplicate ignoring fragment
      if (seen.has(key)) continue
      seen.add(key)
      links.push(resolved)
    }
    if (links.length > 0) break  // stop at first matching selector
  }

  return links
}
