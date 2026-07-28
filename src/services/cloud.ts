export const cloudService = {
  // Opt an existing library item into cloud backup. Resolves { ok } once the
  // item's blobs are enqueued (the uploader drains them in the background).
  backupItem: (id: string): Promise<{ ok: boolean; error?: string }> =>
    window.api.cloud.backupItem(id),
}
