import { ipcMain } from 'electron'
import { setCloudProcessingEnabled } from '../cloud/processing'

// Renderer-facing seam for cloud processing (Phase 4). Mirrors the
// discover/sync.setEnabled pattern: the master switch lives in the renderer's
// settings (localStorage) and is pushed here on boot + on toggle. There is no
// background work to arm — the flag is read synchronously at each EPUB import to
// decide off-device vs. local parsing — so this is just the mirror.

export function registerProcessingHandlers(): void {
  ipcMain.handle('processing:setEnabled', (_e, next: boolean): void => {
    setCloudProcessingEnabled(next)
  })
}
