import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// backfillSourceTags re-fetches each stale fic's work page then parses + persists.
// Mock the network layer (used by both the AO3 http path and the FFN browser path)
// and drive the real parse + DB persistence against an in-memory DB (Node ABI).
vi.mock('../capture/fetch', () => ({
  fetchPage: vi.fn(),
  fetchPageWithBrowser: vi.fn(),
  fetchPagesWithSession: vi.fn(),
  fetchPagesSequential: vi.fn(),
}))

import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'
import { all } from '../db'
import { fetchPage, fetchPageWithBrowser } from '../capture/fetch'
import { backfillSourceTags } from './backfillSourceTags'

const mockFetchPage = vi.mocked(fetchPage)
const mockBrowser = vi.mocked(fetchPageWithBrowser)

const AO3_HTML = `<html><body>
  <dl class="work meta group">
    <dd class="fandom tags"><a class="tag">Harry Potter - J. K. Rowling</a></dd>
    <dd class="freeform tags"><a class="tag">Slow Burn</a></dd>
  </dl>
  <dl class="stats"><dd class="kudos">2,500</dd><dd class="chapters">5/5</dd></dl>
</body></html>`

const FFN_HTML = `<html><body><div id="profile_top">
  <span class="xgray xcontrast_txt">Rated: T - English - Adventure - Chapters: 1 - Words: 100 - Favs: 5 - Status: Complete - id: 1</span>
</div></body></html>`

const tagsOf = (itemId: string): { name: string; category: string }[] =>
  all<{ name: string; category: string }>(
    `SELECT name, category FROM item_source_tags WHERE item_id = ?`,
    [itemId],
  )

describe('backfillSourceTags', () => {
  let db: TestDb
  beforeEach(() => {
    db = openTestDb()
    mockFetchPage.mockReset()
    mockBrowser.mockReset()
  })
  afterEach(() => closeTestDb())

  it('backfills AO3 (http) + FFN (browser) items, skipping non-fanfic and already-tagged', async () => {
    const ao3 = seedItem(db, { source_url: 'https://archiveofourown.org/works/1' })
    const ffn = seedItem(db, { source_url: 'https://www.fanfiction.net/s/1/1/x' })
    seedItem(db, { source_url: 'https://example.com/story' }) // non-fanfic → excluded
    const tagged = seedItem(db, { source_url: 'https://archiveofourown.org/works/2' })
    db.prepare(
      `INSERT INTO item_source_tags (item_id, name, category) VALUES (?, 'Extant', 'fandom')`,
    ).run(tagged) // already has tags → excluded

    mockFetchPage.mockResolvedValue(AO3_HTML)
    mockBrowser.mockResolvedValue(FFN_HTML)

    const res = await backfillSourceTags({ delayMs: 0 })

    expect(res).toEqual({ processed: 2, updated: 2, failed: 0 })
    expect(mockFetchPage).toHaveBeenCalledTimes(1) // only the untagged AO3 item
    expect(mockBrowser).toHaveBeenCalledTimes(1)
    expect(tagsOf(ao3)).toContainEqual({ name: 'Harry Potter - J. K. Rowling', category: 'fandom' })
    expect(tagsOf(ffn)).toContainEqual({ name: 'Adventure', category: 'genre' })
  })

  it('counts a fetch failure without sinking the batch', async () => {
    seedItem(db, { source_url: 'https://archiveofourown.org/works/9' })
    mockFetchPage.mockRejectedValue(new Error('network down'))

    const res = await backfillSourceTags({ delayMs: 0 })
    expect(res).toEqual({ processed: 1, updated: 0, failed: 1 })
  })
})
