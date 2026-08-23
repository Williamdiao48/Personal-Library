import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// bulkImport touches the DB only through db.all (owned-id lookup), the two site
// discoverers, captureUrl, and the post-capture hooks. Mock them all so the
// validation + dedup + queue logic runs offline and ABI-free (no better-sqlite3).
vi.mock('../db', () => ({ all: vi.fn(() => []) }))
vi.mock('./sites/ao3-bookmarks', () => ({ discoverAo3Bookmarks: vi.fn() }))
vi.mock('./sites/ffnet-favorites', () => ({ discoverFfnetFavorites: vi.fn() }))
vi.mock('../capture', () => ({ captureUrl: vi.fn() }))
vi.mock('../recommender/lifecycle', () => ({ triggerBackfill: vi.fn() }))
vi.mock('../cloud/uploader', () => ({ enqueueItemBackup: vi.fn(() => Promise.resolve()) }))
vi.mock('../cloud/sync/syncService', () => ({ notifyLocalMutation: vi.fn() }))

import {
  canonicalWorkId,
  normalizeAccountRef,
  discoverFavorites,
  runBulkImport,
  cancelBulkImport,
} from './bulkImport'
import { all } from '../db'
import { discoverAo3Bookmarks } from './sites/ao3-bookmarks'
import { discoverFfnetFavorites } from './sites/ffnet-favorites'
import { captureUrl } from '../capture'
import { triggerBackfill } from '../recommender/lifecycle'
import { enqueueItemBackup } from '../cloud/uploader'
import { notifyLocalMutation } from '../cloud/sync/syncService'

const mockAll = vi.mocked(all)
const mockAo3 = vi.mocked(discoverAo3Bookmarks)
const mockFfn = vi.mocked(discoverFfnetFavorites)
const mockCapture = vi.mocked(captureUrl)

/** Seed the owned-id DB lookup with the given source_urls. */
function owned(...urls: string[]): void {
  mockAll.mockReturnValue(urls.map((source_url) => ({ source_url })))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAll.mockReturnValue([]) // empty library by default
})

describe('canonicalWorkId', () => {
  it('reduces AO3 work URLs (query / chapter / scheme variants) to one id', () => {
    for (const url of [
      'https://archiveofourown.org/works/123',
      'https://archiveofourown.org/works/123?view_full_work=true',
      'https://archiveofourown.org/works/123/chapters/456',
      'http://archiveofourown.org/works/123',
    ]) {
      expect(canonicalWorkId(url)).toEqual({ kind: 'ao3', id: '123' })
    }
  })

  it('reduces FFN story URLs (with/without chapter+slug) to one id', () => {
    expect(canonicalWorkId('https://www.fanfiction.net/s/999/1/My-Slug')).toEqual({
      kind: 'ffn',
      id: '999',
    })
    expect(canonicalWorkId('https://www.fanfiction.net/s/999')).toEqual({ kind: 'ffn', id: '999' })
  })

  it('returns null for non-work URLs and cross-host mismatches', () => {
    expect(canonicalWorkId('https://example.com/works/1')).toBeNull() // /works/ but not AO3
    expect(canonicalWorkId('https://archiveofourown.org/users/x/bookmarks')).toBeNull()
    expect(canonicalWorkId('not a url')).toBeNull()
  })
})

describe('normalizeAccountRef', () => {
  it('accepts a bare AO3 username and extracts one from a profile URL', () => {
    expect(normalizeAccountRef('ao3', 'Some_User1')).toBe('Some_User1')
    expect(
      normalizeAccountRef('ao3', 'https://archiveofourown.org/users/Some_User1/bookmarks'),
    ).toBe('Some_User1')
  })

  it('accepts a bare FFN id and extracts one from a profile URL', () => {
    expect(normalizeAccountRef('ffn', '12345')).toBe('12345')
    expect(normalizeAccountRef('ffn', 'https://www.fanfiction.net/u/12345/Some-Name')).toBe('12345')
  })

  it('rejects refs that could inject path segments or are otherwise invalid', () => {
    expect(() => normalizeAccountRef('ao3', '../../etc')).toThrow(/valid AO3 username/)
    expect(() => normalizeAccountRef('ao3', 'has space')).toThrow(/valid AO3 username/)
    expect(() => normalizeAccountRef('ao3', '')).toThrow(/Enter an account reference/)
    expect(() => normalizeAccountRef('ffn', 'abc')).toThrow(/valid FanFiction/)
    expect(() => normalizeAccountRef('ffn', '12/../3')).toThrow(/valid FanFiction/)
  })
})

