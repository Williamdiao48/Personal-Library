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

// The guarded fetchPage path routes through net-guard's `safeFetch`. Stub only
// that seam (its real body does DNS + a live fetch) while keeping the REAL
// SsrfBlockedError class, so fetchPage's `instanceof SsrfBlockedError` check
// matches the errors these tests throw. The unguarded default path never calls
// safeFetch, so this mock is inert for every existing test above.
const safeFetchMock = vi.hoisted(() => vi.fn())
vi.mock('../security/net-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../security/net-guard')>()
  return { ...actual, safeFetch: safeFetchMock }
})

import {
  fetchPage,
  fetchJson,
  fetchPageWithBrowser,
  fetchPagesSequential,
  fetchPagesWithSession,
  formatRetryAfter,
} from './fetch'
import { SsrfBlockedError } from '../security/net-guard'

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
function notOkResponse(status: number, statusText = 'Error', headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok: false,
    status,
    statusText,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
  } as unknown as Response
}

beforeEach(() => {
  FakeBrowserWindow.instances.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  safeFetchMock.mockReset()
})

describe('fetchPage', () => {
  it('returns text on a 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('hello')))
    await expect(fetchPage('https://x.test')).resolves.toBe('hello')
  })

  it('throws on a persistent non-ok, non-403/429 status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(notOkResponse(500, 'Server Error')))
    // retries=0 → fail fast without the backoff wait; a persistent 5xx is surfaced,
    // not masked behind a browser fallback that would "load" the origin error page.
    await expect(fetchPage('https://x.test', 0)).rejects.toThrow(
      'Failed to fetch page: 500 Server Error',
    )
    expect(FakeBrowserWindow.instances).toHaveLength(0)
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

  it('retries a transient timeout and then succeeds (no browser needed)', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
      .mockResolvedValueOnce(okResponse('recovered'))
    vi.stubGlobal('fetch', fetchMock)
    const p = fetchPage('https://x.test')
    await vi.advanceTimersByTimeAsync(500) // first attempt rejects, backoff elapses, retry runs
    await expect(p).resolves.toBe('recovered')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(FakeBrowserWindow.instances).toHaveLength(0)
    vi.useRealTimers()
  })

  it('retries a transient 5xx and then succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(notOkResponse(525, 'Origin SSL'))
      .mockResolvedValueOnce(okResponse('recovered'))
    vi.stubGlobal('fetch', fetchMock)
    const p = fetchPage('https://x.test')
    await vi.advanceTimersByTimeAsync(500)
    await expect(p).resolves.toBe('recovered')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('falls back to the real browser after exhausting retries on a persistent timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('The operation was aborted due to timeout')),
    )
    const p = fetchPage('https://x.test', 1) // 2 attempts, both time out
    await vi.advanceTimersByTimeAsync(500) // single backoff between the two attempts
    await flush()
    const win = latestWindow()
    win.webContents.executeJavaScript.mockResolvedValue('<html>via browser</html>')
    win.webContents.emit('did-finish-load')
    await expect(p).resolves.toBe('<html>via browser</html>')
    vi.useRealTimers()
  })

  // A bot-protection / CDN edge (Booksie's 502, Cloudflare's 520–527) serves 5xx to
  // the plain fetch but real content to a genuine browser — so a persistent one of
  // these is browser-fell-back like a 403/429, not surfaced as a dead end.
  it.each([502, 503, 520, 525])(
    'falls back to the browser on a persistent %d (bot-protection / edge 5xx)',
    async (status) => {
      vi.useFakeTimers()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(notOkResponse(status, 'Edge Error')))
      const p = fetchPage('https://x.test', 1) // 2 attempts, both 5xx
      await vi.advanceTimersByTimeAsync(500) // single backoff between the two attempts
      await flush()
      const win = latestWindow()
      win.webContents.executeJavaScript.mockResolvedValue('<html>via browser</html>')
      win.webContents.emit('did-finish-load')
      await expect(p).resolves.toBe('<html>via browser</html>')
      vi.useRealTimers()
    },
  )

  // 500 (origin app error) and 504 (real gateway timeout) are NOT the bot-protection
  // family — a browser won't help, so they stay surfaced rather than loading the
  // origin's error page as if it were content.
  it.each([500, 504])(
    'still throws without a browser on a persistent %d (not an edge status)',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(notOkResponse(status, 'Err')))
      await expect(fetchPage('https://x.test', 0)).rejects.toThrow(
        `Failed to fetch page: ${status}`,
      )
      expect(FakeBrowserWindow.instances).toHaveLength(0)
    },
  )

  // A 5xx that carries Retry-After is an explicit throttle (Booksie's 502 +
  // Retry-After: 60) — fail fast with an actionable message, no retry, no 45s
  // browser hang (the browser would hit the same wall).
  it('fails fast with a throttle message on a 5xx carrying Retry-After (no browser, no retry)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(notOkResponse(502, 'Bad Gateway', { 'Retry-After': '60' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchPage('https://www.booksie.com/782326-x')).rejects.toThrow(
      'www.booksie.com is temporarily throttling requests (502). Try again in ~60s.',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1) // no retry — Retry-After outlasts the backoff
    expect(FakeBrowserWindow.instances).toHaveLength(0) // no browser fallback
  })

  it('still browser-falls-back on an edge 5xx WITHOUT Retry-After (silent bot-block)', async () => {
    vi.useFakeTimers()
    // no Retry-After header → treated as a possible bot-block, worth the browser
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(notOkResponse(502, 'Bad Gateway')))
    const p = fetchPage('https://x.test', 1)
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    const win = latestWindow()
    win.webContents.executeJavaScript.mockResolvedValue('<html>via browser</html>')
    win.webContents.emit('did-finish-load')
    await expect(p).resolves.toBe('<html>via browser</html>')
    vi.useRealTimers()
  })
})

