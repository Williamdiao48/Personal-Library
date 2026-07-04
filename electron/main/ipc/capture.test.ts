import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke, resetIpc } from '../../../test/stubs/electron'

// Mock the capture pipeline so this suite never loads the real module (and thus
// never pulls in better-sqlite3 / the DB): we only care that capture:start's
// scheme guard decides whether captureUrl is reached.
vi.mock('../capture', () => ({
  captureUrl: vi.fn(() => Promise.resolve({ id: 'item-1' })),
  captureFile: vi.fn(() => Promise.resolve({ id: 'item-1' })),
  appendChapters: vi.fn(() => Promise.resolve({ id: 'item-1' })),
}))

import { registerCaptureHandlers, isHttpUrl } from './capture'
import { captureUrl } from '../capture'

beforeEach(() => {
  resetIpc()
  vi.clearAllMocks()
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
    ;(captureUrl as unknown as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))

    await invoke('capture:start', 'https://example.com/story')

    expect(captureUrl).toHaveBeenCalledOnce()
    expect((captureUrl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'https://example.com/story',
    )
  })
})
