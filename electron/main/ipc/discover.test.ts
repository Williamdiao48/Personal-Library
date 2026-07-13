import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { invoke, resetIpc, shell } from '../../../test/stubs/electron'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'
import { get } from '../db'
import type { Recommendation } from '../../../src/types'

// The engine (recommend), the worker embedder, and taste are mocked so this suite
// never loads the model / network — it exercises the IPC glue only: the
// discover_cache read/write, dismiss persistence + cache pruning, cold-start
// short-circuit, and the openExternal scheme guard. The real (in-memory) DB is
// used (Node ABI) so the cache + dismissed_recommendations behaviour is genuine.

const recommendMock = vi.fn<(...a: unknown[]) => Promise<Recommendation[]>>(async () => [])
const buildTasteMock = vi.fn(() => ({ centroids: [new Float32Array([1])], liked: [] }))
const armBackfillMock = vi.fn()
const disarmBackfillMock = vi.fn()
// Hoisted so the (hoisted) vi.mock factory below can reference it eagerly — a plain
// top-level const would be read before initialization.
const { workerEmbedderStub } = vi.hoisted(() => ({
  workerEmbedderStub: { embed: async () => [] },
}))

vi.mock('../recommender/rerank', () => ({
  recommend: (...a: unknown[]) => recommendMock(...a),
}))
vi.mock('../workers/embed-host', () => ({ workerEmbedder: workerEmbedderStub }))
vi.mock('../recommender/taste', () => ({ buildTaste: () => buildTasteMock() }))
vi.mock('../recommender/lifecycle', () => ({
  armBackfill: () => armBackfillMock(),
  disarmBackfill: () => disarmBackfillMock(),
}))

import { registerDiscoverHandlers } from './discover'

const rec = (over: Partial<Recommendation> = {}): Recommendation => ({
  title: 'A Fic',
  author: 'Ficcer',
  coverUrl: null,
  sourceId: 'https://archiveofourown.org/works/1',
  source: 'ao3',
  url: 'https://archiveofourown.org/works/1',
  subjects: ['Harry Potter'],
  matchedTags: ['Harry Potter'],
  score: 0.9,
  ...over,
})

let db: TestDb
beforeEach(() => {
  resetIpc()
  vi.clearAllMocks()
  recommendMock.mockResolvedValue([])
  buildTasteMock.mockReturnValue({ centroids: [new Float32Array([1])], liked: [] })
  db = openTestDb()
  registerDiscoverHandlers()
})
afterEach(() => closeTestDb())

describe('discover:setEnabled', () => {
  it('arms the backfill when enabled', async () => {
    await invoke('discover:setEnabled', true)
    expect(armBackfillMock).toHaveBeenCalledTimes(1)
    expect(disarmBackfillMock).not.toHaveBeenCalled()
  })

  it('disarms the backfill when disabled', async () => {
    await invoke('discover:setEnabled', false)
    expect(disarmBackfillMock).toHaveBeenCalledTimes(1)
    expect(armBackfillMock).not.toHaveBeenCalled()
  })
})

describe('discover:get', () => {
  it('returns null when nothing has been cached yet', async () => {
    expect(await invoke('discover:get')).toBeNull()
  })

  it('returns the cached snapshot written by a prior refresh (no engine call)', async () => {
    const cards = [rec({ title: 'Cached' })]
    recommendMock.mockResolvedValue(cards)
    await invoke('discover:refresh')

    recommendMock.mockClear()
    const cached = (await invoke('discover:get')) as {
      cards: Recommendation[]
      generatedAt: number
    }
    expect(cached.cards.map((c) => c.title)).toEqual(['Cached'])
    expect(typeof cached.generatedAt).toBe('number')
    expect(recommendMock).not.toHaveBeenCalled() // get never runs the engine
  })

  it('drops a cached card the user has since added to the library (no reappearance)', async () => {
    const keep = rec({ title: 'Keep', sourceId: 'https://archiveofourown.org/works/keep' })
    const added = rec({ title: 'Added Fic', sourceId: 'https://archiveofourown.org/works/added' })
    recommendMock.mockResolvedValue([keep, added])
    await invoke('discover:refresh')

    // The user adds that fic to the library — captured with its source page as source_url.
    seedItem(db, {
      title: 'Added Fic',
      author: 'Ficcer',
      source_url: 'https://archiveofourown.org/works/added',
    })

    const out = (await invoke('discover:get')) as { cards: Recommendation[] }
    expect(out.cards.map((c) => c.title)).toEqual(['Keep']) // 'Added Fic' reconciled out
  })
})

