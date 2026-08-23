import type { BulkSource, CaptureResult, FavoritesDiscovery } from '../types'

export const captureService = {
  // Fire-and-forget: starts a background capture and returns a jobId.
  // Subscribe to window.api.onCaptureProgress/Complete/Error for updates.
  start: (url: string, start?: number, end?: number, cloudBackup?: boolean): Promise<string> =>
    window.api.capture.start(url, start, end, cloudBackup),
  fromFile: (cloudBackup?: boolean): Promise<CaptureResult | null> =>
    window.api.capture.fromFile(cloudBackup),
  append: (itemId: string, end: number): Promise<string> => window.api.capture.append(itemId, end),
  // Bulk favorites — discover an account's works for the preview step (fast; a
  // few requests). Rejects with a user-facing message on an invalid ref.
  discoverFavorites: (source: BulkSource, ref: string): Promise<FavoritesDiscovery> =>
    window.api.capture.discoverFavorites(source, ref),
  // Bulk favorites — start the serialized import; subscribe via window.api
  // onBatchProgress/onBatchComplete for updates.
  startBulk: (urls: string[], cloudBackup?: boolean): Promise<{ batchId: string; total: number }> =>
    window.api.capture.startBulk(urls, cloudBackup),
  cancelBulk: (batchId: string): Promise<void> => window.api.capture.cancelBulk(batchId),
}
