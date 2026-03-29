import { JSDOM } from 'jsdom'
import { sanitize } from '../sanitizer'
import { fetchPage, fetchPagesWithSession } from '../fetch'
import type { SiteContent } from '../fetch'
import type { ChapterRange } from '../index'

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Matches both fiction pages and chapter pages — we always re-fetch the fiction
// page to get the authoritative chapter list.
const RR_FICTION_RE = /royalroad\.com\/fiction\/(\d+)/

// ── Chapter-count check (lightweight) ────────────────────────────────────────
export async function getRoyalRoadChapterCount(url: string): Promise<number | null> {
  const match = RR_FICTION_RE.exec(url)
  if (!match) return null
  try {
    const html  = await fetchPage(`https://www.royalroad.com/fiction/${match[1]}`)
    const doc   = new JSDOM(html).window.document
    const count = doc.querySelectorAll('table#chapters tbody tr td a[href*="/chapter/"]').length
    return count > 0 ? count : null
  } catch {
    return null
  }
}

export async function captureRoyalRoad(
  url: string,
  onProgress?: (msg: string) => void,
  range?: ChapterRange,
): Promise<SiteContent> {
  const match = RR_FICTION_RE.exec(url)
  if (!match) throw new Error('Could not parse Royal Road fiction ID from URL.')
  const fictionId = match[1]

  const fictionUrl = `https://www.royalroad.com/fiction/${fictionId}`
  onProgress?.('Fetching Royal Road story…')
  const html = await fetchPage(fictionUrl)
  const doc  = new JSDOM(html, { url: fictionUrl }).window.document

  const title  = doc.querySelector('h1')?.textContent?.trim()
    ?? doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim()
    ?? 'Unknown Story'
  const author = doc.querySelector('.fic-header [href*="/profile/"]')?.textContent?.trim()
    ?? doc.querySelector('meta[name="author"]')?.getAttribute('content')?.trim()
    ?? null
  const coverUrl = doc.querySelector('.thumbnail, .fic-image img')?.getAttribute('src')
    ?? doc.querySelector('meta[property="og:image"]')?.getAttribute('content')
    ?? null

  // Chapter list is server-rendered in <table id="chapters">
  const chapterLinks: string[] = []
  for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>(
    'table#chapters tbody tr td a[href*="/chapter/"]',
  ))) {
    const href = a.getAttribute('href')
    if (!href) continue
    const resolved = new URL(href, fictionUrl).href
    if (!chapterLinks.includes(resolved)) chapterLinks.push(resolved)
  }
  if (chapterLinks.length === 0) throw new Error('No chapters found on Royal Road fiction page.')

  const rangedLinks = range ? chapterLinks.slice(range.start - 1, range.end) : chapterLinks
  onProgress?.(`Found ${rangedLinks.length} chapters…`)

  const pages = await fetchPagesWithSession(rangedLinks, 200, (i) => {
    onProgress?.(`Fetching chapter ${i + 1} of ${rangedLinks.length}…`)
  })

  const chapters: { title: string; html: string; text: string }[] = []
  for (let i = 0; i < pages.length; i++) {
    if (!pages[i]) continue
    const cdoc    = new JSDOM(pages[i], { url: rangedLinks[i] }).window.document
    const chTitle = cdoc.querySelector('.chapter-title, h1')?.textContent?.trim()
      ?? `Chapter ${i + 1}`
    const content = cdoc.querySelector('.chapter-content')
    if (!content) continue
    chapters.push({ title: chTitle, html: content.innerHTML, text: content.textContent ?? '' })
  }
  if (chapters.length === 0) throw new Error('Could not extract Royal Road chapter content.')

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
