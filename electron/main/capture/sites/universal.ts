import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { sanitize } from '../sanitizer'
import {
  fetchPage,
  fetchPagesWithSession,
  fetchPagesSequential,
} from '../fetch'
import type { SiteContent } from '../fetch'

// ── Types ─────────────────────────────────────────────────────────────────────

type PageType = 'toc' | 'chapter' | 'article'

interface ChapterData {
  title: string
  html:  string
  text:  string
}

interface NumericChapterUrl {
  current: number
  build:   (n: number) => string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_CHAPTERS  = 1000
const MAX_PREV_HOPS = 500

// Navigation text must match the whole trimmed string — prevents matching
// "next" inside longer anchor text like "See what happens next in Book 2".
const NEXT_TEXT_RE = /^\s*(next(\s*(chapter|part|page|episode|chap))?|→|›|>>|continue\s+reading)\s*$/i
const PREV_TEXT_RE = /^\s*(prev(ious)?(\s*(chapter|part|page|episode|chap))?|←|‹|<<)\s*$/i

// Anchor text patterns found in TOC chapter lists
const CHAPTER_ANCHOR_RE = /\b(chapter|prologue|epilogue|interlude|afterword|arc|book|volume|part)\b/i

// URL path segment indicating a chapter page (keyword + number)
const CHAPTER_URL_SEGMENT_RE = /\/(chapter|ch|episode|ep|part|page|c)s?[-_/]*\d+/i

// URL path indicating a work-index / TOC page — excludes paths that also have
// a chapter segment, so /fiction/123/chapter/5 is not mistaken for a TOC.
const TOC_URL_RE = /\/(fiction|story|stories|series|novel|novels|work|book)s?\b(?!.*\/(chapter|ch|episode|ep|part|page|c)s?[-_/]*\d)/i

// Chapter keyword + sequential number inside a URL path (increment optimisation)
const CHAPTER_KEYWORD_NUM_RE = /(chapter|ch|episode|ep|part|page|vol)s?[-_/]*(\d+)/i

// Explicit "table of contents" link text
const TOC_LINK_TEXT_RE = /^\s*(table\s+of\s+contents?|chapter\s+list|index|toc)\s*$/i

// ── URL utilities ─────────────────────────────────────────────────────────────

function resolveUrl(href: string, base: string): string {
  try { return new URL(href, base).href } catch { return '' }
}

// Normalises a URL for deduplication: lowercase host, strip trailing slash and
// fragment so that /chapter/3 and /chapter/3/ and /chapter/3#top all match.
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.origin.toLowerCase() + u.pathname.replace(/\/$/, '') + u.search
  } catch {
    return url.toLowerCase()
  }
}

// ── Page type detection ───────────────────────────────────────────────────────

function probePageType(doc: Document, url: string): PageType {
  // Chapter signals are checked first — they are more specific than TOC signals.

  // Semantic HTML5 pagination links in <head>
  if (doc.querySelector('link[rel="next"], link[rel="prev"]')) return 'chapter'

  // <a rel="next/prev"> anywhere in the document body
  if (doc.querySelector('a[rel="next"], a[rel="prev"]'))       return 'chapter'

  // Visible next/prev chapter navigation text
  if (hasChapterNavLinks(doc))                                  return 'chapter'

  // URL path contains a chapter-number segment (e.g. /chapter/3, /episode/12)
  if (CHAPTER_URL_SEGMENT_RE.test(new URL(url).pathname))      return 'chapter'

  // TOC signals: enough chapter-labelled anchor links on a work-index page
  if (countChapterAnchorLinks(doc) >= 3)           return 'toc'
  if (looksLikeTocByUrlAndLinks(doc, url))          return 'toc'

  return 'article'
}

function hasChapterNavLinks(doc: Document): boolean {
  for (const el of Array.from(doc.querySelectorAll('a, button'))) {
    const text  = (el.textContent ?? '').trim()
    const label = el.getAttribute('aria-label') ?? ''
    if (NEXT_TEXT_RE.test(text) || NEXT_TEXT_RE.test(label) ||
        PREV_TEXT_RE.test(text) || PREV_TEXT_RE.test(label)) return true
  }
  return false
}

function countChapterAnchorLinks(doc: Document): number {
  let n = 0
  for (const a of Array.from(doc.querySelectorAll('a'))) {
    if (CHAPTER_ANCHOR_RE.test(a.textContent ?? '')) n++
  }
  return n
}

