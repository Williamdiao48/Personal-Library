import { JSDOM } from 'jsdom'
import { sanitize } from '../sanitizer'
import { fetchPageWithBrowser, fetchPagesSequential, fetchPagesWithSession } from '../fetch'
import type { SiteContent, SourceTag, SourceMeta } from '../fetch'
import type { ChapterRange } from '../index'

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// FF.net URL: https://www.fanfiction.net/s/{storyId}[/{chapter}[/{slug}]]
// Only the story id is required — the chapter number and slug are both optional so
// a bare `/s/{id}` or `/s/{id}/` (the story landing URL users commonly paste) still
// parses. Group 2 is the optional slug; capture defaults it to '' when absent.
const FFN_PATH_RE = /\/s\/(\d+)(?:\/\d+)?(?:\/([^/?#]*))?/

// ── Native metadata extraction (F1) ──────────────────────────────────────────
// FFN packs a story's metadata into a single `#profile_top span.xgray` line:
//   "Rated: T - English - Adventure/Romance - [Harry P., Hermione G.] Ron W. -
//    Chapters: 20 - Words: 50,000 - Favs: 500 - Follows: 300 - ... - Status: Complete - id: N"
// parseFfnMetadata splits on " - " and classifies each segment. Genres are the
// FFN fixed set (joined by "/", including the two-part "Hurt/Comfort"); the
// character segment carries `[pairing]` brackets + comma-separated names. Pure +
// defensive — a missing / restyled line yields an empty result, never throws.

// FFN's fixed genre vocabulary (a story has 1–2, joined by "/").
const FFN_GENRES = new Set([
  'Adventure',
  'Angst',
  'Crime',
  'Drama',
  'Family',
  'Fantasy',
  'Friendship',
  'General',
  'Horror',
  'Humor',
  'Hurt/Comfort',
  'Mystery',
  'Parody',
  'Poetry',
  'Romance',
  'Sci-Fi',
  'Spiritual',
  'Supernatural',
  'Suspense',
  'Tragedy',
  'Western',
])

/** Parse "12,345" → 12345, or null for empty / non-numeric text. */
function parseIntLoose(text: string | null | undefined): number | null {
  const digits = (text ?? '').replace(/[^0-9]/g, '')
  if (!digits) return null
  const n = parseInt(digits, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Decompose a genre segment ("Adventure/Romance", "Romance/Hurt/Comfort") into
 * FFN genres, honoring the two-part "Hurt/Comfort". Returns null if any piece
 * isn't a known genre — i.e. the segment is actually the character list.
 */
function parseFfnGenres(seg: string): string[] | null {
  const parts = seg.split('/')
  const genres: string[] = []
  let i = 0
  while (i < parts.length) {
    const two = i + 1 < parts.length ? `${parts[i]}/${parts[i + 1]}` : ''
    if (two && FFN_GENRES.has(two)) {
      genres.push(two)
      i += 2
    } else if (FFN_GENRES.has(parts[i])) {
      genres.push(parts[i])
      i += 1
    } else {
      return null
    }
  }
  return genres.length ? genres : null
}

/** A character segment: `[a, b]` brackets → a relationship + its characters; the rest → characters. */
function parseFfnCharacters(seg: string): SourceTag[] {
  const out: SourceTag[] = []
  const bracketRe = /\[([^\]]+)\]/g
  let m: RegExpExecArray | null
  while ((m = bracketRe.exec(seg))) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (names.length > 1) out.push({ name: names.join('/'), category: 'relationship' })
    for (const n of names) out.push({ name: n, category: 'character' })
  }
  const loose = seg.replace(bracketRe, ' ')
  for (const n of loose
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    out.push({ name: n, category: 'character' })
  }
  return out
}

/**
 * Classify one FFN metadata line ("Rated: … - English - Genres - Characters -
 * Chapters: … - …") into structured tags (genres + characters/pairing) + stats.
 * Pure and DOM-free so it's shared by the story-page parser and the search-blurb
 * parser (recommender FFN source), which carry the identical line.
 */
export function classifyFfnMetaLine(rawText: string): { tags: SourceTag[]; meta: SourceMeta } {
  const tags: SourceTag[] = []
  const meta: SourceMeta = {}
  const text = rawText.replace(/\s+/g, ' ').trim()
  if (!text) return { tags, meta }

  const segments = text
    .split(' - ')
    .map((s) => s.trim())
    .filter(Boolean)
  segments.forEach((seg, i) => {
    if (/^Rated:/i.test(seg)) {
      meta.rating = seg.replace(/^Rated:\s*/i, '').trim() || undefined
      return
    }
    if (i === 1) return // language always follows Rated — skip it
    const kv = /^(Words|Favs|Follows|Chapters|Reviews):\s*([\d,]+)/i.exec(seg)
    if (kv) {
      const n = parseIntLoose(kv[2])
      const key = kv[1].toLowerCase()
      if (n != null && key === 'words') meta.words = n
      else if (n != null && key === 'favs') meta.favs = n
      else if (n != null && key === 'follows') meta.follows = n
      return
    }
    if (/^Status:/i.test(seg)) {
      meta.status = /complete/i.test(seg) ? 'complete' : 'in-progress'
      return
    }
    if (/^(Updated|Published|id):/i.test(seg)) return
    const genres = parseFfnGenres(seg)
    if (genres) {
      for (const g of genres) tags.push({ name: g, category: 'genre' })
      return
    }
    for (const t of parseFfnCharacters(seg)) tags.push(t)
  })

  if (!meta.status) meta.status = 'in-progress' // FFN omits "Status:" for WIPs
  return { tags, meta }
}

/**
 * Story-page metadata: the `#profile_top span.xgray` line (genres/characters/stats)
 * plus the fandom from the `#pre_story_links` breadcrumb — FFN keeps the fandom in
 * the nav, NOT the metadata line, and it's the anchor the FFN candidate source
 * needs, so we lift it here too.
 */
export function parseFfnMetadata(doc: Document): { tags: SourceTag[]; meta: SourceMeta } {
  const line = doc.querySelector('#profile_top span.xgray')?.textContent ?? ''
  const { tags, meta } = classifyFfnMetaLine(line)

  // Breadcrumb: <div id="pre_story_links"><a>Books</a> » <a>Harry Potter</a></div>.
  // The last anchor is the fandom (crossover pages name the combined fandom).
  const crumbs = doc.querySelectorAll('#pre_story_links a')
  const fandom = crumbs[crumbs.length - 1]?.textContent?.trim()
  if (fandom) tags.push({ name: fandom, category: 'fandom' })

  return { tags, meta }
}

function extractChapter(doc: Document, chapterNum: number): { html: string; text: string } {
  // Chapter title from the selected option: "N. Title" or just "N"
  const selectedOption = doc.querySelector('select#chap_select option[selected]')
  const rawTitle = selectedOption?.textContent?.trim() ?? ''
  const chapterTitle = /^\d+\.\s+(.+)$/.exec(rawTitle)?.[1]?.trim() ?? `Chapter ${chapterNum}`

  // Sanitize the untrusted chapter body before wrapping it in the trusted
  // div.chapter marker — sanitizing after wrapping would strip the class
  // attribute (sanitizer.ts omits class/id to prevent clickjacking) and break
  // multi-chapter file splitting (extractChapterDivs in capture/index.ts
  // depends on div.chapter surviving to the saved HTML).
  const content = sanitize(doc.querySelector('#storytext')?.innerHTML ?? '')
  const text = doc.querySelector('#storytext')?.textContent ?? ''

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
  const storyId = match[1]
  const slug = match[2] ?? '' // absent when the URL has no /chapter/slug tail

  // Always start from chapter 1 so we get the full story metadata
  const ch1Url = `https://www.fanfiction.net/s/${storyId}/1/${slug}`

  // Load chapter 1 via a real BrowserWindow. This passes the CloudFlare JS
  // challenge and stores the resulting cf_clearance cookie in
  // session.defaultSession, which fetchPagesWithSession will then reuse.
  onProgress?.('Detecting chapter count…')
  const ch1Html = await fetchPageWithBrowser(ch1Url)
  const ch1Doc = new JSDOM(ch1Html, { url: ch1Url }).window.document

  const title =
    ch1Doc.querySelector('#profile_top b.xcontrast_txt')?.textContent?.trim() ?? 'Unknown Story'
  const author =
    ch1Doc.querySelector('#profile_top a.xcontrast_txt[href*="/u/"]')?.textContent?.trim() ?? null

  // Chapter count: cross-check two sources and take the larger one.
  //
  // 1. select#chap_select options — rendered by JS; may be incomplete if
  //    did-finish-load fires before the nav script has run.
  // 2. "Chapters: N" in the story metadata block — server-rendered plain text,
  //    present even before any JS executes, so it's always reliable.
  //
  // Taking the max defends against JS-incomplete selects that under-count.
  const selectCount =
    ch1Doc.querySelector('select#chap_select')?.querySelectorAll('option').length ?? 0
  const metaText = ch1Doc.querySelector('#profile_top')?.textContent ?? ''
  const metaCount = parseInt(/Chapters:\s*(\d+)/i.exec(metaText)?.[1] ?? '0', 10)
  const chapterCount = Math.max(selectCount, metaCount) || 1

  const effectiveStart = range?.start ?? 1
  const effectiveEnd = range ? Math.min(range.end, chapterCount) : chapterCount

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
    const remainingUrls = Array.from(
      { length: effectiveEnd - rangeStart + 1 },
      (_, i) => `https://www.fanfiction.net/s/${storyId}/${rangeStart + i}/${slug}`,
    )
    // maxConsecutiveFailures=5: tolerate brief blips but bail fast once CF
    // consistently rate-limits so the browser batch-refetch takes over without
    // waiting 12+ seconds per chapter on the retry backoff.
    const pages = await fetchPagesWithSession(
      remainingUrls,
      200,
      (idx) => {
        onProgress?.(`Fetching chapter ${rangeStart + idx} of ${effectiveEnd}…`)
      },
      5,
    )

    // CF soft-blocks return 200 OK with a challenge page that has no #storytext.
    // Parse all pages first, collect blocked indices, then re-fetch them all in
    // a single fetchPagesSequential call — one shared BrowserWindow is far cheaper
    // than spawning a new window per chapter.
    const parsedDocs = pages.map(
      (html, i) => new JSDOM(html, { url: remainingUrls[i] }).window.document,
    )

    const blockedIndices = parsedDocs
      .map((doc, i) => (doc.querySelector('#storytext') ? -1 : i))
      .filter((i) => i >= 0)

    if (blockedIndices.length > 0) {
      onProgress?.(`Re-fetching ${blockedIndices.length} blocked chapter(s)…`)
      const blockedUrls = blockedIndices.map((i) => remainingUrls[i])
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

  // Native tags + stats live in #profile_top on chapter 1 (fetched above).
  const { tags, meta } = parseFfnMetadata(ch1Doc)

  return {
    title,
    author,
    html: chapterHtmlParts.join('\n'), // each chapter's content already sanitized in extractChapter
    textContent: chapterTextParts.join(' '),
    coverUrl,
    sourceTags: tags,
    sourceMeta: meta,
  }
}
