import type { Recommendation } from '../types'

// Thin wrapper over window.api.discover — the renderer never touches window.api
// directly. `get` is instant (cached snapshot); `refresh` runs the engine.
export const discoverService = {
  setEnabled: (enabled: boolean) => window.api.discover.setEnabled(enabled),
  get: () => window.api.discover.get(),
  refresh: () => window.api.discover.refresh(),
  more: (excludeSourceIds: string[]) => window.api.discover.more(excludeSourceIds),
  dismiss: (card: Recommendation) => window.api.discover.dismiss(card),
  openExternal: (url: string) => window.api.discover.openExternal(url),
}