describe('discoverFavorites — AO3', () => {
  it('validates the ref, dispatches to the AO3 discoverer, and passes counts through', async () => {
    mockAo3.mockResolvedValue({
      works: [
        { url: 'https://archiveofourown.org/works/1', title: 'One', author: 'A' },
        { url: 'https://archiveofourown.org/works/2', title: 'Two', author: null },
      ],
      skippedSeries: 3,
      skippedExternal: 1,
      pagesFetched: 1,
    })

    const res = await discoverFavorites('ao3', 'https://archiveofourown.org/users/reader/bookmarks')

    expect(mockAo3).toHaveBeenCalledWith('reader', undefined)
    expect(res.ref).toBe('reader') // normalized out of the pasted URL
    expect(res.total).toBe(2)
    expect(res.skippedSeries).toBe(3)
    expect(res.skippedExternal).toBe(1)
    expect(res.alreadyInLibrary).toBe(0)
  })

  it('flags works already in the library by canonical id (ignoring URL variants)', async () => {
    // Library owns work 1 under a chapter-URL variant — must still match /works/1.
    owned('https://archiveofourown.org/works/1/chapters/99')
    mockAo3.mockResolvedValue({
      works: [
        {
          url: 'https://archiveofourown.org/works/1?view_full_work=true',
          title: 'Owned',
          author: null,
        },
        { url: 'https://archiveofourown.org/works/2', title: 'New', author: null },
      ],
      skippedSeries: 0,
      skippedExternal: 0,
      pagesFetched: 1,
    })

    const res = await discoverFavorites('ao3', 'reader')

    expect(res.alreadyInLibrary).toBe(1)
    expect(res.works.find((w) => w.title === 'Owned')?.alreadyInLibrary).toBe(true)
    expect(res.works.find((w) => w.title === 'New')?.alreadyInLibrary).toBe(false)
  })

  it('does not count trashed items as owned (soft delete → re-import allowed)', async () => {
    // A trashed work still has its source_url row, so the owned-id query must
    // exclude it — otherwise re-importing a just-deleted work is wrongly skipped.
    mockAo3.mockResolvedValue({
      works: [{ url: 'https://archiveofourown.org/works/1', title: 'Was Deleted', author: null }],
      skippedSeries: 0,
      skippedExternal: 0,
      pagesFetched: 1,
    })

    await discoverFavorites('ao3', 'reader')

    expect(mockAll).toHaveBeenCalledWith(expect.stringContaining('deleted_at IS NULL'))
  })

  it('de-duplicates the same work appearing twice within one batch', async () => {
    mockAo3.mockResolvedValue({
      works: [
        { url: 'https://archiveofourown.org/works/5', title: 'Dup A', author: null },
        { url: 'https://archiveofourown.org/works/5/chapters/1', title: 'Dup B', author: null },
        { url: 'https://archiveofourown.org/works/6', title: 'Unique', author: null },
      ],
      skippedSeries: 0,
      skippedExternal: 0,
      pagesFetched: 1,
    })

    const res = await discoverFavorites('ao3', 'reader')

    expect(res.total).toBe(2) // works 5 (first-seen) + 6
    expect(res.works.map((w) => w.title)).toEqual(['Dup A', 'Unique'])
  })

  it('rejects an invalid ref before any network call', async () => {
    await expect(discoverFavorites('ao3', '!!bad!!')).rejects.toThrow(/valid AO3 username/)
    expect(mockAo3).not.toHaveBeenCalled()
  })
})

