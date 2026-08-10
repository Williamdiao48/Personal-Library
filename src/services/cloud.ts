export const cloudService = {
  // Opt an existing library item into cloud backup. Resolves once the upload
  // attempt finishes, reporting the real outcome (state: synced/error/pending).
  backupItem: (
    id: string,
  ): Promise<{ ok: boolean; state?: 'pending' | 'synced' | 'error'; error?: string }> =>
    window.api.cloud.backupItem(id),

  // Authoritative tally of in-flight / failed blob backups for the status pill.
  getBackupCounts: (): Promise<{ pending: number; error: number }> =>
    window.api.cloud.getBackupCounts(),

  // Live blob sync-state updates (content_hash → pending/synced/error) for cards
  // driven by the fire-and-forget capture path / background drains, and for the
  // status pill (which refetches getBackupCounts on each event). Returns unsubscribe.
  onBlobState: (
    callback: (ev: { hash: string; state: 'pending' | 'synced' | 'error' }) => void,
  ): (() => void) => window.api.cloud.onBlobState(callback),
}
