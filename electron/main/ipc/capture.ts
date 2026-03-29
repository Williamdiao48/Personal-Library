import { ipcMain, dialog } from 'electron'
import { randomUUID } from 'crypto'
import { captureUrl, captureFile, appendChapters } from '../capture'

export function registerCaptureHandlers(): void {

  // Background capture — returns a jobId immediately and runs the capture
  // concurrently. Progress, completion, and errors are pushed to the renderer
  // as one-way IPC events so the UI stays responsive during long fetches.
  ipcMain.handle('capture:start', (event, url: string, start?: number, end?: number) => {
    const jobId = randomUUID()
    const range = (start != null && end != null) ? { start, end } : undefined

    captureUrl(url, (msg) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('capture:progress', { jobId, msg })
      }
    }, range)
      .then(result => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('capture:complete', { jobId, result })
        }
      })
      .catch((err: unknown) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('capture:error', {
            jobId,
            error: err instanceof Error ? err.message : 'Capture failed.',
          })
        }
      })

    return jobId
  })

  ipcMain.handle('capture:append', (event, itemId: string, newEnd: number) => {
    const jobId = randomUUID()

    appendChapters(itemId, newEnd, (msg) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('capture:progress', { jobId, msg })
      }
    })
      .then(result => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('capture:complete', { jobId, result })
        }
      })
      .catch((err: unknown) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('capture:error', {
            jobId,
            error: err instanceof Error ? err.message : 'Append failed.',
          })
        }
      })

    return jobId
  })

  ipcMain.handle('capture:fromFile', async () => {
    const { filePaths } = await dialog.showOpenDialog({
      title: 'Import file',
      buttonLabel: 'Import',
      filters: [{ name: 'Books & Documents', extensions: ['epub', 'pdf'] }],
      properties: ['openFile'],
    })
    if (!filePaths.length) return null
    return captureFile(filePaths[0])
  })

}