describe('discoverFavorites — FFN', () => {
  it('dispatches to the FFN discoverer and reports a single-page progress tick', async () => {
    mockFfn.mockResolvedValue([
      { url: 'https://www.fanfiction.net/s/1/1/x', title: 'Fic', author: 'W', fandom: 'HP' },
    ])
    const onProgress = vi.fn()

    const res = await discoverFavorites('ffn', 'https://www.fanfiction.net/u/42/Name', onProgress)

    expect(mockFfn).toHaveBeenCalledWith('42')
    expect(res.ref).toBe('42')
    expect(res.total).toBe(1)
    expect(res.skippedSeries).toBe(0)
    expect(res.skippedExternal).toBe(0)
    expect(onProgress).toHaveBeenCalledWith(1, 1, 1)
  })
})

describe('discoverFavorites — cross-source content dedup (title|author)', () => {
  /** Seed the owned-item lookup with full rows (source_url + title + author). */
  function ownedItems(
    ...rows: { source_url?: string | null; title?: string | null; author?: string | null }[]
  ): void {
    mockAll.mockReturnValue(
      rows.map((r) => ({
        source_url: r.source_url ?? null,
        title: r.title ?? null,
        author: r.author ?? null,
      })),
    )
  }

  it('flags an FFN fic as owned when an AO3 item shares its normalized title+author', async () => {
    // Owned on AO3; the SAME fic is discovered on FFN (different site id, so the
    // canonical key can't match) — the normalized title|author must catch it, even
    // through case + punctuation differences.
    ownedItems({
      source_url: 'https://archiveofourown.org/works/1',
      title: 'The Same Fic',
      author: 'Jane Doe',
    })
    mockFfn.mockResolvedValue([
      { url: 'https://www.fanfiction.net/s/500/1/x', title: 'the same fic!', author: 'JANE  DOE' },
      {
        url: 'https://www.fanfiction.net/s/501/1/y',
        title: 'The Same Fic',
        author: 'Someone Else',
      },
    ])

    const res = await discoverFavorites('ffn', '42')

    expect(res.alreadyInLibrary).toBe(1)
    expect(res.works.find((w) => w.url.includes('/500/'))?.alreadyInLibrary).toBe(true)
    // Same title, different author → a different fic, not flagged.
    expect(res.works.find((w) => w.url.includes('/501/'))?.alreadyInLibrary).toBe(false)
  })

  it('does NOT content-match when the incoming work has no author (precision-first)', async () => {
    ownedItems({ source_url: 'https://archiveofourown.org/works/1', title: 'Solo', author: 'A' })
    mockFfn.mockResolvedValue([
      { url: 'https://www.fanfiction.net/s/1/1/x', title: 'Solo', author: null },
    ])

    const res = await discoverFavorites('ffn', '42')

    expect(res.alreadyInLibrary).toBe(0)
  })

  it('does NOT content-match when the owned item has no author', async () => {
    ownedItems({ source_url: 'https://archiveofourown.org/works/1', title: 'Solo', author: null })
    mockFfn.mockResolvedValue([
      { url: 'https://www.fanfiction.net/s/1/1/x', title: 'Solo', author: 'A' },
    ])

    const res = await discoverFavorites('ffn', '42')

    expect(res.alreadyInLibrary).toBe(0)
  })

  it('content-matches an owned import that has no fanfic source_url (e.g. an EPUB)', async () => {
    // A work imported as an EPUB has a title+author but no AO3/FFN source_url; it should
    // still de-dup an incoming cross-posted copy by content key.
    ownedItems({ source_url: null, title: 'Imported As Epub', author: 'Writer' })
    mockFfn.mockResolvedValue([
      { url: 'https://www.fanfiction.net/s/9/1/z', title: 'Imported as Epub', author: 'writer' },
    ])

    const res = await discoverFavorites('ffn', '42')

    expect(res.alreadyInLibrary).toBe(1)
  })
})

