import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { BrowserWindow, invoke, resetIpc } from '../../../test/stubs/electron'
import { registerUpdaterHandlers } from './updater'

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: undefined,
    on: vi.fn(),
    checkForUpdates: vi.fn().mockResolvedValue('checked'),
    downloadUpdate: vi.fn().mockResolvedValue('downloaded'),
    quitAndInstall: vi.fn(),
  },
}))

import { autoUpdater } from 'electron-updater'
const mockedAutoUpdater = vi.mocked(autoUpdater)

// The module guards re-registration with an internal flag that this test
// harness's resetIpc() can't see, so a second registerUpdaterHandlers() call
// in the same module lifetime is a silent no-op — register exactly once.
let callbacks: Record<string, (...args: any[]) => void>

beforeAll(() => {
  resetIpc()
  registerUpdaterHandlers()
  callbacks = Object.fromEntries(
    mockedAutoUpdater.on.mock.calls.map(([event, cb]) => [event, cb as (...args: any[]) => void]),
  )
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('registerUpdaterHandlers — one-time setup', () => {
  it('configures autoDownload/autoInstallOnAppQuit/logger', () => {
    expect(mockedAutoUpdater.autoDownload).toBe(false)
    expect(mockedAutoUpdater.autoInstallOnAppQuit).toBe(true)
    expect(mockedAutoUpdater.logger).toBeNull()
  })
})

describe('registerUpdaterHandlers — IPC delegation', () => {
  it('checkForUpdates delegates and returns the resolved value', async () => {
    await expect(invoke('updater:checkForUpdates')).resolves.toBe('checked')
    expect(mockedAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('downloadUpdate delegates and returns the resolved value', async () => {
    await expect(invoke('updater:downloadUpdate')).resolves.toBe('downloaded')
    expect(mockedAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('quitAndInstall delegates with (isSilent=false, isForceRunAfter=true)', async () => {
    await invoke('updater:quitAndInstall')
    expect(mockedAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })
})

describe('registerUpdaterHandlers — event forwarding', () => {
  it('forwards update-available with the version', () => {
    const send = vi.fn()
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([{ webContents: { send } } as any])
    callbacks['update-available']({ version: '1.2.3' })
    expect(send).toHaveBeenCalledWith('updater:update-available', { version: '1.2.3' })
  })

  it('forwards update-not-available with no payload', () => {
    const send = vi.fn()
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([{ webContents: { send } } as any])
    callbacks['update-not-available']()
    expect(send).toHaveBeenCalledWith('updater:update-not-available')
  })

  it('forwards download-progress rounding the percent (.5 rounds up)', () => {
    const send = vi.fn()
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([{ webContents: { send } } as any])
    callbacks['download-progress']({ percent: 42.5 })
    expect(send).toHaveBeenCalledWith('updater:download-progress', { percent: 43 })
  })

  it('forwards update-downloaded with no payload', () => {
    const send = vi.fn()
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([{ webContents: { send } } as any])
    callbacks['update-downloaded']()
    expect(send).toHaveBeenCalledWith('updater:update-downloaded')
  })

  it('forwards error with the message', () => {
    const send = vi.fn()
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([{ webContents: { send } } as any])
    callbacks['error'](new Error('network down'))
    expect(send).toHaveBeenCalledWith('updater:error', { message: 'network down' })
  })

  it('is a silent no-op when no window is open', () => {
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([])
    expect(() => callbacks['update-available']({ version: '1.0.0' })).not.toThrow()
  })
})