// Secondary TOC check: work-index URL with many same-origin links that share
// the page's path prefix — typical of chapter listing pages.
function looksLikeTocByUrlAndLinks(doc: Document, url: string): boolean {
  if (!TOC_URL_RE.test(new URL(url).pathname)) return false
  const { origin, pathname } = new URL(url)
  const prefix = origin + pathname.split('/').slice(0, 3).join('/')
  let count = 0
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    try {
      const href = new URL(a.getAttribute('href')!, url)
      if (href.href.startsWith(prefix) && href.pathname !== pathname) count++
    } catch { /* skip invalid hrefs */ }
  }
  return count >= 3
}

// ── Navigation link detection ─────────────────────────────────────────────────

function findNextLink(doc: Document, baseUrl: string): string | null {
  return findNavLink(doc, baseUrl, NEXT_TEXT_RE, 'next')
}

function findPrevLink(doc: Document, baseUrl: string): string | null {
  return findNavLink(doc, baseUrl, PREV_TEXT_RE, 'prev')
}

function findNavLink(
  doc:         Document,
  baseUrl:     string,
  textPattern: RegExp,
  rel:         'next' | 'prev',
): string | null {
  // Priority 1 — semantic <link rel="next/prev"> in <head>
  const linkEl = doc.querySelector(`link[rel="${rel}"]`)
  if (linkEl) {
    const resolved = resolveUrl(linkEl.getAttribute('href') ?? '', baseUrl)
    if (resolved) return resolved
  }

  // Priority 2 — <a rel="next/prev"> in body
  const aRel = doc.querySelector(`a[rel="${rel}"]`)
  if (aRel) {
    const href = aRel.getAttribute('href') ?? ''
    if (href && !href.startsWith('#')) return resolveUrl(href, baseUrl)
  }

  // Priority 3 — text or aria-label pattern match anywhere in document
  for (const el of Array.from(doc.querySelectorAll('a, button'))) {
    const text  = (el.textContent ?? '').trim()
    const label = el.getAttribute('aria-label') ?? ''
    if (!textPattern.test(text) && !textPattern.test(label)) continue
    const href = el.getAttribute('href') ?? ''
    if (href && !href.startsWith('#')) return resolveUrl(href, baseUrl)
  }

  return null
}

// ── TOC link and chapter extraction ──────────────────────────────────────────

// Searches for a link back to the work's table of contents. Looks for:
//   1. An explicit "Table of Contents" / "Chapter List" text link.
//   2. A breadcrumb ancestor whose path is a strict prefix of the current path.
function findTocLink(doc: Document, currentUrl: string): string | null {
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    if (TOC_LINK_TEXT_RE.test((a.textContent ?? '').trim())) {
      const href = a.getAttribute('href')!
      if (!href.startsWith('#')) return resolveUrl(href, currentUrl)
    }
  }

  const { pathname } = new URL(currentUrl)
  // Reverse so we try the deepest breadcrumb first
  const breadcrumbLinks = Array.from(
    doc.querySelectorAll('[class*="bread"] a, nav a, [role="navigation"] a'),
  ).reverse()
  for (const a of breadcrumbLinks) {
    try {
      const href = new URL(a.getAttribute('href') ?? '', currentUrl)
      if (href.pathname.length > 1 && pathname.startsWith(href.pathname + '/')) {
        return href.href
      }
    } catch { /* skip */ }
  }

  return null
}

// Extracts an ordered list of chapter URLs from a TOC page.
// Only returns same-origin links whose anchor text matches chapter naming.
function extractTocLinks(doc: Document, tocUrl: string): string[] {
  const { origin, pathname } = new URL(tocUrl)
  const seen  = new Set<string>()
  const links: string[] = []

  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    if (!CHAPTER_ANCHOR_RE.test(a.textContent ?? '')) continue
    const href = a.getAttribute('href')!
    try {
      const resolved = new URL(href, tocUrl)
      if (resolved.origin !== origin)     continue  // external link
      if (resolved.pathname === pathname) continue  // self-link
      const key = resolved.origin + resolved.pathname
      if (seen.has(key)) continue
      seen.add(key)
      links.push(resolved.href)
    } catch { /* skip invalid hrefs */ }
  }

  return links
}

// ── Numeric chapter URL optimisation ─────────────────────────────────────────