describe('runBulkImport', () => {
  const AO3 = (id: number) => `https://archiveofourown.org/works/${id}`

  beforeEach(() => {
    vi.useFakeTimers()
    mockCapture.mockResolvedValue({ id: 'item', title: 't', author: null, wordCount: 1 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Run to completion, draining the polite-delay timers. */
  async function run(opts: Parameters<typeof runBulkImport>[0]) {
    const promise = runBulkImport(opts)
    await vi.runAllTimersAsync()
    return promise
  }

  it('captures every work serially, in order, and finishes done', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    const final = await run({
      batchId: 'B1',
      urls: [AO3(1), AO3(2), AO3(3)],
      cloudBackup: false,
    })

    expect(mockCapture.mock.calls.map((c) => c[0])).toEqual([AO3(1), AO3(2), AO3(3)])
    // captureUrl is called noop-progress, no range, cloudBackup=false.
    expect(mockCapture).toHaveBeenCalledWith(AO3(1), expect.any(Function), undefined, false)
    expect(setTimeoutSpy).toHaveBeenCalled() // a polite delay ran between works
    expect(final).toMatchObject({ status: 'done', total: 3, done: 3, failed: 0, skipped: 0 })
  })

  it('skips works already in the library (canonical-id match) without capturing', async () => {
    owned(AO3(1)) // work 1 already owned; queue includes a chapter-URL variant of it
    const final = await run({
      batchId: 'B2',
      urls: ['https://archiveofourown.org/works/1/chapters/9', AO3(2)],
      cloudBackup: false,
    })

    expect(mockCapture).toHaveBeenCalledTimes(1)
    expect(mockCapture).toHaveBeenCalledWith(AO3(2), expect.any(Function), undefined, false)
    expect(final).toMatchObject({ status: 'done', done: 1, skipped: 1 })
  })

  it('de-duplicates a repeated work within the same batch', async () => {
    const final = await run({
      batchId: 'B3',
      urls: [AO3(5), 'https://archiveofourown.org/works/5?view_full_work=true', AO3(6)],
      cloudBackup: false,
    })
    expect(mockCapture).toHaveBeenCalledTimes(2) // work 5 once + work 6
    expect(final).toMatchObject({ done: 2, skipped: 1 })
  })

  it('counts a captureUrl dedup hit (result.duplicate) as skipped, not imported', async () => {
    // captureUrl's own post-parse dedup can collapse a work onto an existing item (a
    // cross-source content match the URL-only preview couldn't see). That must count
    // as skipped and fire no new-item hooks.
    mockCapture.mockResolvedValue({
      id: 'existing',
      title: 't',
      author: null,
      wordCount: null,
      duplicate: true,
    })
    const final = await run({ batchId: 'DUP', urls: [AO3(1)], cloudBackup: false })
    expect(final).toMatchObject({ status: 'done', done: 0, skipped: 1, failed: 0 })
    expect(triggerBackfill).not.toHaveBeenCalled()
    expect(notifyLocalMutation).not.toHaveBeenCalled()
  })

  it('fires the post-capture hooks on success; enqueues a backup only when cloudBackup', async () => {
    await run({ batchId: 'B4', urls: [AO3(1)], cloudBackup: true })
    expect(triggerBackfill).toHaveBeenCalled()
    expect(notifyLocalMutation).toHaveBeenCalled()
    expect(enqueueItemBackup).toHaveBeenCalledWith('item')

    vi.clearAllMocks()
    mockCapture.mockResolvedValue({ id: 'item', title: 't', author: null, wordCount: 1 })
    await run({ batchId: 'B4b', urls: [AO3(2)], cloudBackup: false })
    expect(enqueueItemBackup).not.toHaveBeenCalled()
  })

  it('trips the circuit breaker after N consecutive failures → throttled', async () => {
    mockCapture.mockRejectedValue(new Error('403'))
    const final = await run({
      batchId: 'B5',
      urls: [AO3(1), AO3(2), AO3(3), AO3(4), AO3(5), AO3(6)],
      cloudBackup: false,
    })
    // Stops at the 5th consecutive failure; each failed work was only re-queued
    // (attempt 1 of 3), so none is a *permanent* failure yet.
    expect(mockCapture).toHaveBeenCalledTimes(5)
    expect(final).toMatchObject({ status: 'throttled', done: 0, failed: 0 })
  })

  it('retries a transiently-failing work and succeeds on the retry', async () => {
    const [A, B] = [AO3(1), AO3(2)]
    let bTries = 0
    mockCapture.mockImplementation((url: string) => {
      if (url === B && bTries++ === 0) return Promise.reject(new Error('503'))
      return Promise.resolve({ id: 'item', title: 't', author: null, wordCount: 1 })
    })
    const final = await run({ batchId: 'R1', urls: [A, B], cloudBackup: false })
    // B fails once, is re-queued, and succeeds on the second try.
    expect(mockCapture.mock.calls.map((c) => c[0])).toEqual([A, B, B])
    expect(final).toMatchObject({ status: 'done', done: 2, failed: 0, retrying: 0 })
  })

  it('moves a failed work to the BACK of the queue (retried after the others)', async () => {
    const [A, B, C] = [AO3(1), AO3(2), AO3(3)]
    let aTries = 0
    mockCapture.mockImplementation((url: string) => {
      if (url === A && aTries++ === 0) return Promise.reject(new Error('x'))
      return Promise.resolve({ id: 'item', title: 't', author: null, wordCount: 1 })
    })
    const final = await run({ batchId: 'R2', urls: [A, B, C], cloudBackup: false })
    // A fails first, so B and C go before A's retry.
    expect(mockCapture.mock.calls.map((c) => c[0])).toEqual([A, B, C, A])
    expect(final).toMatchObject({ status: 'done', done: 3, failed: 0 })
  })

  it('gives up on a permanently-failing work after MAX_ATTEMPTS (3)', async () => {
    mockCapture.mockRejectedValue(new Error('gone'))
    const final = await run({ batchId: 'R3', urls: [AO3(1)], cloudBackup: false })
    // Tried 3× (not the breaker — a lone broken URL gives up before 5 consecutive).
    expect(mockCapture).toHaveBeenCalledTimes(3)
    expect(final).toMatchObject({ status: 'done', done: 0, failed: 1 })
  })

  it('reports works waiting for retry via the retrying count', async () => {
    const [A, B] = [AO3(1), AO3(2)]
    let bTries = 0
    mockCapture.mockImplementation((url: string) => {
      if (url === B && bTries++ === 0) return Promise.reject(new Error('503'))
      return Promise.resolve({ id: 'item', title: 't', author: null, wordCount: 1 })
    })
    const seen: number[] = []
    await run({
      batchId: 'R4',
      urls: [A, B],
      cloudBackup: false,
      onProgress: (p) => seen.push(p.retrying),
    })
    expect(Math.max(...seen)).toBe(1) // B counted as retrying after its first failure
  })

  it('stops promptly when cancelled mid-run and reports cancelled', async () => {
    const final = await (async () => {
      const promise = runBulkImport({
        batchId: 'B7',
        urls: [AO3(1), AO3(2), AO3(3)],
        cloudBackup: false,
      })
      // Let the first work capture and enter its inter-work delay, then cancel.
      await vi.advanceTimersByTimeAsync(0)
      cancelBulkImport('B7')
      await vi.runAllTimersAsync()
      return promise
    })()

    expect(mockCapture).toHaveBeenCalledTimes(1) // only the first work ran
    expect(final.status).toBe('cancelled')
  })

  it('emits a progress event per work with current set then cleared', async () => {
    const events: string[] = []
    const final = await run({
      batchId: 'B8',
      urls: [AO3(1)],
      cloudBackup: false,
      onProgress: (p) => events.push(`${p.status}:${p.done}:${p.current ?? '-'}`),
    })
    // A "current set" tick (before capture) then a cleared tick (after), then final.
    expect(events).toContain(`running:0:${AO3(1)}`)
    expect(events).toContain('running:1:-')
    expect(final.status).toBe('done')
  })
})
