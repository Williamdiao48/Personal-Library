import { JSDOM } from 'jsdom'
import { fetchPage } from '../fetch'
import type { DiscoveredWork } from '../fetch'

// ── FFN favorite-stories discovery ────────────────────────────────────────────
// A user's profile (/u/{userId}/) carries their "Favorite Stories" as hidden
// `div.favstories` data rows (the JS `storylist_draw()` renders visible copies into
// #fs_inside). We parse the SOURCE `.favstories` divs so extraction is robust
// whether or not the page JS ran — and the CF BrowserWindow path (needed for FFN)
// runs it anyway. Each row exposes rich `data-*` attributes (validated in the
// 2026-08-21 spike: 27/27 exact match on a real profile) — prefer those over text
// scraping. NB: FFN writes class attrs single-quoted and unquoted (`class='z-list
// favstories'`, `class=stitle`), so a real DOM parser is required; regex grep for
// `class="..."` finds nothing.

const FFN_ORIGIN = 'https://www.fanfiction.net'

/** "50,000" → 50000; empty / non-numeric → null. */
function parseIntLoose(text: string | null | undefined): number | null {
  const digits = (text ?? '').replace(/[^0-9]/g, '')
  if (!digits) return null
  const n = parseInt(digits, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse an FFN profile page's Favorite Stories list (pure — jsdom only). Rows are
 * `div.favstories`; the story id/title/fandom/word+chapter counts come from the
 * row's `data-*` attributes, the canonical URL from `a.stitle`, the author from the
 * first `/u/` anchor in the row.
 */
export function parseFfnetFavorites(html: string): DiscoveredWork[] {
  const doc = new JSDOM(html).window.document
  const out: DiscoveredWork[] = []

  for (const row of Array.from(doc.querySelectorAll('div.favstories'))) {
    const storyId = row.getAttribute('data-storyid')?.trim() || null

    // Canonical story URL: the title anchor's href is `/s/{id}/1/{slug}`. Fall back
    // to a bare `/s/{id}` built from the data id when the anchor is missing.
    const titleAnchor = row.querySelector<HTMLAnchorElement>('a.stitle')
    const href = titleAnchor?.getAttribute('href')?.trim()
    let url: string | null = null
    if (href) url = new URL(href, FFN_ORIGIN).href
    else if (storyId) url = `${FFN_ORIGIN}/s/${storyId}`
    if (!url) continue // no id and no link — unusable row

    const title =
      row.getAttribute('data-title')?.trim() || titleAnchor?.textContent?.trim() || 'Untitled story'

    // Author is the first profile link in the row (the story's author byline).
    const author = row.querySelector('a[href^="/u/"]')?.textContent?.trim() || null

    const fandom = row.getAttribute('data-category')?.trim() || null
    const words = parseIntLoose(row.getAttribute('data-wordcount'))
    const chapters = parseIntLoose(row.getAttribute('data-chapters'))

    out.push({ url, title, author, fandom, words, chapters })
  }

  return out
}

/**
 * Discover a user's FFN favorite stories. A single `fetchPage` — FFN answers plain
 * fetches with a Cloudflare 403, which `fetchPage` transparently retries through the
 * real-browser CF solver, so this rides that path automatically. The caller is
 * responsible for validating `userId` before building the URL.
 */
export async function discoverFfnetFavorites(userId: string): Promise<DiscoveredWork[]> {
  const html = await fetchPage(`${FFN_ORIGIN}/u/${userId}/`)
  return parseFfnetFavorites(html)
}
