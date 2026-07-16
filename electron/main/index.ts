import { app, BrowserWindow, protocol, net, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { initDatabase } from './db'
import { safeUserDataPath } from './security/paths'
import { assertPublicHttpUrl } from './security/net-guard'
import { registerLibraryHandlers } from './ipc/library'
import { registerCaptureHandlers } from './ipc/capture'
import { registerReaderHandlers } from './ipc/reader'
import { registerCollectionHandlers } from './ipc/collections'
import { registerConvertHandlers } from './ipc/convert'
import { registerStatsHandlers } from './ipc/stats'
import { registerBackupHandlers } from './ipc/backup'
import { registerGoalsHandlers } from './ipc/goals'
import { registerAnnotationHandlers } from './ipc/annotations'
import { registerUpdaterHandlers } from './ipc/updater'
import { registerLogHandlers } from './ipc/log'
import { registerDiscoverHandlers } from './ipc/discover'
import { registerDictionaryHandlers } from './ipc/dictionary'
import { registerLlmHandlers } from './ipc/llm'
import { shutdownParseWorker } from './workers/parse-host'
import { shutdownBackfill } from './recommender/lifecycle'

// Stop WebRTC from reaching out to STUN servers. The hidden capture windows
// (capture/fetch.ts) load real pages whose bot-detection/fingerprinting scripts
// open an RTCPeerConnection to stun.l.google.com; Chromium then spams
// "Failed to resolve address for stun.l.google.com" (ERR_NAME_NOT_RESOLVED) to
// the log. We never use WebRTC, and disabling non-proxied UDP keeps the API
// present (so those scripts see no difference) while preventing the STUN traffic.
// Must be set before app is ready.
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp')

// Must be called before app.whenReady()
protocol.registerSchemesAsPrivileged([
  { scheme: 'library', privileges: { secure: true, standard: true, supportFetchAPI: true } },
])

// Single-instance lock — required for protocol handler on Windows/Linux
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

// Holds a URL received before the window exists
let pendingCaptureUrl: string | null = null

async function handleProtocolUrl(raw: string): Promise<void> {
  try {
    const parsed = new URL(raw)
    if (parsed.hostname !== 'save') return
    const pageUrl = parsed.searchParams.get('url')
    if (!pageUrl) return

    // Scheme + host guard (F4). A website triggers this URL, so the capture
    // destination is attacker-controlled: reject non-http(s) schemes AND
    // private/internal hosts (localhost, LAN, cloud metadata) before we induce
    // a capture of it. Any rejection is swallowed by the catch below.
    await assertPublicHttpUrl(pageUrl)

    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('request-capture', pageUrl)
    } else {
      pendingCaptureUrl = pageUrl
    }
  } catch {
    // malformed URL — ignore
  }
}

// macOS: fired when a personallibrary:// link is opened
app.on('open-url', (event, url) => {
  event.preventDefault()
  void handleProtocolUrl(url)
})

// Windows/Linux: new instance launched with protocol URL in argv
app.on('second-instance', (_event, argv) => {
  const url = argv.find((arg) => arg.startsWith('personallibrary://'))
  if (url) void handleProtocolUrl(url)

  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
})

app.setAsDefaultProtocolClient('personallibrary')

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  win.once('ready-to-show', () => {
    win.show()
    // Deliver a URL that arrived before the window was created
    if (pendingCaptureUrl) {
      win.webContents.send('request-capture', pendingCaptureUrl)
      pendingCaptureUrl = null
    }
    // Check for updates 3s after launch so startup performance isn't affected.
    // Only runs in packaged builds — dev always has app.isPackaged = false.
    if (app.isPackaged) {
      setTimeout(() => autoUpdater.checkForUpdates(), 3000)
    }
  })

  // ── Navigation hardening ──────────────────────────────────────────────────
  //
  // Block all main-frame navigation away from the renderer origin.
  // This is the primary defence against PDF links, injected scripts, or any
  // other content that tries to redirect the Electron window to an external URL.
  // React's HashRouter uses fragment-only changes which do NOT fire will-navigate,
  // so legitimate in-app routing is unaffected.
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  // Block all renderer-initiated new-window requests (window.open, target="_blank",
  // etc.).  The previous implementation called shell.openExternal() unconditionally,
  // which could be exploited by PDF content or injected scripts to launch
  // arbitrary URLs in the user's default browser.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  // Serve userData/* via library:// so the renderer can display cover images.
  // Guard against path traversal via the shared F1 helper (security/paths.ts),
  // which resolves the path and refuses anything escaping userData.
  protocol.handle('library', (request) => {
    const relative = request.url.slice('library://'.length)
    let filePath: string
    try {
      filePath = safeUserDataPath(relative)
    } catch {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(`file://${filePath}`).then((res) => {
      const headers = new Headers(res.headers)
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(res.body, { status: res.status, headers })
    })
  })

  try {
    initDatabase()
    registerLibraryHandlers()
    registerCaptureHandlers()
    registerReaderHandlers()
    registerCollectionHandlers()
    registerConvertHandlers()
    registerStatsHandlers()
    registerGoalsHandlers()
    registerAnnotationHandlers()
    registerUpdaterHandlers()
    registerBackupHandlers()
    registerLogHandlers()
    registerDiscoverHandlers()
    registerDictionaryHandlers()
    registerLlmHandlers()
  } catch (err) {
    dialog.showErrorBox(
      'Personal Library failed to start',
      `Startup error: ${err instanceof Error ? err.message : String(err)}\n\nIf this keeps happening, delete ~/Library/Application Support/personal-library/library.db and relaunch.`,
    )
    app.quit()
    return
  }

  createWindow()

  // The embedding backfill is NOT armed here. Embeddings serve only the Discover
  // recommender, so the renderer arms it (via `discover:setEnabled`) once it has
  // read the user's `enableDiscover` setting after boot — a user who keeps
  // Discover off does no model load or embed work.

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Tear down the sandboxed workers (parse — F7; embed — C2.6) so they don't
// outlive the app.
app.on('will-quit', () => {
  shutdownParseWorker()
  shutdownBackfill()
})
