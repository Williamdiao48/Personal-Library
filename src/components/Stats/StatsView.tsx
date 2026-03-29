import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { statsService } from '../../services/stats'
import { goalsService } from '../../services/goals'
import { libraryService } from '../../services/library'
import type { StatsSummary, DailyReading, ItemStats, StreakInfo, Goal, GoalPeriod, Item } from '../../types'
import '../../styles/stats.css'

// ── Time formatting ────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000)       return `${Math.round(ms / 1_000)}s`
  if (ms < 3_600_000)    return `${Math.round(ms / 60_000)}m`
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function formatWords(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Timeline helpers ───────────────────────────────────────────────────────

/** Fill a sparse timeline so every one of the last N days has an entry. */
function fillTimeline(sparse: DailyReading[], days: number): DailyReading[] {
  const byDate = new Map(sparse.map(d => [d.date, d.totalMs]))
  const result: DailyReading[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const date = d.toISOString().split('T')[0]
    result.push({ date, totalMs: byDate.get(date) ?? 0 })
  }
  return result
}

// ── Heatmap ────────────────────────────────────────────────────────────────

const HEATMAP_WEEKS = 53
const CELL_SIZE     = 12   // px
const CELL_GAP      = 3    // px
const CELL_STEP     = CELL_SIZE + CELL_GAP
const DAY_LABEL_W   = 24   // px

type HeatmapDay = { date: string; totalMs: number; isFuture: boolean }

function buildHeatmapGrid(filledData: DailyReading[]): {
  weeks:       HeatmapDay[][]
  monthLabels: { label: string; col: number }[]
} {
  const byDate   = new Map(filledData.map(d => [d.date, d.totalMs]))
  const today    = new Date()
  const todayStr = today.toISOString().split('T')[0]

  // Start the grid on the Monday of the week 52 weeks before this week's Monday
  const todayDow    = today.getDay()                              // 0=Sun … 6=Sat
  const toMonday    = todayDow === 0 ? 6 : todayDow - 1          // days back to Mon
  const gridStart   = new Date(today)
  gridStart.setDate(gridStart.getDate() - toMonday - 52 * 7)

  const weeks: HeatmapDay[][] = []
  const cursor = new Date(gridStart)

  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const week: HeatmapDay[] = []
    for (let day = 0; day < 7; day++) {
      const dateStr = cursor.toISOString().split('T')[0]
      week.push({ date: dateStr, totalMs: byDate.get(dateStr) ?? 0, isFuture: dateStr > todayStr })
      cursor.setDate(cursor.getDate() + 1)
    }
    weeks.push(week)
  }

  // Month labels: one per unique month, at the first column that week starts in
  const monthLabels: { label: string; col: number }[] = []
  let prevMonth = -1
  for (let w = 0; w < weeks.length; w++) {
    const firstDay = new Date(weeks[w][0].date + 'T12:00:00')
    const month    = firstDay.getMonth()
    if (month !== prevMonth) {
      monthLabels.push({
        label: firstDay.toLocaleDateString(undefined, { month: 'short' }),
        col:   w,
      })
      prevMonth = month
    }
  }

  return { weeks, monthLabels }
}

function heatLevel(ms: number): 0 | 1 | 2 | 3 | 4 {
  if (ms === 0)                   return 0
  if (ms < 15 * 60_000)           return 1
  if (ms < 30 * 60_000)           return 2
  if (ms < 60 * 60_000)           return 3
  return 4
}

