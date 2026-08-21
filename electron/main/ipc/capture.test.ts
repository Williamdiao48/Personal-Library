import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke, resetIpc, dialog, fakeEvent } from '../../../test/stubs/electron'

// Mock the capture pipeline so this suite never loads the real module (and thus
// never pulls in better-sqlite3 / the DB): we only care that capture:start's
// scheme guard decides whether captureUrl is reached, and that the async
// progress/complete/error paths run.
vi.mock('../capture', () => ({
  captureUrl: vi.fn(() => Promise.resolve({ id: 'item-1' })),
  captureFile: vi.fn(() => Promise.resolve({ id: 'item-1' })),
  appendChapters: vi.fn(() => Promise.resolve({ id: 'item-1' })),
}))
// triggerBackfill is fired after a successful capture — stub it so the async
// completion path runs without loading the recommender/DB.
vi.mock('../recommender/lifecycle', () => ({ triggerBackfill: vi.fn() }))
// The Phase 2 cloud uploader (enqueued on opted-in capture) pulls in the DB +
// Supabase client — stub it so this suite stays DB-free and we just assert wiring.
vi.mock('../cloud/uploader', () => ({ enqueueItemBackup: vi.fn(() => Promise.resolve()) }))
// Tier 1 #3: a new/updated item schedules a debounced sync push — mock the trigger.
vi.mock('../cloud/sync/syncService', () => ({ notifyLocalMutation: vi.fn() }))
// Bulk-favorites discovery pulls in ../db via bulkImport — stub it so this suite
// stays DB-free and we just assert the IPC wiring (dispatch + progress forwarding).
vi.mock('../capture/bulkImport', () => ({ discoverFavorites: vi.fn() }))

import { registerCaptureHandlers, isHttpUrl } from './capture'
import { captureUrl, captureFile, appendChapters } from '../capture'
import { discoverFavorites } from '../capture/bulkImport'
import { triggerBackfill } from '../recommender/lifecycle'
import { enqueueItemBackup } from '../cloud/uploader'
import { notifyLocalMutation } from '../cloud/sync/syncService'

type Mock = ReturnType<typeof vi.fn>
/** Let the handler's fire-and-forget .then/.catch microtasks settle. */
const flush = () => new Promise((r) => setImmediate(r))

beforeEach(() => {
  resetIpc()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  ;(captureUrl as Mock).mockImplementation(() => Promise.resolve({ id: 'item-1' }))
  ;(captureFile as Mock).mockImplementation(() => Promise.resolve({ id: 'item-1' }))
  ;(appendChapters as Mock).mockImplementation(() => Promise.resolve({ id: 'item-1' }))
  registerCaptureHandlers()
})

describe('isHttpUrl', () => {
  it('accepts http/https and rejects every other scheme or non-string', () => {
    expect(isHttpUrl('http://example.com')).toBe(true)
    expect(isHttpUrl('https://example.com/story?page=2')).toBe(true)

    expect(isHttpUrl('file:///etc/passwd')).toBe(false)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('data:text/html,<b>hi</b>')).toBe(false)
    expect(isHttpUrl('ftp://host/file')).toBe(false)
    expect(isHttpUrl('')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
    expect(isHttpUrl(null)).toBe(false)
    expect(isHttpUrl(undefined)).toBe(false)
    expect(isHttpUrl(42 as unknown)).toBe(false)
  })
})

describe('capture:start — SEC-3 scheme guard', () => {
  // SEC-3: capture:start used to pass any string straight to captureUrl. A
  // non-http(s) URL must be refused at the boundary before the pipeline runs.
  it('regression SEC-3: rejects a non-http(s) URL without invoking the pipeline', async () => {
    const jobId = await invoke('capture:start', 'file:///etc/passwd')

    expect(typeof jobId).toBe('string') // contract preserved: a jobId still comes back
    expect(captureUrl).not.toHaveBeenCalled() // …but the pipeline was never reached
  })

  it('proceeds to the pipeline for a valid http(s) URL', async () => {
    // Never-resolving so the handler's .then/.catch don't run during the test.
    ;(captureUrl as Mock).mockReturnValue(new Promise(() => {}))

    await invoke('capture:start', 'https://example.com/story')

    expect(captureUrl).toHaveBeenCalledOnce()
    expect((captureUrl as Mock).mock.calls[0][0]).toBe('https://example.com/story')
  })

  it('threads the cloudBackup opt-in through to captureUrl (Phase 2)', async () => {
    ;(captureUrl as Mock).mockReturnValue(new Promise(() => {}))

    // Explicit opt-in → true reaches captureUrl's 4th arg.
    await invoke('capture:start', 'https://example.com/story', undefined, undefined, true)
    expect((captureUrl as Mock).mock.calls[0][3]).toBe(true)
    ;(captureUrl as Mock).mockClear()

    // Omitted → defaults to false (local-only), never undefined.
    await invoke('capture:start', 'https://example.com/story')
    expect((captureUrl as Mock).mock.calls[0][3]).toBe(false)
  })

  it('enqueues a cloud backup after an opted-in URL capture (Phase 2)', async () => {
    ;(captureUrl as Mock).mockResolvedValue({ id: 'item-1' })
    await invoke('capture:start', 'https://example.com/story', undefined, undefined, true)
    await flush()
    expect(enqueueItemBackup).toHaveBeenCalledWith('item-1')
  })

  it('does NOT enqueue a backup for a local-only URL capture', async () => {
    ;(captureUrl as Mock).mockResolvedValue({ id: 'item-1' })
    await invoke('capture:start', 'https://example.com/story')
    await flush()
    expect(enqueueItemBackup).not.toHaveBeenCalled()
  })

  it('emits progress then triggers a backfill on successful capture', async () => {
    ;(captureUrl as Mock).mockImplementation((_url, onProgress) => {
      onProgress('fetching chapter 1') // exercises the progress-forwarding callback
      return Promise.resolve({ id: 'item-9' })
    })

    await invoke('capture:start', 'https://example.com/story', 1, 3) // range branch too
    await flush()

    expect(captureUrl).toHaveBeenCalledOnce()
    expect((captureUrl as Mock).mock.calls[0][2]).toEqual({ start: 1, end: 3 })
    expect(triggerBackfill).toHaveBeenCalledOnce()
  })

  it('swallows a capture failure via the error path (no backfill)', async () => {
    ;(captureUrl as Mock).mockRejectedValue(new Error('network down'))

    const jobId = await invoke('capture:start', 'https://example.com/story')
    await flush()

    expect(typeof jobId).toBe('string')
    expect(triggerBackfill).not.toHaveBeenCalled()
  })
})