// If the URL path contains a chapter keyword followed by a sequential number
// (e.g. /chapter/3, /ch-3, /episode/5/title-slug), returns a builder that
// constructs any chapter's URL by substituting the number. Returns null when
// the URL does not match, signalling the caller to fall back to link-walking.
function detectNumericChapter(url: string): NumericChapterUrl | null {
  const { origin, pathname, search } = new URL(url)
  const m = CHAPTER_KEYWORD_NUM_RE.exec(pathname)
  if (!m) return null

  const before  = origin + pathname.slice(0, m.index) + m[1]
  const after   = pathname.slice(m.index + m[0].length) + search
  const current = parseInt(m[2], 10)
  if (isNaN(current)) return null

  return { current, build: (n: number) => `${before}${n}${after}` }
}

// Reads the total chapter count from a chapter page — from a <select> dropdown
// (used on FF.net, some webnovel sites) or from "X chapters" in metadata text.
function extractChapterCount(doc: Document): number | null {
  for (const sel of Array.from(doc.querySelectorAll('select'))) {
    const count = sel.querySelectorAll('option').length
    if (count >= 2) return count
  }

  const m = /\b(\d+)\s+chapters?\b/i.exec(doc.body?.textContent ?? '')
  if (m) {
    const n = parseInt(m[1], 10)
    if (n >= 2 && n <= MAX_CHAPTERS) return n
  }

  return null
}

// ── Metadata extraction ───────────────────────────────────────────────────────

// Strips "Chapter N: ..." suffixes from og:title or <title> to recover the
// series name when arriving at an individual chapter page.
function extractSeriesTitle(doc: Document, fallback: string): string {
  const candidates = [
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content'),
    doc.querySelector('title')?.textContent,
  ]
  for (const raw of candidates) {
    if (!raw) continue
    const cleaned = raw
      .replace(/\s*[-–—|:]\s*(chapter|ch\.?|part|episode)\s*\d+.*/i, '')
      .trim()
    if (cleaned && cleaned !== fallback) return cleaned
  }
  return fallback
}

function extractAuthor(doc: Document): string | null {
  const meta = doc.querySelector('meta[name="author"]')?.getAttribute('content')?.trim()
  if (meta) return meta

  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    if (/\/(user|author|profile|u)s?\//.test(a.getAttribute('href') ?? '')) {
      const text = a.textContent?.trim()
      if (text) return text
    }
  }

  return null
}

function extractCoverUrl(doc: Document): string | null {
  const og = doc.querySelector('meta[property="og:image"]')?.getAttribute('content')
  // Reject obviously generic site-wide images
  if (og && !/logo|icon|default|placeholder|avatar/i.test(og)) return og
  return null
}

// ── Chapter content parsing ───────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Extracts readable content from a chapter page.
// Re-serialises to a fresh JSDOM so Readability (which mutates its input) does
// not corrupt the document we still need for metadata extraction.
function readChapterPage(doc: Document, url: string, n: number): ChapterData | null {
  let article: ReturnType<Readability['parse']>
  try {
    const fresh = new JSDOM(doc.documentElement.outerHTML, { url }).window.document
    article = new Readability(fresh).parse()
  } catch {
    return null
  }
  if (!article || !article.textContent.trim()) return null

  // Strip "Series Name — " prefixes that many publishers embed in chapter titles
  const title = (article.title ?? `Chapter ${n}`)
    .replace(/^[^—–|:]+\s*[-—–|]\s*/, '')
    .trim() || `Chapter ${n}`

  return {
    title,
    html: sanitize(article.content),
    text: article.textContent ?? '',
  }
}

function buildChapterBlock(chapter: ChapterData): string {
  return (
    `<div class="chapter">\n` +
    `<h2 class="chapter-title">${escHtml(chapter.title)}</h2>\n` +
    `<div class="chapter-content">${chapter.html}</div>\n` +
    `</div>`
  )
}

function assembleChapters(chapters: ChapterData[]): Pick<SiteContent, 'html' | 'textContent'> {
  return {
    html:        sanitize(chapters.map(buildChapterBlock).join('\n')),
    textContent: chapters.map(c => c.text).join(' '),
  }
}

// ── Batch fetch with blocked-page recovery ────────────────────────────────────

