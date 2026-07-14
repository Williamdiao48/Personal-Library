import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { invoke, resetIpc } from '../../../test/stubs/electron'
import {
  openTestDb,
  closeTestDb,
  seedItem,
  seedSession,
  type TestDb,
} from '../../../test/db/harness'
import { registerStatsHandlers } from './stats'

let db: TestDb

beforeEach(() => {
  resetIpc()
  db = openTestDb()
  registerStatsHandlers()
})
afterEach(() => closeTestDb())

// Local-noon timestamp N days before today (avoids midnight/tz boundary flakiness).
function daysAgoNoon(n: number): number {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - n)
  return d.getTime()
}

function setProgress(
  itemId: string,
  over: { scroll?: number; maxScroll?: number; lastRead?: number },
) {
  db.prepare(
    `INSERT INTO progress (item_id, scroll_position, max_scroll_position, last_read_at)
     VALUES (?, ?, ?, ?)`,
  ).run(itemId, over.scroll ?? 0, over.maxScroll ?? null, over.lastRead ?? Date.now())
}

describe('stats:recordSession', () => {
  it('caps absurd durations at 6 hours', async () => {
    const item = seedItem(db, {})
    const start = Date.now()
    await invoke('stats:recordSession', item, start, start + 100 * 60 * 60 * 1000) // 100h
    const row = db.prepare('SELECT duration FROM reading_sessions').get() as any
    expect(row.duration).toBe(6 * 60 * 60 * 1000)
  })

  it('discards sessions shorter than 5 seconds', async () => {
    const item = seedItem(db, {})
    const start = Date.now()
    await invoke('stats:recordSession', item, start, start + 3000) // 3s
    expect(db.prepare('SELECT COUNT(*) n FROM reading_sessions').get()).toEqual({ n: 0 })
  })
})

describe('stats:getSummary', () => {
  it('aggregates time, started, finished and estimated words read', async () => {
    const a = seedItem(db, { word_count: 1000 })
    const b = seedItem(db, { word_count: 500 })
    seedSession(db, a, { duration: 10 * 60_000 })
    seedSession(db, b, { duration: 5 * 60_000 })
    setProgress(a, { scroll: 1, maxScroll: 1 }) // finished, all words
    setProgress(b, { scroll: 0.5, maxScroll: 0.5 }) // half

    const s = (await invoke('stats:getSummary')) as any
    expect(s.totalMs).toBe(15 * 60_000)
    expect(s.itemsStarted).toBe(2) // distinct items with sessions
    expect(s.itemsFinished).toBe(1) // scroll_position >= 1
    expect(s.wordsRead).toBe(1000 + 250) // 1000*1 + 500*0.5
  })
})

describe('stats:getByItem', () => {
  it('orders by total time and computes avg_wpm when eligible', async () => {
    const a = seedItem(db, { id: 'a', title: 'A', word_count: 600 })
    const b = seedItem(db, { id: 'b', title: 'B', word_count: 100 })
    seedSession(db, a, { duration: 2 * 60_000 }) // 2 min
    seedSession(db, b, { duration: 60_000 })
    setProgress('a', { scroll: 1, maxScroll: 1 })
    setProgress('b', { scroll: 1, maxScroll: 1 })

    const rows = (await invoke('stats:getByItem')) as any[]
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']) // a has more time
    // a: 600 words × 1.0 / 2 min = 300 wpm
    expect(rows.find((r) => r.id === 'a').avg_wpm).toBe(300)
  })

  it('leaves avg_wpm null when under the 1-minute threshold', async () => {
    const a = seedItem(db, { id: 'a', word_count: 600 })
    seedSession(db, a, { duration: 30_000 }) // 30s < 60s
    setProgress('a', { scroll: 1, maxScroll: 1 })
    const rows = (await invoke('stats:getByItem')) as any[]
    expect(rows[0].avg_wpm).toBeNull()
  })
})

describe('stats:getStreaks', () => {
  it('returns zero streaks with no sessions', async () => {
    expect(await invoke('stats:getStreaks')).toEqual({ currentStreak: 0, longestStreak: 0 })
  })

  it('computes the longest consecutive-day run', async () => {
    const item = seedItem(db, {})
    // 3-day run (days 10,9,8), gap, 2-day run (days 5,4).
    for (const n of [10, 9, 8, 5, 4]) seedSession(db, item, { started_at: daysAgoNoon(n) })
    const s = (await invoke('stats:getStreaks')) as any
    expect(s.longestStreak).toBe(3)
  })

  it('counts a current streak anchored at today', async () => {
    const item = seedItem(db, {})
    for (const n of [0, 1, 2]) seedSession(db, item, { started_at: daysAgoNoon(n) })
    const s = (await invoke('stats:getStreaks')) as any
    expect(s.currentStreak).toBe(3)
  })
})

describe('stats:getDashboard', () => {
  it('bundles summary, timeline, byItem and streaks in one call', async () => {
    const a = seedItem(db, { id: 'a', word_count: 1000 })
    seedSession(db, a, { duration: 10 * 60_000, started_at: daysAgoNoon(0) })
    setProgress('a', { scroll: 1, maxScroll: 1 })

    const d = (await invoke('stats:getDashboard', 366)) as any
    // Same shapes the individual handlers return, composed together.
    expect(d.summary.totalMs).toBe(10 * 60_000)
    expect(d.summary.itemsFinished).toBe(1)
    expect(d.byItem.map((r: any) => r.id)).toEqual(['a'])
    expect(d.streaks.currentStreak).toBe(1)
    expect(d.timeline.reduce((sum: number, r: any) => sum + r.totalMs, 0)).toBe(10 * 60_000)
  })

  it('honors the timeline day-span window', async () => {
    const a = seedItem(db, {})
    seedSession(db, a, { duration: 60_000, started_at: daysAgoNoon(400) }) // older than the window
    const d = (await invoke('stats:getDashboard', 366)) as any
    expect(d.timeline).toEqual([]) // 400 days ago is outside a 366-day window
  })
})