describe('formatRetryAfter', () => {
  it('renders delta-seconds under 90s as "~Ns"', () => {
    expect(formatRetryAfter('60')).toBe('~60s')
    expect(formatRetryAfter('5')).toBe('~5s')
  })

  it('renders larger delta-seconds as "~N min"', () => {
    expect(formatRetryAfter('180')).toBe('~3 min')
  })

  it('parses an HTTP-date form relative to now', () => {
    const inTwoMin = new Date(Date.now() + 120_000).toUTCString()
    expect(formatRetryAfter(inTwoMin)).toBe('~2 min')
  })

  it('falls back to a vague phrase for an unparseable or past value', () => {
    expect(formatRetryAfter('not-a-number')).toBe('a little while')
    expect(formatRetryAfter('0')).toBe('a little while')
  })
})

// M2 Option B: when the caller opts into the redirect guard (public start URL),
// fetchPage routes the request through safeFetch, which re-validates every
// redirect hop against the private-IP block, and a block is fatal (no browser
// fallback to the private target).
describe('fetchPage — guarded redirect (M2 Option B)', () => {
  it('routes through safeFetch (not plain fetch) and returns its body', async () => {
    const plainFetch = vi.fn()
    vi.stubGlobal('fetch', plainFetch)
    safeFetchMock.mockResolvedValue(okResponse('guarded-ok'))

    await expect(fetchPage('https://x.test', 2, 30_000, true)).resolves.toBe('guarded-ok')
    expect(safeFetchMock).toHaveBeenCalledTimes(1)
    expect(plainFetch).not.toHaveBeenCalled() // guarded path bypasses raw fetch
  })

  it('rethrows an SSRF block WITHOUT falling back to the browser', async () => {
    safeFetchMock.mockRejectedValue(new SsrfBlockedError('resolves to a private/internal address'))

    // 0 retries so we assert the block is fatal on the first attempt, not after backoff.
    await expect(fetchPage('https://x.test', 0, 30_000, true)).rejects.toBeInstanceOf(
      SsrfBlockedError,
    )
    // The whole point: a private redirect target must never be loaded via the
    // real-browser fallback (which would follow the 302 itself).
    expect(FakeBrowserWindow.instances).toHaveLength(0)
  })

  it('still falls back to the browser on a genuine (non-SSRF) network error', async () => {
    vi.useFakeTimers()
    safeFetchMock.mockRejectedValue(new Error('The operation was aborted due to timeout'))

    const p = fetchPage('https://x.test', 1, 30_000, true) // 2 attempts, both time out
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    const win = latestWindow()
    win.webContents.executeJavaScript.mockResolvedValue('<html>via browser</html>')
    win.webContents.emit('did-finish-load')
    await expect(p).resolves.toBe('<html>via browser</html>')
    vi.useRealTimers()
  })

  it('does NOT call safeFetch on the default (unguarded) path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('plain')))
    await expect(fetchPage('https://x.test')).resolves.toBe('plain')
    expect(safeFetchMock).not.toHaveBeenCalled()
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
