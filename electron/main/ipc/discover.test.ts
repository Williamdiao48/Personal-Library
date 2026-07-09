import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { invoke, resetIpc, shell } from '../../../test/stubs/electron'
import { openTestDb, closeTestDb } from '../../../test/db/harness'
import { get } from '../db'
import type { Recommendation } from '../../../src/types'

// The engine (recommend), the embedder singleton, and taste are mocked so this
// suite never loads the model / network — it exercises the IPC glue only: the
// discover_cache read/write, dismiss persistence + cache pruning, cold-start
// short-circuit, and the openExternal scheme guard. The real (in-memory) DB is
// used (Node ABI) so the cache + dismissed_recommendations behaviour is genuine.

const recommendMock = vi.fn<() => Promise<Recommendation[]>>(async () => [])
const buildTasteMock = vi.fn(() => ({ centroids: [new Float32Array([1])], liked: [] }))

vi.mock('../recommender/rerank', () => ({
  recommend: (...a: unknown[]) => recommendMock(...(a as [])),
}))
vi.mock('../recommender/embedder', () => ({ embedder: {} }))
vi.mock('../recommender/taste', () => ({ buildTaste: () => buildTasteMock() }))

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

beforeEach(() => {
  resetIpc()
  vi.clearAllMocks()
  recommendMock.mockResolvedValue([])
  buildTasteMock.mockReturnValue({ centroids: [new Float32Array([1])], liked: [] })
  openTestDb()
  registerDiscoverHandlers()
})
afterEach(() => closeTestDb())

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
    // Persisted for the next get().
    const row = get<{ cards_json: string }>(`SELECT cards_json FROM discover_cache WHERE id = 1`)
    expect(JSON.parse(row!.cards_json)[0].title).toBe('Fresh')
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
