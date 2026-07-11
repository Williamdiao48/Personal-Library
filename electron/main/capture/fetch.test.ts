import { describe, it, expect, vi, beforeEach } from 'vitest'

// fetch.ts drives a real (hidden) BrowserWindow's webContents events and, for
// the session-cookie path, electron's `session.defaultSession.fetch`. Neither
// is in the shared test/stubs/electron.ts stub (too thin: no event emitter,
// no session at all) — build a richer fake local to this file only, since no
// other main-project suite needs this surface.
const { FakeBrowserWindow, sessionFetchMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events')
  class FakeBrowserWindow {
    static instances: InstanceType<typeof FakeBrowserWindow>[] = []
    webContents: any
    loadURL = vi.fn()
    destroy = vi.fn()
    constructor() {
      this.webContents = new EventEmitter()
      this.webContents.executeJavaScript = vi.fn()
      FakeBrowserWindow.instances.push(this)
    }
  }
  return { FakeBrowserWindow, sessionFetchMock: vi.fn() }
})

vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    BrowserWindow: FakeBrowserWindow,
    session: { defaultSession: { fetch: sessionFetchMock } },
  }
})

import {
  fetchPage,
  fetchJson,
  fetchPageWithBrowser,
  fetchPagesSequential,
  fetchPagesWithSession,
} from './fetch'

function latestWindow(): InstanceType<typeof FakeBrowserWindow> {
  return FakeBrowserWindow.instances[FakeBrowserWindow.instances.length - 1]
}

// One extra microtask hop past a resolved promise's own .then() — enough for
// fetch.ts's `.then(html => ...)` chains to run before we inspect state.
function flush(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve())
}

function okResponse(text: string) {
  return { ok: true, text: async () => text } as Response
}
function notOkResponse(status: number, statusText = 'Error') {
  return { ok: false, status, statusText } as Response
}

beforeEach(() => {
  FakeBrowserWindow.instances.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fetchPage', () => {
  it('returns text on a 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('hello')))
    await expect(fetchPage('https://x.test')).resolves.toBe('hello')
  })

  it('throws on a non-ok, non-403/429 status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(notOkResponse(500, 'Server Error')))
    await expect(fetchPage('https://x.test')).rejects.toThrow(
      'Failed to fetch page: 500 Server Error',
    )
  })

  it.each([403, 429])('falls back to the browser on a %d response', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(notOkResponse(status)))
    const p = fetchPage('https://x.test')
    await flush()
    const win = latestWindow()
    win.webContents.executeJavaScript.mockResolvedValue('<html>recovered</html>')
    win.webContents.emit('did-finish-load')
    await expect(p).resolves.toBe('<html>recovered</html>')
  })
})

describe('fetchJson', () => {
  it('returns the raw body and requests JSON (Accept + XHR headers)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('[{"name":"Harry Potter"}]'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchJson('https://x.test/autocomplete/character?term=Harry')).resolves.toBe(
      '[{"name":"Harry Potter"}]',
    )
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers.Accept).toBe('application/json')
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest')
  })

  it('fails fast on a 4xx/3xx (no retry, no browser fallback)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(notOkResponse(302, 'Found'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchJson('https://x.test')).rejects.toThrow('Failed to fetch JSON: 302 Found')
    expect(fetchMock).toHaveBeenCalledTimes(1) // not retried
    expect(FakeBrowserWindow.instances.length).toBe(0)
  })

  it('retries a transient 5xx (e.g. AO3 525) and then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(notOkResponse(525, 'Origin SSL'))
      .mockResolvedValueOnce(okResponse('[]'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchJson('https://x.test')).resolves.toBe('[]')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after exhausting retries on a persistent 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(notOkResponse(525, 'Origin SSL')))
    await expect(fetchJson('https://x.test', 0)).rejects.toThrow('525') // retries=0 → fail fast
  })
})

