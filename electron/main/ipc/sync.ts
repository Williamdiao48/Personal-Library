import { ipcMain } from 'electron'
import { getStatus, setEnabled, syncNow, type SyncStatus } from '../cloud/sync/syncService'

// Renderer-facing seam for library/metadata sync (Phase 3). Mirrors the
// discover.setEnabled pattern: the sync master switch lives in the renderer's
// settings (localStorage) and is pushed here on boot + on toggle. `sync:now` backs
// the manual "Sync now" button; status changes are pushed via 'sync:status'
// (broadcast from syncService), same event-forwarding shape as auth/updater.

export function registerSyncHandlers(): void {
  // Mirror the renderer's master switch into the service (arms/disarms the poll).
  ipcMain.handle('sync:setEnabled', (_e, next: boolean): SyncStatus => {
    setEnabled(next)
    return getStatus()
  })

  // Current snapshot — the renderer hydrates its status view on mount with this.
  ipcMain.handle('sync:getStatus', (): SyncStatus => getStatus())

  // Manual "Sync now". Resolves once the round finishes, so the button can show
  // its outcome; no-ops (returns current status) when disabled/signed-out.
  ipcMain.handle('sync:now', (): Promise<SyncStatus> => syncNow())
}
