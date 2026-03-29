import { JSDOM } from 'jsdom'
import { sanitize } from '../sanitizer'
import { fetchPage, fetchPagesWithSession, BROWSER_HEADERS } from '../fetch'
import type { SiteContent } from '../fetch'
import type { ChapterRange } from '../index'

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Matches series pages (.../series/{id}/...) and chapter pages (.../read/{id}-...)
const SH_SERIES_RE  = /scribblehub\.com\/series\/(\d+)/
const SH_CHAPTER_RE = /scribblehub\.com\/read\/(\d+)-/

const AJAX_ENDPOINT = 'https://www.scribblehub.com/wp-admin/admin-ajax.php'

// ── Chapter-count check (lightweight) ────────────────────────────────────────
export async function getScribbleHubChapterCount(url: string): Promise<number | null> {
  const idMatch = SH_SERIES_RE.exec(url) ?? SH_CHAPTER_RE.exec(url)
  if (!idMatch) return null
  try {
    const res = await fetch(AJAX_ENDPOINT, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent':       BROWSER_HEADERS['User-Agent'],
      },
      body:   `action=wi_gettocchp&strlist=${idMatch[1]}&tocletter=_&toctype=date`,
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const html  = await res.text()
    const count = new JSDOM(html).window.document
      .querySelectorAll('li.toc_w a[href*="/read/"]').length
    return count > 0 ? count : null
  } catch {
    return null
  }
}

export async function captureScribbleHub(
  url: string,
  onProgress?: (msg: string) => void,
  range?: ChapterRange,
): Promise<SiteContent> {
  const idMatch = SH_SERIES_RE.exec(url) ?? SH_CHAPTER_RE.exec(url)
  if (!idMatch) throw new Error('Could not parse Scribble Hub series ID from URL.')
  const seriesId = idMatch[1]

  const seriesUrl = `https://www.scribblehub.com/series/${seriesId}/`
  onProgress?.('Fetching Scribble Hub story…')
  const seriesHtml = await fetchPage(seriesUrl)
  const seriesDoc  = new JSDOM(seriesHtml, { url: seriesUrl }).window.document

  const title  = seriesDoc.querySelector('.fic-title')?.textContent?.trim()
    ?? seriesDoc.querySelector('h1')?.textContent?.trim()
    ?? 'Unknown Story'
  const author = seriesDoc.querySelector('.auth_name_fic')?.textContent?.trim()
    ?? seriesDoc.querySelector('meta[name="author"]')?.getAttribute('content')?.trim()
    ?? null
  const coverUrl = seriesDoc.querySelector('.fic-image img')?.getAttribute('src')
    ?? seriesDoc.querySelector('meta[property="og:image"]')?.getAttribute('content')
    ?? null

  // Scribble Hub loads the chapter list via a WordPress AJAX endpoint.
  // Results come back newest-first; we reverse for reading order.
  onProgress?.('Fetching chapter list…')
  const tocRes = await fetch(AJAX_ENDPOINT, {
    method:  'POST',
    headers: {
      'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer':          seriesUrl,
      'User-Agent':       BROWSER_HEADERS['User-Agent'],
    },
    body:   `action=wi_gettocchp&strlist=${seriesId}&tocletter=_&toctype=date`,
    signal: AbortSignal.timeout(20_000),
  })
  if (!tocRes.ok) throw new Error(`Scribble Hub TOC request returned ${tocRes.status}`)
  const tocHtml = await tocRes.text()
  const tocDoc  = new JSDOM(tocHtml, { url: seriesUrl }).window.document

  const chapterLinks = Array.from(
    tocDoc.querySelectorAll<HTMLAnchorElement>('li.toc_w a[href*="/read/"]'),
  )
    .map(a => a.getAttribute('href')!)
    .filter(Boolean)
    .map(href => href.startsWith('http') ? href : new URL(href, seriesUrl).href)
    .reverse() // AJAX returns newest-first

  if (chapterLinks.length === 0) throw new Error('No chapters found on Scribble Hub.')

  const rangedLinks = range ? chapterLinks.slice(range.start - 1, range.end) : chapterLinks
  onProgress?.(`Found ${rangedLinks.length} chapters…`)

  const pages = await fetchPagesWithSession(rangedLinks, 200, (i) => {
    onProgress?.(`Fetching chapter ${i + 1} of ${rangedLinks.length}…`)
  })

  const chapters: { title: string; html: string; text: string }[] = []
  for (let i = 0; i < pages.length; i++) {
    if (!pages[i]) continue
    const cdoc    = new JSDOM(pages[i], { url: rangedLinks[i] }).window.document
    const chTitle = cdoc.querySelector('.chapter-inner-header h1, .wi_fic_title, h1')
      ?.textContent?.trim() ?? `Chapter ${i + 1}`
    const content = cdoc.querySelector('.chp-raw, .wi_fic_field')
    if (!content) continue
    chapters.push({ title: chTitle, html: content.innerHTML, text: content.textContent ?? '' })
  }
  if (chapters.length === 0) throw new Error('Could not extract Scribble Hub chapter content.')

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