describe('discover:refresh', () => {
  it('runs the engine, caches the result, and reports not-cold-start', async () => {
    const cards = [rec({ title: 'Fresh' })]
    recommendMock.mockResolvedValue(cards)

    const out = (await invoke('discover:refresh')) as {
      cards: Recommendation[]
      generatedAt: number
      coldStart: boolean
    }
    expect(out.coldStart).toBe(false)
    expect(out.cards.map((c) => c.title)).toEqual(['Fresh'])
    expect(recommendMock).toHaveBeenCalledTimes(1)
    // Taste is built once and passed in (worker embedder + the prebuilt taste), so
    // recommend() doesn't rebuild it — the off-thread embedder is the 1st arg, the
    // prebuilt taste the 3rd.
    const [embedderArg, , tasteArg] = recommendMock.mock.calls[0]
    expect(embedderArg).toBe(workerEmbedderStub)
    expect(tasteArg).toMatchObject({ centroids: expect.any(Array) })
    // Persisted for the next get().
    const row = get<{ cards_json: string }>(`SELECT cards_json FROM discover_cache WHERE id = 1`)
    expect(JSON.parse(row!.cards_json)[0].title).toBe('Fresh')
    // Requests a whole page (not the bare TOP_K=12) — widening is near-free.
    const optsArg = recommendMock.mock.calls[0][3] as {
      limit?: number
      excludeIds?: string[]
      fresh?: boolean
    }
    expect(optsArg.limit).toBeGreaterThan(12)
    expect(optsArg.fresh).toBe(true) // a Refresh is a "fresh" fetch (soft-floor gradient)
    expect(optsArg.excludeIds).toEqual([]) // nothing on screen → no rotation exclusions
  })

  it('forwards the on-screen ids as excludeIds so a still-warm refresh rotates', async () => {
    recommendMock.mockResolvedValue([rec({ title: 'Next', sourceId: 'id-next' })])
    await invoke('discover:refresh', ['id-1', 'id-2'])
    const opts = recommendMock.mock.calls[0][3] as { excludeIds?: string[]; fresh?: boolean }
    expect(opts.excludeIds).toEqual(['id-1', 'id-2'])
    expect(opts.fresh).toBe(true)
  })

  it('wraps to the top (retries without excludeIds) when the rotated pool is exhausted', async () => {
    recommendMock.mockResolvedValueOnce([]) // excluded pass: nothing left — end of pool
    recommendMock.mockResolvedValueOnce([rec({ title: 'Top', sourceId: 'id-top' })]) // wrap
    const out = (await invoke('discover:refresh', ['id-1'])) as { cards: Recommendation[] }
    expect(out.cards.map((c) => c.title)).toEqual(['Top'])
    expect(recommendMock).toHaveBeenCalledTimes(2)
    const wrapOpts = recommendMock.mock.calls[1][3] as { excludeIds?: string[] }
    expect(wrapOpts.excludeIds).toEqual([]) // wrapped: exclusions cleared
  })

  it('does not wrap when the refresh had no exclusions to begin with', async () => {
    recommendMock.mockResolvedValue([]) // genuinely empty (e.g. no candidates found)
    const out = (await invoke('discover:refresh', [])) as { cards: Recommendation[] }
    expect(out.cards).toEqual([])
    expect(recommendMock).toHaveBeenCalledTimes(1) // no wrap retry
  })

  it('short-circuits on a cold-start library — no engine call, coldStart true', async () => {
    buildTasteMock.mockReturnValue({ centroids: [], liked: [] })

    const out = (await invoke('discover:refresh')) as {
      cards: Recommendation[]
      coldStart: boolean
    }
    expect(out.coldStart).toBe(true)
    expect(out.cards).toEqual([])
    expect(recommendMock).not.toHaveBeenCalled()
  })
})