describe('capture:discoverFavorites', () => {
  const RESULT = {
    source: 'ao3' as const,
    ref: 'someuser',
    works: [{ url: 'https://archiveofourown.org/works/1', title: 'A', author: null }],
    total: 1,
    alreadyInLibrary: 0,
    skippedSeries: 0,
    skippedExternal: 0,
  }

  it('dispatches to discoverFavorites and returns the preview result', async () => {
    ;(discoverFavorites as Mock).mockResolvedValue(RESULT)

    const result = await invoke('capture:discoverFavorites', 'ao3', 'someuser')

    expect(discoverFavorites).toHaveBeenCalledWith('ao3', 'someuser', expect.any(Function))
    expect(result).toEqual(RESULT)
  })

  it('forwards page progress to the capture:discoverProgress channel', async () => {
    ;(discoverFavorites as Mock).mockImplementation((_s, _r, onProgress) => {
      onProgress(2, 24, 30) // simulate the AO3 multi-page walk reporting page 2/24
      return Promise.resolve(RESULT)
    })
    const sendSpy = vi.spyOn(fakeEvent.sender, 'send')

    await invoke('capture:discoverFavorites', 'ao3', 'someuser')

    expect(sendSpy).toHaveBeenCalledWith('capture:discoverProgress', {
      source: 'ao3',
      ref: 'someuser',
      page: 2,
      totalPages: 24,
      found: 30,
    })
  })

  it('rejects an unknown source without touching the discoverer', () => {
    expect(() => invoke('capture:discoverFavorites', 'bogus', 'x')).toThrow(/Unknown import source/)
    expect(discoverFavorites).not.toHaveBeenCalled()
  })

  it('propagates a validation rejection (e.g. a bad account ref)', async () => {
    ;(discoverFavorites as Mock).mockRejectedValue(new Error('Enter a valid AO3 username'))
    await expect(invoke('capture:discoverFavorites', 'ao3', '!!bad!!')).rejects.toThrow(
      /valid AO3 username/,
    )
  })
})

describe('capture:append', () => {
  it('emits progress then triggers a backfill on success', async () => {
    ;(appendChapters as Mock).mockImplementation((_id, _end, onProgress) => {
      onProgress('appending')
      return Promise.resolve({ id: 'item-1', wordCount: 42 })
    })

    await invoke('capture:append', 'item-1', 7)
    await flush()

    expect(appendChapters).toHaveBeenCalledWith('item-1', 7, expect.any(Function))
    expect(triggerBackfill).toHaveBeenCalledOnce()
  })

  it('swallows an append failure via the error path', async () => {
    ;(appendChapters as Mock).mockRejectedValue(new Error('append boom'))

    const jobId = await invoke('capture:append', 'item-1', 7)
    await flush()

    expect(typeof jobId).toBe('string')
    expect(triggerBackfill).not.toHaveBeenCalled()
  })
})

describe('capture:fromFile', () => {
  it('imports the chosen file and triggers a backfill', async () => {
    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({
      canceled: false,
      filePaths: ['/books/novel.epub'],
    })

    const result = await invoke('capture:fromFile')

    // cloudBackup defaults to false when the renderer omits it (local-only).
    expect(captureFile).toHaveBeenCalledWith('/books/novel.epub', false)
    expect(triggerBackfill).toHaveBeenCalledOnce()
    expect(result).toEqual({ id: 'item-1' })
  })

  it('threads the cloudBackup opt-in through to captureFile (Phase 2)', async () => {
    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({
      canceled: false,
      filePaths: ['/books/novel.epub'],
    })

    await invoke('capture:fromFile', true)
    expect(captureFile).toHaveBeenCalledWith('/books/novel.epub', true)
    expect(enqueueItemBackup).toHaveBeenCalledWith('item-1')
  })

  it('returns null and imports nothing when the dialog is canceled', async () => {
    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({ canceled: true, filePaths: [] })

    expect(await invoke('capture:fromFile')).toBeNull()
    expect(captureFile).not.toHaveBeenCalled()
  })
})

describe('post-mutation sync trigger (Tier 1 #3)', () => {
  const notify = vi.mocked(notifyLocalMutation)

  it('a successful capture schedules a sync push for the new item', async () => {
    await invoke('capture:start', 'https://example.com/story')
    await flush() // let the fire-and-forget .then run
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('a rejected (non-http) capture does NOT schedule a push', async () => {
    await invoke('capture:start', 'file:///etc/passwd')
    await flush()
    expect(notify).not.toHaveBeenCalled()
  })

  it('a byte-identical duplicate import mints no row → no push', async () => {
    ;(captureFile as Mock).mockResolvedValueOnce({ id: 'item-1', duplicate: true })
    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({
      canceled: false,
      filePaths: ['/x.epub'],
    })
    await invoke('capture:fromFile')
    expect(notify).not.toHaveBeenCalled()
  })
})
