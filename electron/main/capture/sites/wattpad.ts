import { JSDOM } from 'jsdom'
import { sanitize } from '../sanitizer'
import { fetchPagesWithSession, fetchPagesSequential, BROWSER_HEADERS } from '../fetch'
import type { SiteContent } from '../fetch'
import type { ChapterRange } from '../index'

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const WP_STORY_RE = /wattpad\.com\/story\/(\d+)/

interface WpPart {
  id:    number
  title: string
  url:   string
}
interface WpStory {
  title: string
  user:  { name: string } | null
  cover: string | null
  parts: WpPart[]
  total: number
}

const WP_API_UA = BROWSER_HEADERS['User-Agent']

// ── Chapter-count check (lightweight) ────────────────────────────────────────
export async function getWattpadChapterCount(url: string): Promise<number | null> {
  const m = WP_STORY_RE.exec(url)
  if (!m) return null
  try {
    const res = await fetch(
      `https://www.wattpad.com/api/v3/stories/${m[1]}?fields=total`,
      { headers: { Accept: 'application/json', 'User-Agent': WP_API_UA }, signal: AbortSignal.timeout(10_000) },
    )
    if (!res.ok) return null
    const data = await res.json() as { total?: number }
    return typeof data.total === 'number' ? data.total : null
  } catch {
    return null
  }
}

async function fetchAllParts(storyId: string, onProgress?: (msg: string) => void): Promise<{
  title: string; author: string | null; cover: string | null; parts: WpPart[]
}> {
  // Wattpad API v3 — publicly accessible for non-premium stories.
  // Parts are paginated; limit 200 covers most stories in a single call.
  // Multiple calls handle very long serials.
  const parts: WpPart[] = []
  let offset   = 0
  const limit  = 200

  let storyTitle: string  = 'Unknown Story'
  let author:     string | null = null
  let cover:      string | null = null

  while (true) {
    const apiUrl = `https://www.wattpad.com/api/v3/stories/${storyId}` +
      `?fields=id,title,user(name),cover,total,parts(id,title,url)&limit=${limit}&offset=${offset}`
    onProgress?.(offset === 0 ? 'Fetching Wattpad story metadata…' : `Fetching chapter list (offset ${offset})…`)

    const res = await fetch(apiUrl, {
      headers: { Accept: 'application/json', 'User-Agent': WP_API_UA },
      signal:  AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`Wattpad API returned ${res.status} ${res.statusText}`)
    const data: WpStory = await res.json()

    if (offset === 0) {
      storyTitle = data.title ?? 'Unknown Story'
      author     = data.user?.name ?? null
      cover      = data.cover ?? null
    }

    parts.push(...(data.parts ?? []))

    // If we received fewer than requested we've hit the end
    if (parts.length >= (data.total ?? parts.length) || (data.parts?.length ?? 0) < limit) break
    offset += limit
  }

  return { title: storyTitle, author, cover, parts }
}

export async function captureWattpad(
  url: string,
  onProgress?: (msg: string) => void,
  range?: ChapterRange,
): Promise<SiteContent> {
  const match = WP_STORY_RE.exec(url)
  if (!match) throw new Error('Could not parse Wattpad story ID from URL.')
  const storyId = match[1]

  const { title, author, cover: coverUrl, parts } = await fetchAllParts(storyId, onProgress)
  if (parts.length === 0) throw new Error('No chapters found for this Wattpad story.')

  const rangedParts = range ? parts.slice(range.start - 1, range.end) : parts
  onProgress?.(`Found ${rangedParts.length} chapters…`)

  // The storytext API returns the raw chapter HTML without requiring JS rendering.
  const textUrls = rangedParts.map(p => `https://www.wattpad.com/apiv2/storytext?id=${p.id}`)

  let rawPages = await fetchPagesWithSession(textUrls, 300, (i) => {
    onProgress?.(`Fetching chapter ${i + 1} of ${rangedParts.length}…`)
  })

  // Any pages that returned empty were likely soft-blocked — re-fetch via browser.
  const blockedIdxs = rawPages.map((html, i) => (!html.trim() ? i : -1)).filter(i => i >= 0)
  if (blockedIdxs.length > 0) {
    onProgress?.(`Re-fetching ${blockedIdxs.length} blocked chapter(s) via browser…`)
    const rePages = await fetchPagesSequential(
      blockedIdxs.map(i => textUrls[i]),
      500,
      (j) => onProgress?.(`Re-fetching chapter ${blockedIdxs[j] + 1} of ${rangedParts.length}…`),
    )
    blockedIdxs.forEach((origIdx, j) => { rawPages[origIdx] = rePages[j] ?? '' })
  }

  const chapters: { title: string; html: string; text: string }[] = []
  for (let i = 0; i < rawPages.length; i++) {
    const rawHtml = rawPages[i]
    if (!rawHtml) continue
    const cdoc = new JSDOM(rawHtml, { url: textUrls[i] }).window.document
    const text = cdoc.body?.textContent?.trim() ?? ''
    if (!text) continue
    chapters.push({
      title: rangedParts[i].title,
      html:  cdoc.body?.innerHTML ?? rawHtml,
      text,
    })
  }
  if (chapters.length === 0) throw new Error('Could not extract Wattpad chapter content.')

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
