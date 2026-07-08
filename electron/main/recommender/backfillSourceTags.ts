import { JSDOM } from 'jsdom'
import { getDb, all } from '../db'
import { fetchPage, fetchPageWithBrowser } from '../capture/fetch'
import type { SourceTag, SourceMeta } from '../capture/fetch'
import { parseAo3Metadata } from '../capture/sites/ao3'
import { parseFfnMetadata } from '../capture/sites/ffnet'
import { persistSourceTags, siteKeyFromUrl } from './sourceTags'

// F3 — backfill native tags for fics captured BEFORE F1. Those items already
// have a source_url; re-fetch each work page (AO3 via plain HTTP, FFN via the
// Cloudflare BrowserWindow path), run the F1 parsers, and persist via F2. Opt-in
// + rate-limited + sequential: this hits AO3/FFN once per stale item, so it must
// stay a deliberate, low-footprint maintenance action (never background). One
// item failing (network / parse) is counted and skipped — never sinks the batch.

export const BACKFILL_SOURCE_TAGS = {
  DELAY_MS: 1500, // polite pause between fetches
}

export interface BackfillResult {
  processed: number
  updated: number
  failed: number
}

interface PendingRow {
  id: string
  source_url: string
}

/** Active AO3/FFN items with no native tags/meta yet — the backfill work list. */
function pendingItems(limit?: number): PendingRow[] {
  const rows = all<PendingRow>(
    `SELECT id, source_url FROM items
     WHERE deleted_at IS NULL
       AND source_url IS NOT NULL
       AND (source_url LIKE '%archiveofourown.org%' OR source_url LIKE '%fanfiction.net%')
       AND id NOT IN (SELECT item_id FROM item_source_tags)
       AND id NOT IN (SELECT item_id FROM item_source_meta)
     ORDER BY date_saved DESC`,
  )
  return limit != null ? rows.slice(0, limit) : rows
}

/** Fetch + parse one work's native tags/meta by site, or null for a non-fanfic URL. */
async function fetchSourceTagsFor(
  url: string,
): Promise<{ tags: SourceTag[]; meta: SourceMeta } | null> {
  const site = siteKeyFromUrl(url)
  if (site === 'ao3') {
    const html = await fetchPage(url)
    return parseAo3Metadata(new JSDOM(html).window.document)
  }
  if (site === 'ffn') {
    const html = await fetchPageWithBrowser(url) // FFN needs the CF-passing browser
    return parseFfnMetadata(new JSDOM(html).window.document)
  }
  return null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Re-derive and persist native tags for already-captured AO3/FFN items. Opt-in
 * maintenance — call it explicitly (a dev hook now; a Settings action in Chunk 5).
 */
export async function backfillSourceTags(
  opts: {
    delayMs?: number
    limit?: number
    onProgress?: (done: number, total: number) => void
  } = {},
): Promise<BackfillResult> {
  const delayMs = opts.delayMs ?? BACKFILL_SOURCE_TAGS.DELAY_MS
  const rows = pendingItems(opts.limit)

  let updated = 0
  let failed = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    opts.onProgress?.(i, rows.length)
    try {
      const res = await fetchSourceTagsFor(row.source_url)
      if (res && (res.tags.length > 0 || Object.keys(res.meta).length > 0)) {
        const db = getDb()
        db.transaction(() =>
          persistSourceTags(db, row.id, res.tags, res.meta, siteKeyFromUrl(row.source_url)),
        )()
        updated++
      }
    } catch {
      failed++
    }
    if (delayMs > 0 && i < rows.length - 1) await sleep(delayMs)
  }

  return { processed: rows.length, updated, failed }
}
