import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  openTestDb,
  closeTestDb,
  seedItem,
  seedTag,
  tagItem,
  type TestDb,
} from '../../../test/db/harness'
import { runBackfill, scheduleBackfill, _resetBackfillState } from './backfill'
import { getEmbedding, getAllEmbeddingMeta, upsertEmbedding } from './store'
import { itemMetadataText } from './embeddingText'
import { embeddingContentHash } from './embeddingCodec'
import type { EmbedHost } from './embedHost'
import { run } from '../db'

// Backfill orchestration — needs the better-sqlite3 Node ABI (openTestDb). Only
// the embedder is stubbed; the store + reconciler run for real against the DB.

const MODEL = 'bge-1'
const VEC = Float32Array.from([0.1, 0.2, 0.3, 0.4])

/** A stub EmbedHost that records which items it embedded (by title). */
function stubHost(
  opts: { modelVersion?: string; failTitles?: string[]; onEmbed?: () => void } = {},
): EmbedHost & { calls: string[] } {
  const calls: string[] = []
  const fail = new Set(opts.failTitles ?? [])
  return {
    modelVersion: opts.modelVersion ?? MODEL,
    calls,
    async embed(item) {
      calls.push(item.title)
      opts.onEmbed?.()
      if (fail.has(item.title)) throw new Error(`boom: ${item.title}`)
      return VEC
    },
  }
}

/** The hash a fresh embedding of this exact item state would store. */
function freshHash(
  fields: {
    title: string
    author?: string | null
    description?: string | null
    review?: string | null
    content_hash?: string | null
  },
  tags: string[] = [],
): string {
  const meta = itemMetadataText(
    {
      title: fields.title,
      author: fields.author ?? null,
      description: fields.description ?? null,
      review: fields.review ?? null,
    },
    tags,
  )
  return embeddingContentHash(meta, fields.content_hash ?? null)
}

afterEach(() => {
  _resetBackfillState()
  vi.useRealTimers()
  closeTestDb()
})

describe('runBackfill', () => {
  it('embeds only the stale set and writes rows with the right model + hash', async () => {
    const db: TestDb = openTestDb()
    const fresh = seedItem(db, { title: 'Fresh', content_hash: 'hf' })
    const missing = seedItem(db, { title: 'Missing', content_hash: 'hm' })
    // `fresh` already has a current row; `missing` has none.
    upsertEmbedding({
      itemId: fresh,
      embedding: VEC,
      modelVersion: MODEL,
      contentHash: freshHash({ title: 'Fresh', content_hash: 'hf' }),
    })

    const host = stubHost()
    const res = await runBackfill(host)

    expect(host.calls).toEqual(['Missing']) // Fresh skipped
    expect(res).toEqual({ scanned: 2, stale: 1, embedded: 1, failed: 0 })

    const row = getEmbedding(missing)
    expect(row).toBeDefined()
    expect(row!.modelVersion).toBe(MODEL)
    expect(row!.contentHash).toBe(freshHash({ title: 'Missing', content_hash: 'hm' }))
    expect(Array.from(row!.embedding)).toEqual(Array.from(VEC))
  })

  it('a second run right after is a no-op (everything fresh)', async () => {
    const db = openTestDb()
    seedItem(db, { title: 'A' })
    seedItem(db, { title: 'B' })

    const host = stubHost()
    await runBackfill(host)
    expect(host.calls.sort()).toEqual(['A', 'B'])

    host.calls.length = 0
    const res = await runBackfill(host)
    expect(host.calls).toEqual([])
    expect(res.embedded).toBe(0)
    expect(res.stale).toBe(0)
  })

  it('re-embeds only the item whose Tier-A metadata changed', async () => {
    const db = openTestDb()
    const a = seedItem(db, { title: 'A' })
    seedItem(db, { title: 'B' })
    const host = stubHost()
    await runBackfill(host)
    host.calls.length = 0

    run('UPDATE items SET title = ? WHERE id = ?', ['A-renamed', a])
    const res = await runBackfill(host)

    expect(host.calls).toEqual(['A-renamed']) // only A re-embedded; B untouched
    expect(res.embedded).toBe(1)
  })

  it('a rating change is NOT a re-embed (rating is not in the hash)', async () => {
    const db = openTestDb()
    const a = seedItem(db, { title: 'A' })
    const host = stubHost()
    await runBackfill(host)
    host.calls.length = 0

    run('UPDATE items SET rating = ? WHERE id = ?', [5, a])
    const res = await runBackfill(host)

    expect(host.calls).toEqual([])
    expect(res.embedded).toBe(0)
  })

  it('re-embeds when items.content_hash changes (Tier-B full text)', async () => {
    const db = openTestDb()
    const a = seedItem(db, { title: 'A', content_hash: 'v1' })
    const host = stubHost()
    await runBackfill(host)
    host.calls.length = 0

    run('UPDATE items SET content_hash = ? WHERE id = ?', ['v2', a])
    const res = await runBackfill(host)

    expect(host.calls).toEqual(['A'])
    expect(res.embedded).toBe(1)
    // the stored hash tracks the new content, so the *next* run skips it
    host.calls.length = 0
    await runBackfill(host)
    expect(host.calls).toEqual([])
  })

  it('re-embeds when tags change', async () => {
    const db = openTestDb()
    const a = seedItem(db, { title: 'A' })
    const host = stubHost()
    await runBackfill(host)
    host.calls.length = 0

    const t = seedTag(db, 'fantasy')
    tagItem(db, a, t)
    const res = await runBackfill(host)

    expect(host.calls).toEqual(['A'])
    expect(res.embedded).toBe(1)
  })

  it('a failed embed is counted and skipped without aborting the pass', async () => {
    const db = openTestDb()
    const bad = seedItem(db, { title: 'Bad' })
    const good = seedItem(db, { title: 'Good' })
    const host = stubHost({ failTitles: ['Bad'] })

    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await runBackfill(host)

    expect(res).toEqual({ scanned: 2, stale: 2, embedded: 1, failed: 1 })
    expect(getEmbedding(good)).toBeDefined()
    expect(getEmbedding(bad)).toBeUndefined() // no row for the failed item
  })

  it('coalesces concurrent runs onto one in-flight pass (guard)', async () => {
    const db = openTestDb()
    seedItem(db, { title: 'A' })
    seedItem(db, { title: 'B' })
    const host = stubHost()

    const [r1, r2] = await Promise.all([runBackfill(host), runBackfill(host)])

    expect(host.calls.sort()).toEqual(['A', 'B']) // each embedded once, not twice
    expect(r1).toBe(r2) // second caller got the same in-flight promise
  })
})

describe('scheduleBackfill', () => {
  it('debounces a burst of triggers into a single run', async () => {
    const db = openTestDb()
    seedItem(db, { title: 'A' })
    seedItem(db, { title: 'B' })
    const host = stubHost()

    vi.useFakeTimers()
    scheduleBackfill(host, 1000)
    scheduleBackfill(host, 1000)
    scheduleBackfill(host, 1000) // three triggers, one run
    expect(host.calls).toEqual([]) // nothing until the debounce elapses

    await vi.advanceTimersByTimeAsync(1000)

    expect(host.calls.sort()).toEqual(['A', 'B'])
    expect(getAllEmbeddingMeta()).toHaveLength(2)
  })
})
