export const cloudService = {
  // Opt an existing library item into cloud backup. Resolves once the upload
  // attempt finishes, reporting the real outcome (state: synced/error/pending).
  backupItem: (
    id: string,
  ): Promise<{ ok: boolean; state?: 'pending' | 'synced' | 'error'; error?: string }> =>
    window.api.cloud.backupItem(id),

  // Live blob sync-state updates (content_hash → synced/error) for cards driven
  // by the fire-and-forget capture path / background drains. Returns unsubscribe.
  onBlobState: (
    callback: (ev: { hash: string; state: 'synced' | 'error' }) => void,
  ): (() => void) => window.api.cloud.onBlobState(callback),
}
