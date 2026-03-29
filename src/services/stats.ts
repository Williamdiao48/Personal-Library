// IPC abstraction for reading stats — components use this, never window.api directly.

export const statsService = {
  recordSession: (itemId: string, startedAt: number, endedAt: number) =>
    window.api.stats.recordSession(itemId, startedAt, endedAt),
  getSummary:    ()             => window.api.stats.getSummary(),
  getTimeline:   (days: number) => window.api.stats.getTimeline(days),
  getByItem:     ()             => window.api.stats.getByItem(),
  getStreaks:    ()             => window.api.stats.getStreaks(),
}
