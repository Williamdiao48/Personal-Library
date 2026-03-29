import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { run, get, all } from '../db'
import type { Goal, GoalType, GoalPeriod, GoalItem } from '../../../src/types'

// Returns the Unix ms timestamp for the start of the current period window.
function periodStart(period: GoalPeriod): number {
  const now = new Date()
  switch (period) {
    case 'daily': {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      return d.getTime()
    }
    case 'weekly': {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      // Monday-anchored week
      const dow = d.getDay() === 0 ? 6 : d.getDay() - 1
      d.setDate(d.getDate() - dow)
      return d.getTime()
    }
    case 'monthly': {
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    }
    case 'yearly': {
      return new Date(now.getFullYear(), 0, 1).getTime()
    }
  }
}

interface GoalRow {
  id:             string
  type:           GoalType
  title:          string
  period:         GoalPeriod | null
  target_minutes: number | null
  target_count:   number | null
  created_at:     number
}

function buildGoal(row: GoalRow): Goal {
  let current_value = 0
  let total_items   = 0
  const items: GoalItem[] = []

  if (row.type === 'time' && row.period) {
    const cutoff = periodStart(row.period)
    const res = get<{ v: number }>(
      `SELECT COALESCE(SUM(duration), 0) AS v FROM reading_sessions WHERE started_at >= ?`,
      [cutoff],
    )
    current_value = Math.floor((res?.v ?? 0) / 60_000)  // ms → minutes
  } else if (row.type === 'count' && row.period) {
    const cutoff = periodStart(row.period)
    const res = get<{ v: number }>(`
      SELECT COUNT(DISTINCT p.item_id) AS v
      FROM progress p
      WHERE (p.scroll_position >= 1 OR p.status = 'finished')
        AND p.last_read_at >= ?
    `, [cutoff])
    current_value = res?.v ?? 0
  } else if (row.type === 'list') {
    // Include derived_from so we can group PDF + derived EPUB as one book
    const rows = all<{
      item_id: string; title: string; author: string | null;
      derived_from: string | null;
      scroll_position: number | null; status: string | null
    }>(`
      SELECT gi.item_id,
             i.title,
             i.author,
             i.derived_from,
             p.scroll_position,
             p.status
      FROM goal_items gi
      JOIN items i ON i.id = gi.item_id
      LEFT JOIN progress p ON p.item_id = gi.item_id
      WHERE gi.goal_id = ?
      ORDER BY i.title
    `, [row.id])

    // Group by book family: PDF + its derived EPUBs count as one book.
    // Canonical ID = the source (derived_from target), or the item itself if it has no source.
    const byItemId = new Map(rows.map(r => [r.item_id, r]))
    const seen     = new Set<string>()

    for (const r of rows) {
      const canonicalId = r.derived_from ?? r.item_id
      if (seen.has(canonicalId)) continue
      seen.add(canonicalId)

      // All family members present in this list
      const members = rows.filter(m => m.item_id === canonicalId || m.derived_from === canonicalId)

      // Best progress across all family members
      const bestPos  = Math.max(...members.map(m => m.scroll_position ?? 0))
      const finished = bestPos >= 1 || members.some(m => m.status === 'finished')
      if (finished) current_value++
      total_items++

      // Prefer metadata from the source item; fall back to the current row
      const canonical = byItemId.get(canonicalId) ?? r
      items.push({
        item_id:         canonical.item_id,
        title:           canonical.title,
        author:          canonical.author,
        finished,
        scroll_position: Math.min(bestPos, 1),
      })
    }
  }

  return {
    id:             row.id,
    type:           row.type,
    title:          row.title,
    period:         row.period,
    target_minutes: row.target_minutes,
    target_count:   row.target_count,
    created_at:     row.created_at,
    current_value,
    total_items,
    items,
  }
}

