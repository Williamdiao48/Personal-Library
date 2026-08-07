// Thin wrapper over window.api.processing — the renderer never touches window.api
// directly. `setEnabled` mirrors the cloud-processing master switch to main (like
// sync/discover); main reads it at each EPUB import to decide off-device vs. local.
export const processingService = {
  setEnabled: (enabled: boolean) => window.api.processing.setEnabled(enabled),
}
