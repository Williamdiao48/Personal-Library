import type { Recommendation } from '../types'

// Thin wrapper over window.api.discover — the renderer never touches window.api
// directly. `get` is instant (cached snapshot); `refresh` runs the engine.
export const discoverService = {
  get: () => window.api.discover.get(),
  refresh: () => window.api.discover.refresh(),
  dismiss: (card: Recommendation) => window.api.discover.dismiss(card),
  openExternal: (url: string) => window.api.discover.openExternal(url),
}