// Fetches all chapter URLs via the session cookie store (fast, no rendering
// overhead). Pages that return 200 but contain negligible text — a sign of a
// soft-block or JS challenge — are re-fetched via a real BrowserWindow batch.
// This is the same three-phase strategy used by the FF.net parser.
async function batchFetchChapters(
  urls:       string[],
  onProgress: (msg: string) => void,
): Promise<(Document | null)[]> {
  const total = urls.length

  const pages = await fetchPagesWithSession(urls, 200, (i) => {
    onProgress(`Fetching chapter ${i + 1} of ${total}…`)
  }, 5)

  const docs = pages.map((html, i): Document | null => {
    if (!html) return null
    try {
      const doc = new JSDOM(html, { url: urls[i] }).window.document
      // A soft-blocked page typically contains only the challenge scaffold text
      return (doc.body?.textContent?.trim().length ?? 0) >= 100 ? doc : null
    } catch {
      return null
    }
  })

  const blockedIndices = docs.map((d, i) => d === null ? i : -1).filter(i => i >= 0)
  if (blockedIndices.length > 0) {
    onProgress(`Re-fetching ${blockedIndices.length} blocked chapter(s) via browser…`)
    const blockedUrls = blockedIndices.map(i => urls[i])
    const rePages = await fetchPagesSequential(blockedUrls, 1200, (j) => {
      onProgress(`Re-fetching chapter ${blockedIndices[j] + 1} of ${total}…`)
    })
    for (let j = 0; j < blockedIndices.length; j++) {
      const i = blockedIndices[j]
      try {
        docs[i] = new JSDOM(rePages[j], { url: urls[i] }).window.document
      } catch {
        docs[i] = null
      }
    }
  }

  return docs
}

// ── TOC page strategy ─────────────────────────────────────────────────────────

async function captureTocPage(
  tocDoc:     Document,
  tocUrl:     string,
  onProgress: (msg: string) => void,
): Promise<SiteContent | null> {
  const chapterUrls = extractTocLinks(tocDoc, tocUrl)
  if (chapterUrls.length < 2) return null

  const tocTitle  = tocDoc.querySelector('h1, h2')?.textContent?.trim() ?? ''
  const tocAuthor = extractAuthor(tocDoc)
  const tocCover  = extractCoverUrl(tocDoc)

  onProgress(`Found ${chapterUrls.length} chapters in table of contents…`)
  const docs = await batchFetchChapters(chapterUrls, onProgress)

  const chapters = docs
    .map((doc, i) => doc ? readChapterPage(doc, chapterUrls[i], i + 1) : null)
    .filter((c): c is ChapterData => c !== null)

  if (chapters.length < 2) return null

  const firstDoc = docs.find((d): d is Document => d !== null)
  return {
    title:    tocTitle || (firstDoc ? extractSeriesTitle(firstDoc, chapters[0].title) : chapters[0].title),
    author:   tocAuthor ?? (firstDoc ? extractAuthor(firstDoc) : null),
    coverUrl: tocCover  ?? (firstDoc ? extractCoverUrl(firstDoc) : null),
    ...assembleChapters(chapters),
  }
}

// ── Chapter-first strategy ────────────────────────────────────────────────────

// Collects all chapters by walking prev-links backwards to chapter 1, then
// next-links forwards to the end — in one combined pass of N total requests
// (N_prev backward hops + N_remaining forward hops = N, not 2N).
//
// Chapters discovered going backward are stored newest-first, then reversed
// before being joined with the forward portion so the final list is ch1 → chN.
async function collectAllByWalking(
  startDoc:   Document,
  startUrl:   string,
  onProgress: (msg: string) => void,
): Promise<{ doc: Document; url: string }[]> {
  // ── Backward pass ────────────────────────────────────────────────────────────
  const backward: { doc: Document; url: string }[] = []
  let curDoc = startDoc
  let curUrl = startUrl

  for (let hops = 0; hops < MAX_PREV_HOPS; hops++) {
    const prevUrl = findPrevLink(curDoc, curUrl)
    if (!prevUrl || normalizeUrl(prevUrl) === normalizeUrl(curUrl)) break

    onProgress(`Rewinding to chapter 1… (step ${hops + 1})`)
    const html = await fetchPage(prevUrl)
    curDoc = new JSDOM(html, { url: prevUrl }).window.document
    curUrl = prevUrl
    backward.push({ doc: curDoc, url: curUrl })
  }

  // ── Forward pass ─────────────────────────────────────────────────────────────
  const forward: { doc: Document; url: string }[] = [{ doc: startDoc, url: startUrl }]
  const visited = new Set<string>([
    ...backward.map(c => normalizeUrl(c.url)),
    normalizeUrl(startUrl),
  ])
  curDoc = startDoc
  curUrl = startUrl

  while (backward.length + forward.length < MAX_CHAPTERS) {
    const nextUrl = findNextLink(curDoc, curUrl)
    if (!nextUrl) break

    const key = normalizeUrl(nextUrl)
    if (visited.has(key)) break  // loop guard
    visited.add(key)

    onProgress(`Fetching chapter ${backward.length + forward.length + 1}…`)
    const html = await fetchPage(nextUrl)
    curDoc = new JSDOM(html, { url: nextUrl }).window.document
    curUrl = nextUrl
    forward.push({ doc: curDoc, url: curUrl })
  }

  // backward is stored newest-first; reverse so the full list reads ch1 → chN
  return [...backward.reverse(), ...forward]
}

