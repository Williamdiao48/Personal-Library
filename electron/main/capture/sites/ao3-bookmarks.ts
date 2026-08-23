import { JSDOM } from 'jsdom'
import { fetchPage } from '../fetch'
import type { DiscoveredWork } from '../fetch'

// ── AO3 public-bookmark discovery ─────────────────────────────────────────────
// AO3 has no "favorites"; the equivalent is a user's public *bookmarks*, listed at
// /users/{username}/bookmarks?page=N. Each bookmark is a `li.bookmark.blurb` whose
// `h4.heading a` points at the bookmarked thing — a work (/works/{id}), a series
// (/series/{id}), or an off-site URL (absolute http(s)). v1 imports works only, so
// series + external bookmarks are filtered out and counted for the preview summary.
//
// Pure parse (parseAo3BookmarksPage) is split from the network walk
// (discoverAo3Bookmarks) so the parser is fixture-testable with no fetch. Selectors
// are the ones validated in the 2026-08-21 spike against real live-account markup.

const AO3_ORIGIN = 'https://archiveofourown.org'

// Safety cap on how many bookmark pages we'll walk in one discovery. A large
// account can report 20+ pages (~470 bookmarks); the cap bounds worst-case fetch
// volume/time. Tunable — the spike saw maxPage=24 on a real account.
const MAX_DISCOVER_PAGES = 100

// Polite gap between successive bookmark-page fetches. The spike hit multiple 503s
// probing AO3 back-to-back, so serialized + delayed is not optional.
const AO3_PAGE_DELAY_MS = 1500

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** `/works/12345` (with or without a trailing path/query) → the numeric id, else null. */
function workIdFromHref(href: string): string | null {
  return /^\/works\/(\d+)/.exec(href)?.[1] ?? null
}

export interface Ao3BookmarksPage {
  works: DiscoveredWork[]
  maxPage: number
  skippedSeries: number
  skippedExternal: number
}

/**
 * Parse one AO3 bookmarks page (pure — jsdom only, no network). Returns the work
 * bookmarks on this page, the highest page number seen in the pagination control,
 * and the count of series/external bookmarks that were filtered out.
 */
export function parseAo3BookmarksPage(html: string): Ao3BookmarksPage {
  const doc = new JSDOM(html).window.document
  const works: DiscoveredWork[] = []
  let skippedSeries = 0
  let skippedExternal = 0

  for (const li of Array.from(doc.querySelectorAll('li.bookmark.blurb'))) {
    // The bookmarked thing's title link. A blurb also carries other anchors
    // (tags, author byline), so scope to the h4.heading title anchor.
    const anchor = li.querySelector<HTMLAnchorElement>('h4.heading a')
    const href = anchor?.getAttribute('href')?.trim()
    if (!href) continue

    if (/^https?:\/\//i.test(href)) {
      skippedExternal++ // off-site bookmark — out of scope for v1
      continue
    }
    if (/^\/series\//.test(href)) {
      skippedSeries++ // series bookmark — out of scope for v1
      continue
    }
    const workId = workIdFromHref(href)
    if (!workId) continue // unrecognized internal link (collection, etc.) — ignore

    const title = anchor?.textContent?.trim() || 'Untitled work'
    // AO3 lists every co-creator as its own `a[rel="author"]`; the first is enough
    // for the preview. Anonymous/orphaned works have no author anchor → null.
    const author = li.querySelector('a[rel="author"]')?.textContent?.trim() || null

    works.push({ url: `${AO3_ORIGIN}/works/${workId}`, title, author })
  }

  // Pagination: the highest ?page=N in the pagination control. Absent (single page)
  // → maxPage stays 1.
  let maxPage = 1
  for (const a of Array.from(
    doc.querySelectorAll<HTMLAnchorElement>('ol.pagination a[href*="page="]'),
  )) {
    const pm = /[?&]page=(\d+)/.exec(a.getAttribute('href') ?? '')
    if (pm) maxPage = Math.max(maxPage, parseInt(pm[1], 10))
  }

  return { works, maxPage, skippedSeries, skippedExternal }
}

export interface Ao3DiscoverResult {
  works: DiscoveredWork[]
  skippedSeries: number
  skippedExternal: number
  pagesFetched: number
}

/**
 * Walk a user's public bookmarks: fetch page 1, read the page count, then fetch the
 * remaining pages serially (polite delay between each), concatenating the works.
 * `onPage(page, totalPages, foundSoFar)` reports progress for the UI. The caller is
 * responsible for validating `username` before building the URL.
 */
export async function discoverAo3Bookmarks(
  username: string,
  onPage?: (page: number, totalPages: number, foundSoFar: number) => void,
): Promise<Ao3DiscoverResult> {
  const pageUrl = (page: number): string => `${AO3_ORIGIN}/users/${username}/bookmarks?page=${page}`

  const first = parseAo3BookmarksPage(await fetchPage(pageUrl(1)))
  const works = [...first.works]
  let skippedSeries = first.skippedSeries
  let skippedExternal = first.skippedExternal

  const totalPages = Math.min(first.maxPage, MAX_DISCOVER_PAGES)
  onPage?.(1, totalPages, works.length)

  for (let page = 2; page <= totalPages; page++) {
    await sleep(AO3_PAGE_DELAY_MS)
    onPage?.(page, totalPages, works.length)
    const parsed = parseAo3BookmarksPage(await fetchPage(pageUrl(page)))
    works.push(...parsed.works)
    skippedSeries += parsed.skippedSeries
    skippedExternal += parsed.skippedExternal
  }

  return { works, skippedSeries, skippedExternal, pagesFetched: totalPages }
}
