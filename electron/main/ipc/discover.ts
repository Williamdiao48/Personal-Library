import { ipcMain, shell } from 'electron'
import { get, run } from '../db'
import { recommend } from '../recommender/rerank'
import { workerEmbedder } from '../workers/embed-host'
import { buildTaste } from '../recommender/taste'
import { isHttpUrl } from './capture'
import { armBackfill, disarmBackfill } from '../recommender/lifecycle'
import type { Recommendation } from '../../../src/types'

// C5.3 — the Discover IPC seam. Wires the headless recommender engine
// (`recommend()`) to the renderer. Three principles:
//   - `get` is instant (reads the cached snapshot, never fetches) so opening
//     Discover is cheap; `refresh` is the only path that runs the engine.
//   - Results are cached in the single-row `discover_cache` (migration 23) so the
//     last picks survive a restart and a fresh fetch stays user-initiated.
//   - `openExternal` is the one deliberate hole in the app's
//     block-all-external-navigation policy (index.ts) — it is `isHttpUrl`-guarded
//     and only ever receives a recommendation card's own URL.

/** The cached snapshot shape returned to the renderer (null when never generated). */
interface CachedDiscover {
  cards: Recommendation[]
  generatedAt: number
}

// How many cards a single refresh / "load more" page emits. The engine already
// embeds + scores the WHOLE candidate pool per refresh, then discards all but this
// many — so widening the page beyond the old 12 is nearly free (no extra fetch or
// model work). The renderer reveals them ~12 at a time as the reader scrolls.
const DISCOVER_POOL = 24

/** Read + parse the single cache row; null when empty or unparseable. */
function readCache(): CachedDiscover | null {
  const row = get<{ cards_json: string | null; generated_at: number | null }>(
    `SELECT cards_json, generated_at FROM discover_cache WHERE id = 1`,
  )
  if (!row || row.cards_json === null || row.generated_at === null) return null
  try {
    return { cards: JSON.parse(row.cards_json) as Recommendation[], generatedAt: row.generated_at }
  } catch {
    return null // corrupt JSON → treat as no cache
  }
}

/** Upsert the single cache row. */
function writeCache(cards: Recommendation[], generatedAt: number): void {
  run(
    `INSERT INTO discover_cache (id, cards_json, generated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET cards_json = excluded.cards_json, generated_at = excluded.generated_at`,
    [JSON.stringify(cards), generatedAt],
  )
}

export function registerDiscoverHandlers(): void {
  // Enable/disable the whole recommender's background work. Settings live in the
  // renderer's localStorage, so the renderer syncs `enableDiscover` here after boot
  // (and on toggle). Embeddings exist only to serve Discover, so arming the backfill
  // is gated on this — Discover off ⇒ no model load, no embed passes.
  ipcMain.handle('discover:setEnabled', (_e, enabled: boolean): void => {
    if (enabled) armBackfill()
    else disarmBackfill()
  })

  // Instant: the last cached picks (no network, no model). null = never run yet.
  ipcMain.handle('discover:get', (): CachedDiscover | null => readCache())

  // The only path that runs the engine. `coldStart` (empty taste centroids) is
  // computed up front so the UI can show "learn your taste" rather than a bare
  // empty state. Taste is built ONCE here and passed into recommend() (which would
  // otherwise rebuild it — a full signals scan + embedding decode). Candidate
  // embedding runs on the OFF-THREAD worker embedder so the refresh doesn't jank
  // the UI.
  ipcMain.handle(
    'discover:refresh',
    async (): Promise<{ cards: Recommendation[]; generatedAt: number; coldStart: boolean }> => {
      const taste = buildTaste()
      const coldStart = taste.centroids.length === 0
      const cards = coldStart
        ? []
        : await recommend(workerEmbedder, undefined, taste, { limit: DISCOVER_POOL })
      const generatedAt = Date.now()
      writeCache(cards, generatedAt)
      return { cards, generatedAt, coldStart }
    },
  )

  // "Load more": the reader scrolled past the current pool. Run the engine again
  // excluding every card already shown this session (`excludeSourceIds`) so it
  // returns the NEXT best candidates rather than repeats, append them to the cached
  // snapshot (so a restart restores the whole scrolled feed), and return just the new
  // cards. Empty result = the pool is exhausted → the UI stops and shows an end
  // marker. Warm-cheap: source docs + candidate embeddings are already cached, so
  // this is a re-selection, not a re-fetch/re-embed.
  ipcMain.handle(
    'discover:more',
    async (_e, excludeSourceIds: string[]): Promise<{ cards: Recommendation[] }> => {
      const taste = buildTaste()
      if (taste.centroids.length === 0) return { cards: [] }
      const cards = await recommend(workerEmbedder, undefined, taste, {
        limit: DISCOVER_POOL,
        excludeIds: excludeSourceIds,
      })
      if (cards.length > 0) {
        const cached = readCache()
        const seen = new Set(excludeSourceIds)
        const fresh = cards.filter((c) => !seen.has(c.sourceId))
        if (cached) {
          const existingIds = new Set(cached.cards.map((c) => c.sourceId))
          writeCache(
            [...cached.cards, ...fresh.filter((c) => !existingIds.has(c.sourceId))],
            cached.generatedAt,
          )
        } else {
          writeCache(fresh, Date.now())
        }
      }
      return { cards }
    },
  )

  // "Not interested" / "Already read" both exclude the card from future recs
  // (recommend() reads dismissed_recommendations). Keyed by sourceId so it matches
  // loadExclusions' id set. Also drop it from the cached snapshot so it vanishes
  // immediately without a refetch.
  ipcMain.handle('discover:dismiss', (_e, card: Recommendation): void => {
    run(
      `INSERT OR REPLACE INTO dismissed_recommendations (id, title, author, source, dismissed_at)
       VALUES (?, ?, ?, ?, ?)`,
      [card.sourceId, card.title, card.author, card.source, Date.now()],
    )
    const cached = readCache()
    if (cached) {
      writeCache(
        cached.cards.filter((c) => c.sourceId !== card.sourceId),
        cached.generatedAt,
      )
    }
  })

  // Guarded external-open (D4): the app denies all renderer-initiated navigation;
  // this narrow door only forwards validated http(s) card URLs to the browser.
  ipcMain.handle('discover:openExternal', async (_e, url: string): Promise<void> => {
    if (isHttpUrl(url)) await shell.openExternal(url)
  })
}