function HeatmapCalendar({ data }: { data: DailyReading[] }) {
  const { weeks, monthLabels } = useMemo(() => buildHeatmapGrid(data), [data])

  return (
    <div className="stats-heatmap">
      {/* Month labels */}
      <div className="stats-heatmap-months" style={{ marginLeft: DAY_LABEL_W + 4 }}>
        {monthLabels.map(m => (
          <span
            key={m.col}
            className="stats-heatmap-month"
            style={{ left: m.col * CELL_STEP }}
          >
            {m.label}
          </span>
        ))}
      </div>

      {/* Day-of-week labels + grid */}
      <div className="stats-heatmap-body">
        <div className="stats-heatmap-daylabels">
          {['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].map((lbl, i) => (
            <span key={i} style={{ height: CELL_STEP }}>{lbl}</span>
          ))}
        </div>

        <div className="stats-heatmap-weeks">
          {weeks.map((week, w) => (
            <div key={w} className="stats-heatmap-week">
              {week.map(day => (
                <div
                  key={day.date}
                  className={`stats-heatmap-day stats-heatmap-day-${day.isFuture ? 'future' : heatLevel(day.totalMs)}`}
                  title={day.isFuture ? undefined : `${day.date}: ${day.totalMs > 0 ? formatDuration(day.totalMs) : 'No reading'}`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="stats-heatmap-legend">
        <span className="stats-heatmap-legend-label">Less</span>
        {([0, 1, 2, 3, 4] as const).map(l => (
          <div key={l} className={`stats-heatmap-day stats-heatmap-day-${l}`} />
        ))}
        <span className="stats-heatmap-legend-label">More</span>
      </div>
    </div>
  )
}

// ── Period goal rings ──────────────────────────────────────────────────────

const PERIODS: GoalPeriod[] = ['daily', 'weekly', 'monthly', 'yearly']
const PERIOD_LABELS: Record<GoalPeriod, string> = {
  daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly',
}

function ProgressRing({ children, pct }: { children: React.ReactNode; pct: number }) {
  const R    = 28
  const SW   = 4
  const circ = 2 * Math.PI * R
  const dash = Math.min(pct, 1) * circ
  return (
    <svg width={70} height={70} viewBox="0 0 70 70">
      <circle cx={35} cy={35} r={R} fill="none" stroke="var(--border)" strokeWidth={SW} />
      <circle
        cx={35} cy={35} r={R}
        fill="none" stroke="var(--accent)" strokeWidth={SW}
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform="rotate(-90 35 35)"
        style={{ transition: 'stroke-dasharray 0.4s ease' }}
      />
      {children}
    </svg>
  )
}

function TimeProgressRing({ valueMinutes, targetMinutes }: { valueMinutes: number; targetMinutes: number }) {
  const fmt = (m: number) => m >= 60
    ? `${Math.floor(m / 60)}h${m % 60 > 0 ? `${m % 60}m` : ''}`
    : `${m}m`

  return (
    <ProgressRing pct={valueMinutes / (targetMinutes || 1)}>
      <text x={35} y={32} textAnchor="middle" dominantBaseline="middle" fontSize={10} fontWeight={700} fill="var(--text)">{fmt(valueMinutes)}</text>
      <text x={35} y={43} textAnchor="middle" dominantBaseline="middle" fontSize={8} fill="var(--text-muted)">/{fmt(targetMinutes)}</text>
    </ProgressRing>
  )
}

function CountProgressRing({ current, target }: { current: number; target: number }) {
  return (
    <ProgressRing pct={current / (target || 1)}>
      <text x={35} y={32} textAnchor="middle" dominantBaseline="middle" fontSize={13} fontWeight={700} fill="var(--text)">{current}</text>
      <text x={35} y={44} textAnchor="middle" dominantBaseline="middle" fontSize={8} fill="var(--text-muted)">/{target}</text>
    </ProgressRing>
  )
}

function PeriodGoalSlot({ period, goal, type, onSave }: {
  period: GoalPeriod
  goal:   Goal | undefined
  type:   'time' | 'count'
  onSave: (period: GoalPeriod, target: number | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val,     setVal]     = useState('')

  function openEdit() {
    const current = type === 'time' ? (goal?.target_minutes ?? '') : (goal?.target_count ?? '')
    setVal(String(current))
    setEditing(true)
  }

  function save() {
    const n = Number(val)
    onSave(period, n > 0 ? n : null)
    setEditing(false)
  }

  function clear() {
    onSave(period, null)
    setEditing(false)
  }

  const label = PERIOD_LABELS[period]

  if (editing) {
    return (
      <div className="stats-period-slot stats-period-slot--editing">
        <span className="stats-period-slot-label">{label}</span>
        <input
          autoFocus
          type="number" min={1}
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
          className="stats-period-slot-input"
          placeholder={type === 'time' ? 'min' : 'books'}
        />
        <span className="stats-period-slot-unit">{type === 'time' ? 'min' : 'books'}</span>
        <div className="stats-period-slot-actions">
          <button className="stats-goals-save-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={save}>Save</button>
          {goal && <button className="stats-goals-cancel-btn" style={{ padding: '4px 8px', fontSize: 12 }} onClick={clear}>Clear</button>}
          <button className="stats-goals-cancel-btn" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => setEditing(false)}>✕</button>
        </div>
      </div>
    )
  }

  if (!goal) {
    return (
      <button className="stats-period-slot stats-period-slot--empty" onClick={openEdit}>
        <span className="stats-period-slot-label">{label}</span>
        <span className="stats-period-slot-add">+ Set target</span>
      </button>
    )
  }

  if (type === 'time') {
    return (
      <div className="stats-period-slot stats-period-slot--active" onClick={openEdit} title="Click to edit">
        <TimeProgressRing valueMinutes={goal.current_value} targetMinutes={goal.target_minutes ?? 1} />
        <span className="stats-period-slot-label">{label}</span>
        <span className="stats-period-slot-edit-hint">click to edit</span>
      </div>
    )
  }

  // count
  return (
    <div className="stats-period-slot stats-period-slot--active" onClick={openEdit} title="Click to edit">
      <CountProgressRing current={goal.current_value} target={goal.target_count ?? 0} />
      <span className="stats-period-slot-label">{label}</span>
      <span className="stats-period-slot-edit-hint">click to edit</span>
    </div>
  )
}

function PeriodGoalGrid({ type, goals, onUpsert }: {
  type:    'time' | 'count'
  goals:   Goal[]
  onUpsert: (period: GoalPeriod, target: number | null) => void
}) {
  const byPeriod = useMemo(() => {
    const m = new Map<GoalPeriod, Goal>()
    for (const g of goals) if (g.period) m.set(g.period, g)
    return m
  }, [goals])

  return (
    <div className="stats-goal-period-card">
      <div className="stats-goal-period-card-header">
        <span className="stats-goals-subsection-label">
          {type === 'time' ? 'Reading Time' : 'Books Finished'}
        </span>
      </div>
      <div className="stats-period-grid">
        {PERIODS.map(p => (
          <PeriodGoalSlot key={p} period={p} goal={byPeriod.get(p)} type={type} onSave={onUpsert} />
        ))}
      </div>
    </div>
  )
}

// ── Reading list card ──────────────────────────────────────────────────────

function ListGoalCard({ goal, allItems, onDelete, onAddItem, onRemoveItem }: {
  goal:         Goal
  allItems:     Item[]
  onDelete:     () => void
  onAddItem:    (itemId: string) => void
  onRemoveItem: (itemId: string) => void
}) {
  const [search, setSearch] = useState('')
  const [searchActive, setSearchActive] = useState(false)

  const pct = goal.total_items > 0
    ? Math.min(100, Math.round(goal.current_value / goal.total_items * 100))
    : 0

  const inListIds = useMemo(() => new Set(goal.items.map(i => i.item_id)), [goal.items])

  // Blocked IDs = already in list + related items (PDF ↔ derived EPUB)
  const blockedIds = useMemo(() => {
    const blocked = new Set(inListIds)
    for (const item of allItems) {
      if (!item.derived_from) continue
      if (inListIds.has(item.id))           blocked.add(item.derived_from) // EPUB in list → block PDF
      if (inListIds.has(item.derived_from)) blocked.add(item.id)           // PDF in list → block EPUB
    }
    return blocked
  }, [allItems, inListIds])

  const pickable = useMemo(() => {
    const q = search.toLowerCase()
    return allItems.filter(i =>
      !blockedIds.has(i.id) &&
      (!q || i.title.toLowerCase().includes(q) || (i.author ?? '').toLowerCase().includes(q))
    ).slice(0, 10)
  }, [allItems, blockedIds, search])

  return (
    <div className="stats-goal-list-card">
      {/* Header */}
      <div className="stats-goal-list-header">
        <span className="stats-goal-list-title">{goal.title}</span>
        <div className="stats-goal-list-header-meta">
          <span>{goal.current_value}/{goal.total_items}</span>
          <div className="stats-goal-list-mini-bar">
            <div className="stats-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <button className="stats-goal-card-delete" onClick={onDelete} aria-label="Delete list">×</button>
      </div>

      {/* Item list */}
      {goal.items.length > 0 && (
        <div className="stats-goal-list-items">
          {goal.items.map(item => {
            const pct = Math.round(item.scroll_position * 100)
            return (
              <div
                key={item.item_id}
                className={`stats-goal-list-item${item.finished ? ' stats-goal-list-item--done' : ''}`}
              >
                <span className="stats-goal-list-check">{item.finished ? '✓' : '○'}</span>
                <div className="stats-goal-list-item-info">
                  <span className="stats-goal-list-item-title">{item.title}</span>
                  {item.author && <span className="stats-table-author">{item.author}</span>}
                  <div className="stats-goal-list-item-bar">
                    <div className="stats-goal-list-item-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <span className="stats-goal-list-item-pct">{pct}%</span>
                <button className="stats-goal-list-remove" onClick={() => onRemoveItem(item.item_id)} aria-label="Remove">×</button>
              </div>
            )
          })}
        </div>
      )}

      {/* Add book search — always at bottom */}
      <div className="stats-goal-list-search-wrap">
        <input
          className="stats-goal-list-search"
          placeholder="+ Add a book to this list…"
          value={search}
          onChange={e => { setSearch(e.target.value); setSearchActive(true) }}
          onFocus={() => setSearchActive(true)}
          onBlur={() => setTimeout(() => setSearchActive(false), 150)}
        />
        {searchActive && pickable.length > 0 && (
          <div className="stats-goal-list-search-results">
            {pickable.map(item => (
              <button
                key={item.id}
                className="stats-goal-item-picker-row"
                onMouseDown={e => e.preventDefault()}
                onClick={() => { onAddItem(item.id); setSearch(''); setSearchActive(false) }}
              >
                <span className="stats-goal-item-picker-title">{item.title}</span>
                {item.author && <span className="stats-table-author">{item.author}</span>}
              </button>
            ))}
          </div>
        )}
        {searchActive && search && pickable.length === 0 && (
          <div className="stats-goal-list-search-results">
            <span className="stats-goals-empty" style={{ padding: '8px 12px', display: 'block' }}>No matching books</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Goals section ──────────────────────────────────────────────────────────

function GoalsSection() {
  const [goals,        setGoals]        = useState<Goal[]>([])
  const [allItems,     setAllItems]     = useState<Item[]>([])
  const [loading,      setLoading]      = useState(true)
  const [creatingList, setCreatingList] = useState(false)
  const [newListName,  setNewListName]  = useState('')

  useEffect(() => {
    Promise.all([goalsService.getAll(), libraryService.getAll()])
      .then(([g, items]) => { setGoals(g); setAllItems(items) })
      .finally(() => setLoading(false))
  }, [])

  async function reloadGoals() {
    const g = await goalsService.getAll()
    setGoals(g)
  }

  async function handleUpsertPeriod(type: 'time' | 'count', period: GoalPeriod, target: number | null) {
    await goalsService.upsertPeriodGoal(type, period, target)
    await reloadGoals()
  }

  async function handleCreateList() {
    const title = newListName.trim()
    if (!title) return
    await goalsService.create({ type: 'list', title })
    setCreatingList(false)
    setNewListName('')
    await reloadGoals()
  }

  async function handleDeleteGoal(id: string) {
    await goalsService.delete(id)
    setGoals(prev => prev.filter(g => g.id !== id))
  }

  async function handleAddItem(goalId: string, itemId: string) {
    await goalsService.addItem(goalId, itemId)
    await reloadGoals()
  }

  async function handleRemoveItem(goalId: string, itemId: string) {
    await goalsService.removeItem(goalId, itemId)
    await reloadGoals()
  }

  const timeGoals  = goals.filter(g => g.type === 'time')
  const countGoals = goals.filter(g => g.type === 'count')
  const listGoals  = goals.filter(g => g.type === 'list')

  return (
    <section className="stats-section">
      <h2 className="stats-section-title">Goals</h2>

      {loading ? (
        <p className="stats-goals-empty">Loading…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Time goals — always visible */}
          <PeriodGoalGrid
            type="time"
            goals={timeGoals}
            onUpsert={(p, t) => handleUpsertPeriod('time', p, t)}
          />

          {/* Count goals — always visible */}
          <PeriodGoalGrid
            type="count"
            goals={countGoals}
            onUpsert={(p, t) => handleUpsertPeriod('count', p, t)}
          />

          {/* Reading lists — dynamic */}
          <div className="stats-goals-subsection">
            <div className="stats-section-row">
              <span className="stats-goals-subsection-label">Reading Lists</span>
              {!creatingList && (
                <button className="stats-goals-edit-btn" onClick={() => setCreatingList(true)}>
                  + New list
                </button>
              )}
            </div>

            {creatingList && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  autoFocus
                  value={newListName}
                  onChange={e => setNewListName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreateList(); if (e.key === 'Escape') { setCreatingList(false); setNewListName('') } }}
                  placeholder="List name…"
                  className="stats-goals-input stats-goals-input--wide"
                  style={{ maxWidth: 260 }}
                />
                <button className="stats-goals-save-btn" onClick={handleCreateList}>Save</button>
                <button className="stats-goals-cancel-btn" onClick={() => { setCreatingList(false); setNewListName('') }}>Cancel</button>
              </div>
            )}

            {listGoals.length === 0 && !creatingList && (
              <p className="stats-goals-empty">
                No reading lists.{' '}
                <button className="stats-goals-inline-btn" onClick={() => setCreatingList(true)}>
                  Create one →
                </button>
              </p>
            )}

            {listGoals.length > 0 && (
              <div className="stats-goal-lists">
                {listGoals.map(goal => (
                  <ListGoalCard
                    key={goal.id}
                    goal={goal}
                    allItems={allItems}
                    onDelete={() => handleDeleteGoal(goal.id)}
                    onAddItem={itemId => handleAddItem(goal.id, itemId)}
                    onRemoveItem={itemId => handleRemoveItem(goal.id, itemId)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

// ── Per-item table ─────────────────────────────────────────────────────────

function ProgressBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.round(value * 100))
  return (
    <div className="stats-progress-bar" aria-label={`${pct}%`}>
      <div className="stats-progress-fill" style={{ width: `${pct}%` }} />
      <span className="stats-progress-label">{pct}%</span>
    </div>
  )
}

function ItemTable({ items }: { items: ItemStats[] }) {
  if (items.length === 0) {
    return (
      <p className="stats-empty-items">
        No reading history yet. Start reading to see per-item stats here.
      </p>
    )
  }

  return (
    <table className="stats-table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Type</th>
          <th>Progress</th>
          <th style={{ textAlign: 'right' }}>Time read</th>
          <th style={{ textAlign: 'right' }}>Sessions</th>
          <th style={{ textAlign: 'right' }}>Avg speed</th>
          <th style={{ textAlign: 'right' }}>Last read</th>
        </tr>
      </thead>
      <tbody>
        {items.map(it => (
          <tr key={it.id}>
            <td className="stats-table-title">
              <span className="stats-table-title-text">{it.title}</span>
              {it.author && <span className="stats-table-author">{it.author}</span>}
            </td>
            <td>
              <span className={`stats-type-badge stats-type-${it.content_type}`}>
                {it.content_type}
              </span>
            </td>
            <td><ProgressBar value={it.scroll_position} /></td>
            <td className="stats-table-num">
              {it.total_ms > 0 ? formatDuration(it.total_ms) : '—'}
            </td>
            <td className="stats-table-num">{it.session_count || '—'}</td>
            <td className="stats-table-num">
              {it.avg_wpm != null ? `${it.avg_wpm} wpm` : '—'}
            </td>
            <td className="stats-table-num">
              {it.last_read_at ? formatDate(it.last_read_at) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Main view ──────────────────────────────────────────────────────────────

export default function StatsView() {
  const navigate = useNavigate()

  const [summary,  setSummary]  = useState<StatsSummary | null>(null)
  const [timeline, setTimeline] = useState<DailyReading[]>([])
  const [items,    setItems]    = useState<ItemStats[]>([])
  const [streaks,  setStreaks]  = useState<StreakInfo>({ currentStreak: 0, longestStreak: 0 })
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    Promise.all([
      statsService.getSummary(),
      statsService.getTimeline(366),
      statsService.getByItem(),
      statsService.getStreaks(),
    ]).then(([s, t, it, sk]) => {
      setSummary(s)
      setTimeline(t)
      setItems(it)
      setStreaks(sk)
    }).finally(() => setLoading(false))
  }, [])

  const heatmapData = useMemo(() => fillTimeline(timeline, 366), [timeline])

  return (
    <div className="stats-layout">
      <header className="stats-header">
        <button className="stats-back-btn" onClick={() => navigate('/')}>
          ← Library
        </button>
        <h1 className="stats-title">Reading Stats</h1>
      </header>

      {loading ? (
        <div className="stats-loading">Loading…</div>
      ) : (
        <div className="stats-body">

          {/* Overview + streak cards */}
          <section className="stats-cards">
            <div className="stats-card">
              <span className="stats-card-value">{formatDuration(summary?.totalMs ?? 0)}</span>
              <span className="stats-card-label">Total reading time</span>
            </div>
            <div className="stats-card">
              <span className="stats-card-value">{summary?.itemsFinished ?? 0}</span>
              <span className="stats-card-label">Items finished</span>
            </div>
            <div className="stats-card">
              <span className="stats-card-value">{summary?.itemsStarted ?? 0}</span>
              <span className="stats-card-label">Items started</span>
            </div>
            <div className="stats-card">
              <span className="stats-card-value">{formatWords(summary?.wordsRead ?? 0)}</span>
              <span className="stats-card-label">Words read (est.)</span>
            </div>
            <div className="stats-card">
              <span className="stats-card-value">
                {streaks.currentStreak > 0 ? streaks.currentStreak : '—'}
              </span>
              <span className="stats-card-label">Day streak</span>
            </div>
            <div className="stats-card">
              <span className="stats-card-value">
                {streaks.longestStreak > 0 ? streaks.longestStreak : '—'}
              </span>
              <span className="stats-card-label">Longest streak</span>
            </div>
          </section>

          {/* Reading goals */}
          <GoalsSection />

          {/* 1-year activity heatmap */}
          <section className="stats-section">
            <h2 className="stats-section-title">Activity — past year</h2>
            <HeatmapCalendar data={heatmapData} />
          </section>

          {/* Per-item breakdown */}
          <section className="stats-section">
            <h2 className="stats-section-title">By item</h2>
            <ItemTable items={items} />
          </section>

        </div>
      )}
    </div>
  )
}
