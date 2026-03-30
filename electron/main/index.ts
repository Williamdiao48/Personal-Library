import { app, BrowserWindow, protocol, net } from 'electron'
import { join, resolve, sep } from 'path'
import { initDatabase } from './db'
import { registerLibraryHandlers } from './ipc/library'
import { registerCaptureHandlers } from './ipc/capture'
import { registerReaderHandlers } from './ipc/reader'
import { registerCollectionHandlers } from './ipc/collections'
import { registerConvertHandlers } from './ipc/convert'
import { registerStatsHandlers }   from './ipc/stats'
import { registerBackupHandlers }  from './ipc/backup'
import { registerGoalsHandlers }   from './ipc/goals'

// Must be called before app.whenReady()
protocol.registerSchemesAsPrivileged([
  { scheme: 'library', privileges: { secure: true, standard: true, supportFetchAPI: true } }
])

// Single-instance lock — required for protocol handler on Windows/Linux
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

// Holds a URL received before the window exists
let pendingCaptureUrl: string | null = null

function handleProtocolUrl(raw: string): void {
  try {
    const parsed = new URL(raw)
    if (parsed.hostname !== 'save') return
    const pageUrl = parsed.searchParams.get('url')
    if (!pageUrl) return

    // Only allow http(s) URLs — reject file://, javascript:, etc.
    const scheme = new URL(pageUrl).protocol
    if (scheme !== 'http:' && scheme !== 'https:') return

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
  handleProtocolUrl(url)
})

// Windows/Linux: new instance launched with protocol URL in argv
app.on('second-instance', (_event, argv) => {
  const url = argv.find(arg => arg.startsWith('personallibrary://'))
  if (url) handleProtocolUrl(url)

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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  win.once('ready-to-show', () => {
    win.show()
    // Deliver a URL that arrived before the window was created
    if (pendingCaptureUrl) {
      win.webContents.send('request-capture', pendingCaptureUrl)
      pendingCaptureUrl = null
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
  // Guard against path traversal: resolve the full path and ensure it stays
  // inside userData (the same pattern used by reader.ts / safeFullPath).
  const userData = app.getPath('userData')
  protocol.handle('library', (request) => {
    const relative = request.url.slice('library://'.length)
    const filePath = resolve(join(userData, relative))
    if (!filePath.startsWith(userData + sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(`file://${filePath}`).then(res => {
      const headers = new Headers(res.headers)
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(res.body, { status: res.status, headers })
    })
  })

  initDatabase()
  registerLibraryHandlers()
  registerCaptureHandlers()
  registerReaderHandlers()
  registerCollectionHandlers()
  registerConvertHandlers()
  registerStatsHandlers()
  registerGoalsHandlers()
  registerBackupHandlers()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
