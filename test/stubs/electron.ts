// Minimal Electron stub for unit/integration tests (wired via the `electron`
// alias in vitest.workspace.ts). Only the surface the code under test touches is
// stubbed. It also *records* ipcMain handlers so integration tests can invoke an
// IPC channel directly (see invoke / resetIpc below) without a real Electron
// runtime — the handler runs against the in-memory test DB.

export const app = {
  getPath(name: string): string {
    // Deterministic, absolute fake paths so path-resolution logic is testable
    // without a real Electron runtime.
    if (name === 'userData') return '/tmp/pl-test-userdata'
    return `/tmp/pl-test-${name}`
  },
  getName: () => 'personal-library-test',
  getVersion: () => '0.0.0-test',
  on: () => app,
  whenReady: () => Promise.resolve(),
  quit: () => {},
}

// ── ipcMain recording ───────────────────────────────────────────────────────

type IpcHandler = (event: unknown, ...args: any[]) => unknown
const handlers = new Map<string, IpcHandler>()

// A fake IpcMainInvokeEvent. `sender.send` is a no-op so handlers that push
// progress events don't blow up under test; `isDestroyed` is always false so
// handlers that guard sends with it (e.g. the capture pipeline) run cleanly.
const fakeEvent = { sender: { send: () => {}, isDestroyed: () => false } }

export const ipcMain = {
  handle(channel: string, fn: IpcHandler): void {
    handlers.set(channel, fn)
  },
  handleOnce(channel: string, fn: IpcHandler): void {
    handlers.set(channel, fn)
  },
  removeHandler(channel: string): void {
    handlers.delete(channel)
  },
  on(): typeof ipcMain {
    return ipcMain
  },
  removeAllListeners(): typeof ipcMain {
    return ipcMain
  },
}

/** Invoke a registered IPC handler as the renderer would. Returns its result. */
export function invoke<T = unknown>(channel: string, ...args: any[]): T | Promise<T> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`No ipcMain handler registered for "${channel}"`)
  return fn(fakeEvent, ...args) as T | Promise<T>
}

/** True if a handler is registered for the channel. */
export function hasHandler(channel: string): boolean {
  return handlers.has(channel)
}

/** Clear all recorded handlers. Call in beforeEach so modules re-register cleanly. */
export function resetIpc(): void {
  handlers.clear()
}

// ── dialog / BrowserWindow (configurable no-op stubs) ────────────────────────

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined as string | undefined }),
  showMessageBox: async () => ({ response: 0 }),
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
  static getFocusedWindow(): BrowserWindow | null {
    return null
  }
  webContents = { send: () => {} }
}

export const shell = {
  openExternal: async () => {},
  showItemInFolder: () => {},
}
