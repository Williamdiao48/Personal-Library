import type { SyncStatus } from '../types'

// Thin wrapper over window.api.sync — the renderer never touches window.api
// directly. `setEnabled` mirrors the master switch to main (like discover),
// `now` backs the manual button, `onStatus` streams live status changes.
export const syncService = {
  setEnabled: (enabled: boolean) => window.api.sync.setEnabled(enabled),
  getStatus: () => window.api.sync.getStatus(),
  now: () => window.api.sync.now(),
  onStatus: (cb: (status: SyncStatus) => void) => window.api.sync.onStatus(cb),
}
