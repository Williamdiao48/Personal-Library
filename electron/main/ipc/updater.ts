import { ipcMain, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

let handlersRegistered = false

function getWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

export function registerUpdaterHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true

  autoUpdater.autoDownload        = false   // user initiates download via toast click
  autoUpdater.autoInstallOnAppQuit = true   // install on next quit if downloaded but not applied
  autoUpdater.logger              = null    // suppress log file growth in production

  autoUpdater.on('update-available', (info) => {
    getWindow()?.webContents.send('updater:update-available', { version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    getWindow()?.webContents.send('updater:update-not-available')
  })

  autoUpdater.on('download-progress', (progress) => {
    getWindow()?.webContents.send('updater:download-progress', {
      percent: Math.round(progress.percent),
    })
  })

  autoUpdater.on('update-downloaded', () => {
    getWindow()?.webContents.send('updater:update-downloaded')
  })

  autoUpdater.on('error', (err) => {
    getWindow()?.webContents.send('updater:error', { message: err.message })
  })

  ipcMain.handle('updater:checkForUpdates', () => autoUpdater.checkForUpdates())
  ipcMain.handle('updater:downloadUpdate',  () => autoUpdater.downloadUpdate())
  ipcMain.handle('updater:quitAndInstall',  () => {
    // isSilent=false shows progress UI; isForceRunAfter=true relaunches after install
    autoUpdater.quitAndInstall(false, true)
  })
}
