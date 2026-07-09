import { ipcMain, shell } from 'electron'
import { get, run } from '../db'
import { recommend } from '../recommender/rerank'
import { embedder } from '../recommender/embedder'
import { buildTaste } from '../recommender/taste'
import { isHttpUrl } from './capture'
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
  // Instant: the last cached picks (no network, no model). null = never run yet.
  ipcMain.handle('discover:get', (): CachedDiscover | null => readCache())

  // The only path that runs the engine. `coldStart` (empty taste centroids) is
  // computed up front so the UI can show "learn your taste" rather than a bare
  // empty state; recommend() also returns [] in that case (it re-derives taste,
  // an accepted small duplication on a manual, user-initiated action).
  ipcMain.handle(
    'discover:refresh',
    async (): Promise<{ cards: Recommendation[]; generatedAt: number; coldStart: boolean }> => {
      const coldStart = buildTaste().centroids.length === 0
      const cards = coldStart ? [] : await recommend(embedder)
      const generatedAt = Date.now()
      writeCache(cards, generatedAt)
      return { cards, generatedAt, coldStart }
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
