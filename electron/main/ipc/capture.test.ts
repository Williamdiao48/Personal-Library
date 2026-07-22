import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke, resetIpc, dialog } from '../../../test/stubs/electron'

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

import { registerCaptureHandlers, isHttpUrl } from './capture'
import { captureUrl, captureFile, appendChapters } from '../capture'
import { triggerBackfill } from '../recommender/lifecycle'

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

    expect(captureFile).toHaveBeenCalledWith('/books/novel.epub')
    expect(triggerBackfill).toHaveBeenCalledOnce()
    expect(result).toEqual({ id: 'item-1' })
  })

  it('returns null and imports nothing when the dialog is canceled', async () => {
    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({ canceled: true, filePaths: [] })

    expect(await invoke('capture:fromFile')).toBeNull()
    expect(captureFile).not.toHaveBeenCalled()
  })
})
