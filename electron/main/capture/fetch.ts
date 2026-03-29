import { BrowserWindow, session as electronSession } from 'electron'

// Shared content shape returned by all site strategies
export interface SiteContent {
  title: string
  author: string | null
  html: string        // sanitized HTML to store
  textContent: string // plain text for FTS and word count
  coverUrl?: string | null  // absolute URL of a cover image to download (optional)
}

export const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

// Plain fetch with browser-like headers. Falls back to the real browser on 403/429.
export async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: BROWSER_HEADERS,
  })
  if (res.ok) return res.text()
  if (res.status === 403 || res.status === 429) return fetchPageWithBrowser(url)
  throw new Error(`Failed to fetch page: ${res.status} ${res.statusText}`)
}

// Opens a hidden BrowserWindow (real Chromium) to load the page.
// Handles JS execution, real cookies, and browser fingerprinting.
//
// CF JS challenges show "Just a moment…" as the page title while the challenge
// script runs, then redirect to the real page. We detect that signature and
// re-arm the did-finish-load listener so we wait for the final destination
// rather than capturing the challenge scaffold. The timeout is raised to 45 s
// to accommodate the extra round-trip.
export function fetchPageWithBrowser(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ show: false })
    let settled = false

    const timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      win.webContents.removeListener('did-fail-load', onFailLoad)
      win.destroy()
      reject(new Error('Page load timed out (45s)'))
    }, 45_000)

    function settle(err: Error | null, html?: string) {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      win.webContents.removeListener('did-fail-load', onFailLoad)
      win.destroy()
      if (err) reject(err)
      else resolve(html!)
    }

    // did-fail-load fires for every frame, including ads and iframes that are
    // blocked or error out — those must not abort the main-page load.
    // ERR_ABORTED (-3) fires when a navigation is superseded; also not fatal.
    function onFailLoad(
      _e: Electron.Event,
      code: number,
      description: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ) {
      if (!isMainFrame || code === -3) return
      settle(new Error(`Failed to load page: ${description}`))
    }

    function onFinishLoad() {
      win.webContents
        .executeJavaScript('document.documentElement.outerHTML')
        .then((html: string) => {
          // CF Turnstile / JS-challenge pages always carry "Just a moment" in
          // the <title>. Re-arm and wait for the post-challenge redirect.
          if (/<title[^>]*>\s*Just a moment/i.test(html)) {
            win.webContents.once('did-finish-load', onFinishLoad)
            return
          }
          settle(null, html)
        })
        .catch((err: Error) => settle(err))
    }

    win.webContents.on('did-fail-load', onFailLoad)
    win.webContents.once('did-finish-load', onFinishLoad)
    win.loadURL(url)
  })
}

