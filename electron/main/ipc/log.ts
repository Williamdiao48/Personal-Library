import { ipcMain, app } from 'electron'
import { mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'

export function registerLogHandlers(): void {
  ipcMain.handle('log:writeError', (_e, message: string) => {
    try {
      const logsDir = join(app.getPath('userData'), 'logs')
      mkdirSync(logsDir, { recursive: true })
      const date = new Date().toISOString().slice(0, 10)
      const file = join(logsDir, `error-${date}.log`)
      const entry = `[${new Date().toISOString()}]\n${message}\n\n`
      appendFileSync(file, entry, 'utf8')
    } catch {
      // Logging failure must never propagate — swallow silently
    }
  })
}
