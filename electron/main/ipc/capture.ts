import { ipcMain, dialog } from 'electron'
import { randomUUID } from 'crypto'
import { captureUrl, captureFile, appendChapters } from '../capture'
import { triggerBackfill } from '../recommender/lifecycle'
import { enqueueItemBackup } from '../cloud/uploader'

/**
 * True only for parseable http(s) URLs. `capture:start` is a trust boundary —
 * mirror handleProtocolUrl in index.ts and refuse non-web schemes (file:,
 * javascript:, data:, …) before they ever reach the capture pipeline.
 */
export function isHttpUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  try {
    const { protocol } = new URL(raw)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function registerCaptureHandlers(): void {
  // Background capture — returns a jobId immediately and runs the capture
  // concurrently. Progress, completion, and errors are pushed to the renderer
  // as one-way IPC events so the UI stays responsive during long fetches.
  ipcMain.handle(
    'capture:start',
    (event, url: string, start?: number, end?: number, cloudBackup?: boolean) => {
      const jobId = randomUUID()
      // SEC-3: reject non-http(s) URLs at the boundary. Still returns a jobId and
      // reports the failure through the same capture:error channel the UI listens on.
      if (!isHttpUrl(url)) {
        event.sender.send('capture:error', { jobId, error: 'Only http(s) URLs can be captured.' })
        return jobId
      }
      const range = start != null && end != null ? { start, end } : undefined

      captureUrl(
        url,
        (msg) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('capture:progress', { jobId, msg })
          }
        },
        range,
        cloudBackup === true,
      )
        .then((result) => {
          // New item persisted — reconcile its embedding in the background (C2.6).
          triggerBackfill()
          // Cloud opt-in (Phase 2): back the bytes up to R2 in the background.
          // Best-effort — never blocks capture completion or fails the job.
          if (cloudBackup === true) void enqueueItemBackup(result.id).catch(() => {})
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
    },
  )

  ipcMain.handle('capture:append', (event, itemId: string, newEnd: number) => {
    const jobId = randomUUID()

    appendChapters(itemId, newEnd, (msg) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('capture:progress', { jobId, msg })
      }
    })
      .then((result) => {
        // Appended chapters change the item's content — reconcile in background.
        triggerBackfill()
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

  ipcMain.handle('capture:fromFile', async (_event, cloudBackup?: boolean) => {
    const { filePaths } = await dialog.showOpenDialog({
      title: 'Import file',
      buttonLabel: 'Import',
      filters: [{ name: 'Books & Documents', extensions: ['epub', 'pdf'] }],
      properties: ['openFile'],
    })
    if (!filePaths.length) return null
    const result = await captureFile(filePaths[0], cloudBackup === true)
    // Imported EPUB/PDF persisted — reconcile its embedding in the background.
    triggerBackfill()
    // Cloud opt-in (Phase 2): back the bytes up to R2 in the background.
    if (cloudBackup === true) void enqueueItemBackup(result.id).catch(() => {})
    return result
  })
}