// Reuses a single BrowserWindow to navigate through multiple URLs in order.
// Significantly faster than creating one window per URL — shares session and cookies.
// Essential for multi-chapter fanfiction sites that use session cookies.
//
// Uses a recursive .once() pattern (not a persistent .on()) so that each page
// gets exactly one load handler — prevents phantom fires from redirects or
// intermediate navigations consuming the wrong slot in the results array.
// A small inter-page delay also helps avoid bot-detection rate limits.
export function fetchPagesSequential(
  urls: string[],
  delayMs = 1200,
  onProgress?: (index: number, total: number) => void,
): Promise<string[]> {
  if (!urls.length) return Promise.resolve([])

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ show: false })
    const results: string[] = []
    let loadTimer: ReturnType<typeof setTimeout>
    let settled = false

    function cleanup() {
      if (settled) return
      settled = true
      clearTimeout(loadTimer)
      win.webContents.removeListener('did-fail-load', onFailLoad)
      win.destroy()
    }

    // Registered once for the lifetime of the window — not per page.
    // Only main-frame failures are fatal; sub-frame failures (ads, iframes,
    // blocked third-party scripts) must be ignored or they abort the entire
    // capture. ERR_ABORTED (-3) fires when a navigation supersedes a pending
    // one — normal and non-fatal.
    function onFailLoad(
      _e: Electron.Event,
      code: number,
      description: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ) {
      if (!isMainFrame || code === -3) return
      cleanup()
      reject(new Error(`Failed to load: ${description}`))
    }
    win.webContents.on('did-fail-load', onFailLoad)

    function loadNext(index: number) {
      if (index >= urls.length) {
        cleanup()
        resolve(results)
        return
      }

      // Notify caller before each fetch so the UI can show current progress
      onProgress?.(index, urls.length)

      // Per-page timeout: reset for every new navigation
      clearTimeout(loadTimer)
      loadTimer = setTimeout(() => {
        cleanup()
        reject(new Error(`Page load timed out: ${urls[index]}`))
      }, 45_000)

      // Named handler so it can re-arm itself when a CF "Just a moment"
      // challenge page is detected — same pattern as fetchPageWithBrowser.
      function onFinishLoad() {
        clearTimeout(loadTimer)
        win.webContents
          .executeJavaScript('document.documentElement.outerHTML')
          .then(async (html: string) => {
            // CF JS-challenge page — re-arm and wait for the post-challenge redirect
            if (/<title[^>]*>\s*Just a moment/i.test(html)) {
              loadTimer = setTimeout(() => {
                cleanup()
                reject(new Error(`CF challenge timed out: ${urls[index]}`))
              }, 45_000)
              win.webContents.once('did-finish-load', onFinishLoad)
              return
            }

            results.push(html)

            // Brief pause before the next request to avoid rate-limiting
            if (index + 1 < urls.length) {
              await new Promise<void>(r => setTimeout(r, delayMs))
            }

            loadNext(index + 1)
          })
          .catch((err: Error) => {
            cleanup()
            reject(err)
          })
      }

      // One-shot listener per page so prior navigations' events don't bleed
      // into the wrong slot in the results array
      win.webContents.once('did-finish-load', onFinishLoad)

      win.loadURL(urls[index])
    }

    loadNext(0)
  })
}

// Fetches multiple pages using the Electron session cookie store instead of
// navigating a visible BrowserWindow. This is dramatically faster than
// fetchPagesSequential because there is no rendering overhead — it is a plain
// HTTP request that nevertheless carries all session cookies (including the
// cf_clearance CloudFlare cookie) that were established when the caller
// previously loaded the site's first page through a real BrowserWindow.
//
// On any non-ok response (403, 429, 5xx…) the slot is filled with '' and the
// failure is counted. Once maxConsecutiveFailures is reached all remaining
// slots are filled with '' instantly (no delay, no browser spawning) so the
// caller's validation pass can batch-refetch them via fetchPagesSequential.
// This avoids the 1 s → 3 s → 8 s per-chapter retry penalty that was causing
// 2-minute loads when CF rate-limited after chapter ~20.
export async function fetchPagesWithSession(
  urls: string[],
  delayMs = 150,
  onProgress?: (index: number, total: number) => void,
  maxConsecutiveFailures = 10,
): Promise<string[]> {
  if (!urls.length) return []

  const warmSession = electronSession.defaultSession
  const results: string[] = []
  let consecutiveFailures = 0

  for (let i = 0; i < urls.length; i++) {
    onProgress?.(i, urls.length)

    // Rate-limited session — stop hammering it and let the caller's browser
    // fallback handle the rest in one efficient batch.
    if (consecutiveFailures >= maxConsecutiveFailures) {
      results.push('')
      continue // no delay: we're just filling placeholders
    }

    let html = ''
    try {
      const res = await warmSession.fetch(urls[i], {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(10_000),
      }) as Response

      if (res.ok) {
        html = await res.text()
        consecutiveFailures = 0
      } else {
        // Non-ok (403, 429, 5xx…) — mark blocked, no retry
        consecutiveFailures++
      }
    } catch {
      // Network / timeout — try a real browser once to recover the session
      try {
        html = await fetchPageWithBrowser(urls[i])
        consecutiveFailures = 0
      } catch {
        consecutiveFailures++
      }
    }

    results.push(html)

    if (i < urls.length - 1 && delayMs > 0) {
      await new Promise<void>(r => setTimeout(r, delayMs))
    }
  }

  return results
}