describe('discover:more', () => {
  it('runs the engine excluding the shown ids and appends the new cards to the cache', async () => {
    // Seed a first page in the cache.
    const a = rec({ title: 'A', sourceId: 'id-a' })
    const b = rec({ title: 'B', sourceId: 'id-b' })
    recommendMock.mockResolvedValue([a, b])
    await invoke('discover:refresh')

    // Next page returns a genuinely-new card.
    const c = rec({ title: 'C', sourceId: 'id-c' })
    recommendMock.mockResolvedValue([c])
    const out = (await invoke('discover:more', ['id-a', 'id-b'])) as { cards: Recommendation[] }

    expect(out.cards.map((x) => x.title)).toEqual(['C'])
    // The engine was told to exclude the shown ids (4th-arg opts).
    const opts = recommendMock.mock.calls[1][3] as { limit?: number; excludeIds?: string[] }
    expect(opts.excludeIds).toEqual(['id-a', 'id-b'])
    expect(opts.limit).toBeGreaterThan(12)
    // Cache is now the accumulated feed A,B,C (survives a restart / next get()).
    const cached = (await invoke('discover:get')) as { cards: Recommendation[] }
    expect(cached.cards.map((x) => x.title)).toEqual(['A', 'B', 'C'])
  })

  it('short-circuits on cold start — no engine call, empty cards', async () => {
    buildTasteMock.mockReturnValue({ centroids: [], liked: [] })
    const out = (await invoke('discover:more', [])) as { cards: Recommendation[] }
    expect(out.cards).toEqual([])
    expect(recommendMock).not.toHaveBeenCalled()
  })

  it('does not duplicate a card already in the cached feed', async () => {
    const a = rec({ title: 'A', sourceId: 'id-a' })
    recommendMock.mockResolvedValue([a])
    await invoke('discover:refresh')

    // Engine (contrived) returns the already-cached card plus a new one.
    recommendMock.mockResolvedValue([a, rec({ title: 'D', sourceId: 'id-d' })])
    await invoke('discover:more', []) // empty exclusions → existing-id guard is what dedups

    const cached = (await invoke('discover:get')) as { cards: Recommendation[] }
    expect(cached.cards.map((x) => x.title)).toEqual(['A', 'D'])
  })
})

describe('discover:dismiss', () => {
  it('persists an exclusion keyed by sourceId and prunes the card from the cache', async () => {
    const keep = rec({ title: 'Keep', sourceId: 'https://ao3/works/keep' })
    const drop = rec({ title: 'Drop', sourceId: 'https://ao3/works/drop' })
    recommendMock.mockResolvedValue([keep, drop])
    await invoke('discover:refresh')

    await invoke('discover:dismiss', drop)

    // Excluded for future recommend() runs (loadExclusions reads this table).
    const row = get<{ id: string; source: string }>(
      `SELECT id, source FROM dismissed_recommendations WHERE id = ?`,
      ['https://ao3/works/drop'],
    )
    expect(row).toMatchObject({ id: 'https://ao3/works/drop', source: 'ao3' })

    // Gone from the cached snapshot immediately (no refetch).
    const cached = (await invoke('discover:get')) as { cards: Recommendation[] }
    expect(cached.cards.map((c) => c.title)).toEqual(['Keep'])
  })
})

describe('discover:openExternal — scheme guard (D4)', () => {
  it('forwards a valid http(s) card URL to the browser', async () => {
    const spy = vi.spyOn(shell, 'openExternal')
    await invoke('discover:openExternal', 'https://archiveofourown.org/works/1')
    expect(spy).toHaveBeenCalledWith('https://archiveofourown.org/works/1')
  })

  it('refuses a non-http(s) URL — never reaches shell.openExternal', async () => {
    const spy = vi.spyOn(shell, 'openExternal')
    await invoke('discover:openExternal', 'file:///etc/passwd')
    await invoke('discover:openExternal', 'javascript:alert(1)')
    expect(spy).not.toHaveBeenCalled()
  })
})
