import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { run, get, all } from '../db'
import type { StatsSummary, DailyReading, ItemStats, StreakInfo } from '../../../src/types'

// Generous server-side safety cap. The client already trims idle time using
// activity-based segmentation; this is only a last-resort guard against
// clock skew or bugs sending absurd durations.
const SESSION_MAX_MS  = 6 * 60 * 60 * 1_000  // 6 hours
// Sessions shorter than this are discarded — filters out accidental opens.
const SESSION_MIN_MS  = 5_000                  // 5 seconds

export function registerStatsHandlers(): void {

  // ── Record a reading session ───────────────────────────────────
  // Called by the renderer on unmount (or when the tab is hidden).
  // startedAt / endedAt are unix milliseconds from Date.now().

  ipcMain.handle('stats:recordSession', (
    _e,
    itemId: string,
    startedAt: number,
    endedAt: number,
  ) => {
    const raw      = endedAt - startedAt
    const duration = Math.min(raw, SESSION_MAX_MS)
    if (duration < SESSION_MIN_MS) return   // too short to be meaningful

    run(
      `INSERT INTO reading_sessions (id, item_id, started_at, ended_at, duration)
       VALUES (?, ?, ?, ?, ?)`,
      [randomUUID(), itemId, startedAt, endedAt, duration],
    )
  })

  // ── Aggregate totals ───────────────────────────────────────────

  ipcMain.handle('stats:getSummary', (): StatsSummary => {
    const totalMs = get<{ v: number }>(
      `SELECT COALESCE(SUM(duration), 0) AS v FROM reading_sessions`,
    )?.v ?? 0

    const itemsStarted = get<{ v: number }>(
      `SELECT COUNT(DISTINCT item_id) AS v FROM reading_sessions`,
    )?.v ?? 0

    const itemsFinished = get<{ v: number }>(
      `SELECT COUNT(*) AS v FROM progress WHERE scroll_position >= 1`,
    )?.v ?? 0

    // Estimated words read: word_count × high-water scroll position per item.
    // max_scroll_position is the furthest point ever reached, so rewinding
    // to re-read an earlier chapter doesn't deflate the count.
    // Falls back to scroll_position for rows written before migration 11.
    const wordsRead = get<{ v: number }>(`
      SELECT COALESCE(
        SUM(CAST(i.word_count * MIN(COALESCE(p.max_scroll_position, p.scroll_position, 0), 1.0) AS INTEGER)),
        0
      ) AS v
      FROM items i
      LEFT JOIN progress p ON p.item_id = i.id
      WHERE i.word_count IS NOT NULL
    `)?.v ?? 0

    return { totalMs, itemsStarted, itemsFinished, wordsRead }
  })

  // ── Daily timeline ─────────────────────────────────────────────
  // Returns one row per calendar day that had any reading activity,
  // within the last `days` days. Caller fills gaps for days with zero.

  ipcMain.handle('stats:getTimeline', (_e, days: number): DailyReading[] => {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1_000
    return all<DailyReading>(`
      SELECT
        date(started_at / 1000, 'unixepoch', 'localtime') AS date,
        SUM(duration) AS totalMs
      FROM reading_sessions
      WHERE started_at >= ?
      GROUP BY date
      ORDER BY date
    `, [cutoff])
  })

  // ── Per-item breakdown ─────────────────────────────────────────
  // Returns all items that have either a reading session or progress,
  // ordered by total time read descending.

  ipcMain.handle('stats:getByItem', (): ItemStats[] => {
    return all<ItemStats>(`
      SELECT
        i.id,
        i.title,
        i.author,
        i.content_type,
        i.word_count,
        COALESCE(p.scroll_position, 0)  AS scroll_position,
        COALESCE(s.total_ms, 0)         AS total_ms,
        COALESCE(s.session_count, 0)    AS session_count,
        p.last_read_at,
        CASE
          WHEN i.word_count IS NOT NULL
            AND COALESCE(s.total_ms, 0) >= 60000
            AND COALESCE(p.max_scroll_position, p.scroll_position, 0) > 0
          THEN CAST(ROUND(
            i.word_count * MIN(COALESCE(p.max_scroll_position, p.scroll_position, 0), 1.0)
            / (COALESCE(s.total_ms, 0) / 60000.0)
          ) AS INTEGER)
          ELSE NULL
        END AS avg_wpm
      FROM items i
      LEFT JOIN progress p ON p.item_id = i.id
      LEFT JOIN (
        SELECT item_id,
               SUM(duration) AS total_ms,
               COUNT(*)      AS session_count
        FROM   reading_sessions
        GROUP  BY item_id
      ) s ON s.item_id = i.id
      WHERE s.total_ms IS NOT NULL
         OR p.last_read_at IS NOT NULL
      ORDER BY COALESCE(s.total_ms, 0) DESC
    `)
  })

  // ── Reading streaks ────────────────────────────────────────────
  // Computes current streak (consecutive days back from today/yesterday)
  // and longest all-time streak from the reading_sessions table.

  ipcMain.handle('stats:getStreaks', (): StreakInfo => {
    const rows = all<{ day: string }>(`
      SELECT DISTINCT date(started_at / 1000, 'unixepoch', 'localtime') AS day
      FROM reading_sessions
      ORDER BY day
    `)

    if (rows.length === 0) return { currentStreak: 0, longestStreak: 0 }

    const days = rows.map(r => r.day)

    // Longest streak: scan sorted days for the longest consecutive run
    let longest = 1
    let run     = 1
    for (let i = 1; i < days.length; i++) {
      const prev = new Date(days[i - 1] + 'T12:00:00')
      const curr = new Date(days[i]     + 'T12:00:00')
      const diff = Math.round((curr.getTime() - prev.getTime()) / 86_400_000)
      run     = diff === 1 ? run + 1 : 1
      longest = Math.max(longest, run)
    }

    // Current streak: walk backwards from today; accept yesterday as starting point
    // if the user hasn't read today yet (so the streak doesn't "break" mid-day).
    // Use local date parts — toISOString() is UTC and breaks near midnight for
    // users whose local timezone is behind UTC.
    const localDateStr = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    const daySet   = new Set(days)
    const today    = new Date()
    const todayStr = localDateStr(today)
    const check    = new Date(today)
    if (!daySet.has(todayStr)) check.setDate(check.getDate() - 1)

    let current = 0
    while (true) {
      const s = localDateStr(check)
      if (!daySet.has(s)) break
      current++
      check.setDate(check.getDate() - 1)
    }

    return { currentStreak: current, longestStreak: longest }
  })
}