export function registerGoalsHandlers(): void {

  // ── Get all goals with computed progress ───────────────────────
  ipcMain.handle('goals:getAll', (): Goal[] => {
    const rows = all<GoalRow>(
      `SELECT id, type, title, period, target_minutes, target_count, created_at
       FROM goals ORDER BY created_at`,
    )
    return rows.map(buildGoal)
  })

  // ── Create a goal ───────────────────────────────────────────────
  ipcMain.handle('goals:create', (
    _e,
    payload: { type: GoalType; title: string; period?: GoalPeriod; targetMinutes?: number; targetCount?: number },
  ): Goal => {
    const id = randomUUID()
    const now = Date.now()
    run(
      `INSERT INTO goals (id, type, title, period, target_minutes, target_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, payload.type, payload.title, payload.period ?? null, payload.targetMinutes ?? null, payload.targetCount ?? null, now],
    )
    const row = get<GoalRow>(
      `SELECT id, type, title, period, target_minutes, target_count, created_at FROM goals WHERE id = ?`,
      [id],
    )!
    return buildGoal(row)
  })

  // ── Update a goal ───────────────────────────────────────────────
  ipcMain.handle('goals:update', (
    _e,
    id: string,
    patch: { title?: string; period?: GoalPeriod | null; targetMinutes?: number | null; targetCount?: number | null },
  ): void => {
    if (patch.title !== undefined)
      run(`UPDATE goals SET title = ? WHERE id = ?`, [patch.title, id])
    if (patch.period !== undefined)
      run(`UPDATE goals SET period = ? WHERE id = ?`, [patch.period, id])
    if (patch.targetMinutes !== undefined)
      run(`UPDATE goals SET target_minutes = ? WHERE id = ?`, [patch.targetMinutes, id])
    if (patch.targetCount !== undefined)
      run(`UPDATE goals SET target_count = ? WHERE id = ?`, [patch.targetCount, id])
  })

  // ── Delete a goal ───────────────────────────────────────────────
  ipcMain.handle('goals:delete', (_e, id: string): void => {
    run(`DELETE FROM goals WHERE id = ?`, [id])
  })

  // ── Add an item to a reading list goal ──────────────────────────
  ipcMain.handle('goals:addItem', (_e, goalId: string, itemId: string): void => {
    run(
      `INSERT OR IGNORE INTO goal_items (goal_id, item_id) VALUES (?, ?)`,
      [goalId, itemId],
    )
  })

  // ── Remove an item from a reading list goal ─────────────────────
  ipcMain.handle('goals:removeItem', (_e, goalId: string, itemId: string): void => {
    run(`DELETE FROM goal_items WHERE goal_id = ? AND item_id = ?`, [goalId, itemId])
  })

  // ── Upsert a time or count goal for a specific period ───────────
  // Creates the goal if it doesn't exist, updates the target if it does.
  // Passing target=null (or <=0) deletes the goal for that period.
  ipcMain.handle('goals:upsertPeriodGoal', (
    _e,
    type: 'time' | 'count',
    period: GoalPeriod,
    target: number | null,
  ): Goal | null => {
    const existing = get<{ id: string }>(
      `SELECT id FROM goals WHERE type = ? AND period = ?`,
      [type, period],
    )

    if (target === null || target <= 0) {
      if (existing) run(`DELETE FROM goals WHERE id = ?`, [existing.id])
      return null
    }

    if (existing) {
      if (type === 'time') run(`UPDATE goals SET target_minutes = ? WHERE id = ?`, [target, existing.id])
      else                 run(`UPDATE goals SET target_count   = ? WHERE id = ?`, [target, existing.id])
      const row = get<GoalRow>(
        `SELECT id, type, title, period, target_minutes, target_count, created_at FROM goals WHERE id = ?`,
        [existing.id],
      )!
      return buildGoal(row)
    } else {
      const AUTO_TITLES: Record<string, Record<string, string>> = {
        time:  { daily: 'Daily reading time', weekly: 'Weekly reading time', monthly: 'Monthly reading time', yearly: 'Yearly reading time' },
        count: { daily: 'Daily books', weekly: 'Weekly books', monthly: 'Monthly books', yearly: 'Yearly books' },
      }
      const id = randomUUID()
      run(
        `INSERT INTO goals (id, type, title, period, target_minutes, target_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, type, AUTO_TITLES[type][period], period,
         type === 'time' ? target : null,
         type === 'count' ? target : null,
         Date.now()],
      )
      const row = get<GoalRow>(
        `SELECT id, type, title, period, target_minutes, target_count, created_at FROM goals WHERE id = ?`,
        [id],
      )!
      return buildGoal(row)
    }
  })
}