async function captureChapterSeries(
  startDoc:   Document,
  startUrl:   string,
  onProgress: (msg: string) => void,
): Promise<SiteContent | null> {

  // ── Option 1: explicit TOC link ──────────────────────────────────────────────
  // The cleanest path: a "Table of Contents" link gives us every chapter URL
  // in declared order without any link-walking.
  const tocUrl = findTocLink(startDoc, startUrl)
  if (tocUrl) {
    onProgress('Found table of contents, fetching…')
    try {
      const tocHtml = await fetchPage(tocUrl)
      const tocDoc  = new JSDOM(tocHtml, { url: tocUrl }).window.document
      const result  = await captureTocPage(tocDoc, tocUrl, onProgress)
      if (result) return result
    } catch { /* TOC fetch failed — fall through */ }
  }

  // ── Option 2: numeric URL + known chapter count ──────────────────────────────
  // When the URL contains a chapter keyword + sequential number AND the page
  // tells us the total, we can build every URL upfront and batch-fetch them —
  // the same strategy the FF.net parser uses.
  const numeric = detectNumericChapter(startUrl)
  if (numeric) {
    try {
      const ch1Url = numeric.current > 1 ? numeric.build(1) : startUrl
      let   ch1Doc = startDoc

      if (numeric.current > 1) {
        onProgress('Fetching chapter 1…')
        const html = await fetchPage(ch1Url)
        ch1Doc = new JSDOM(html, { url: ch1Url }).window.document
      }

      const chapterCount = extractChapterCount(ch1Doc)
      if (chapterCount && chapterCount >= 2) {
        onProgress(`Building ${chapterCount} chapter URLs…`)
        const urls = Array.from({ length: chapterCount }, (_, i) => numeric.build(i + 1))
        const docs = await batchFetchChapters(urls, onProgress)

        const chapters = docs
          .map((doc, i) => doc ? readChapterPage(doc, urls[i], i + 1) : null)
          .filter((c): c is ChapterData => c !== null)

        if (chapters.length >= 2) {
          const firstDoc = docs.find((d): d is Document => d !== null)
          return {
            title:    firstDoc ? extractSeriesTitle(firstDoc, chapters[0].title) : chapters[0].title,
            author:   firstDoc ? extractAuthor(firstDoc) : null,
            coverUrl: firstDoc ? extractCoverUrl(firstDoc) : null,
            ...assembleChapters(chapters),
          }
        }
      }
    } catch { /* numeric approach failed — fall through to walking */ }
  }

  // ── Option 3: bidirectional next/prev-link walk ──────────────────────────────
  // Last resort for sites with opaque chapter IDs and no explicit TOC link.
  // Walks backwards to chapter 1 then forwards to the end in N total requests.
  const allPages = await collectAllByWalking(startDoc, startUrl, onProgress)
  if (allPages.length < 2) return null

  const chapters = allPages
    .map(({ doc, url }, i) => readChapterPage(doc, url, i + 1))
    .filter((c): c is ChapterData => c !== null)

  if (chapters.length < 2) return null

  const firstDoc = allPages[0].doc
  return {
    title:    extractSeriesTitle(firstDoc, chapters[0].title),
    author:   extractAuthor(firstDoc),
    coverUrl: extractCoverUrl(firstDoc),
    ...assembleChapters(chapters),
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

// Returns null when the landing page looks like a standalone article, signalling
// the caller to fall through to captureGeneric (Readability). Returns a fully
// assembled SiteContent when a serial work is detected and successfully crawled.
export async function captureUniversal(
  url:         string,
  onProgress?: (msg: string) => void,
): Promise<SiteContent | null> {
  const progress = (msg: string) => onProgress?.(msg)

  progress('Fetching page…')
  const html = await fetchPage(url)
  const doc  = new JSDOM(html, { url }).window.document

  const pageType = probePageType(doc, url)
  if (pageType === 'article') return null

  if (pageType === 'toc') {
    return captureTocPage(doc, url, progress)
  }

  // pageType === 'chapter'
  return captureChapterSeries(doc, url, progress)
}