describe('fetchPageWithBrowser', () => {
  it('resolves with the rendered html on did-finish-load', async () => {
    const p = fetchPageWithBrowser('https://x.test')
    const win = latestWindow()
    win.webContents.executeJavaScript.mockResolvedValue('<html>ok</html>')
    win.webContents.emit('did-finish-load')
    await expect(p).resolves.toBe('<html>ok</html>')
  })

  it('re-arms past a Cloudflare interstitial and resolves with the post-challenge html', async () => {
    const p = fetchPageWithBrowser('https://x.test')
    const win = latestWindow()
    win.webContents.executeJavaScript.mockResolvedValueOnce('<title>Just a moment...</title>')
    win.webContents.emit('did-finish-load')
    await flush()
    win.webContents.executeJavaScript.mockResolvedValueOnce('<html>real content</html>')
    win.webContents.emit('did-finish-load')
    await expect(p).resolves.toBe('<html>real content</html>')
  })

  it('ignores a non-main-frame did-fail-load', async () => {
    const p = fetchPageWithBrowser('https://x.test')
    const win = latestWindow()
    win.webContents.emit('did-fail-load', {}, -100, 'blocked ad', 'https://ad.test', false)
    await flush()
    expect(win.destroy).not.toHaveBeenCalled()
    win.webContents.executeJavaScript.mockResolvedValue('<html>ok</html>')
    win.webContents.emit('did-finish-load')
    await expect(p).resolves.toBe('<html>ok</html>')
  })

  it('ignores ERR_ABORTED (-3) on the main frame', async () => {
    const p = fetchPageWithBrowser('https://x.test')
    const win = latestWindow()
    win.webContents.emit('did-fail-load', {}, -3, 'aborted', 'https://x.test', true)
    await flush()
    expect(win.destroy).not.toHaveBeenCalled()
    win.webContents.executeJavaScript.mockResolvedValue('<html>ok</html>')
    win.webContents.emit('did-finish-load')
    await expect(p).resolves.toBe('<html>ok</html>')
  })

  it('rejects on a fatal main-frame did-fail-load', async () => {
    const p = fetchPageWithBrowser('https://x.test')
    const win = latestWindow()
    win.webContents.emit('did-fail-load', {}, -105, 'name not resolved', 'https://x.test', true)
    await expect(p).rejects.toThrow('Failed to load page: name not resolved')
    expect(win.destroy).toHaveBeenCalledTimes(1)
  })

  it('rejects after 45s if the page never finishes loading', async () => {
    vi.useFakeTimers()
    const p = fetchPageWithBrowser('https://x.test')
    const win = latestWindow()
    const assertion = expect(p).rejects.toThrow('Page load timed out (45s)')
    await vi.advanceTimersByTimeAsync(45_000)
    await assertion
    expect(win.destroy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('destroys exactly once when a fail-load fires after the page already resolved', async () => {
    const p = fetchPageWithBrowser('https://x.test')
    const win = latestWindow()
    win.webContents.executeJavaScript.mockResolvedValue('<html>done</html>')
    win.webContents.emit('did-finish-load')
    await expect(p).resolves.toBe('<html>done</html>')
    win.webContents.emit('did-fail-load', {}, -999, 'spurious', 'https://x.test', true)
    expect(win.destroy).toHaveBeenCalledTimes(1)
  })
})

describe('fetchPagesSequential', () => {
  it('resolves immediately with [] for no urls', async () => {
    await expect(fetchPagesSequential([])).resolves.toEqual([])
    expect(FakeBrowserWindow.instances).toHaveLength(0)
  })

  it('walks multiple urls with one shared window, reporting progress', async () => {
    vi.useFakeTimers()
    const onProgress = vi.fn()
    const p = fetchPagesSequential(['https://a.test', 'https://b.test'], 500, onProgress)
    const win = latestWindow()
    win.webContents.executeJavaScript.mockResolvedValueOnce('<html>a</html>')
    win.webContents.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(500) // inter-page delay before page 2 loads
    win.webContents.executeJavaScript.mockResolvedValueOnce('<html>b</html>')
    win.webContents.emit('did-finish-load')
    await expect(p).resolves.toEqual(['<html>a</html>', '<html>b</html>'])
    expect(FakeBrowserWindow.instances).toHaveLength(1)
    expect(onProgress).toHaveBeenNthCalledWith(1, 0, 2)
    expect(onProgress).toHaveBeenNthCalledWith(2, 1, 2)
    vi.useRealTimers()
  })

  it('rejects on a fatal load failure partway through the batch', async () => {
    const p = fetchPagesSequential(['https://a.test', 'https://b.test'], 0)
    const win = latestWindow()
    win.webContents.emit('did-fail-load', {}, -105, 'name not resolved', 'https://a.test', true)
    await expect(p).rejects.toThrow('Failed to load: name not resolved')
  })
})

describe('fetchPagesWithSession', () => {
  it('resolves [] for no urls without touching the session', async () => {
    await expect(fetchPagesWithSession([])).resolves.toEqual([])
    expect(sessionFetchMock).not.toHaveBeenCalled()
  })

  it('collects text from ok responses via the session fetch', async () => {
    sessionFetchMock.mockResolvedValue({ ok: true, text: async () => 'chapter text' })
    await expect(fetchPagesWithSession(['https://a.test'], 0)).resolves.toEqual(['chapter text'])
  })

  it('marks a non-ok response as a failure without retrying via the browser', async () => {
    sessionFetchMock.mockResolvedValue({ ok: false, status: 403 })
    await expect(fetchPagesWithSession(['https://a.test'], 0)).resolves.toEqual([''])
    expect(FakeBrowserWindow.instances).toHaveLength(0)
  })

  it('falls back to the real browser on a network/timeout error', async () => {
    sessionFetchMock.mockRejectedValue(new Error('timeout'))
    const p = fetchPagesWithSession(['https://a.test'], 0)
    await flush()
    const win = latestWindow()
    win.webContents.executeJavaScript.mockResolvedValue('<html>recovered</html>')
    win.webContents.emit('did-finish-load')
    await expect(p).resolves.toEqual(['<html>recovered</html>'])
  })

  it('stops calling out once the consecutive-failure threshold trips', async () => {
    sessionFetchMock.mockResolvedValue({ ok: false, status: 429 })
    const urls = Array.from({ length: 5 }, (_, i) => `https://x.test/${i}`)
    const results = await fetchPagesWithSession(urls, 0, undefined, 2)
    expect(results).toEqual(['', '', '', '', ''])
    expect(sessionFetchMock).toHaveBeenCalledTimes(2)
  })
})
