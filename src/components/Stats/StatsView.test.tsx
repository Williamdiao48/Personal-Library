import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import StatsView, {
  formatDuration,
  formatWords,
  formatDate,
  fillTimeline,
  buildHeatmapGrid,
  heatLevel,
} from './StatsView'
import type { DailyReading, Goal, Item, ItemStats } from '../../types'

// ── Pure helper unit tests ──────────────────────────────────────────────────

describe('StatsView helpers — formatting', () => {
  it('formatDuration switches units at the minute/hour boundaries', () => {
    expect(formatDuration(30_000)).toBe('30s')
    expect(formatDuration(5 * 60_000)).toBe('5m')
    expect(formatDuration(3_600_000 + 30 * 60_000)).toBe('1h 30m')
    expect(formatDuration(2 * 3_600_000)).toBe('2h')
  })

  it('formatWords abbreviates thousands and millions', () => {
    expect(formatWords(500)).toBe('500')
    expect(formatWords(12_000)).toBe('12K')
    expect(formatWords(2_500_000)).toBe('2.5M')
  })

  it('formatDate renders a localized month/day/year', () => {
    const out = formatDate(Date.UTC(2021, 5, 15, 12))
    expect(out).toMatch(/\d{4}/)
    expect(out).toContain('2021')
  })

  it('heatLevel buckets milliseconds into 0–4', () => {
    expect(heatLevel(0)).toBe(0)
    expect(heatLevel(10 * 60_000)).toBe(1)
    expect(heatLevel(20 * 60_000)).toBe(2)
    expect(heatLevel(45 * 60_000)).toBe(3)
    expect(heatLevel(90 * 60_000)).toBe(4)
  })
})

const dateFor = (offset: number) => {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  return d.toISOString().split('T')[0]
}

describe('StatsView helpers — fillTimeline', () => {
  it('produces a dense N-day series, keeping known values and zero-filling gaps', () => {
    const today = dateFor(0)
    const filled = fillTimeline([{ date: today, totalMs: 500 }], 3)
    expect(filled).toHaveLength(3)
    expect(filled[2]).toEqual({ date: today, totalMs: 500 }) // last entry = today, preserved
    expect(filled[0].totalMs).toBe(0) // gap zero-filled
    expect(filled[1].totalMs).toBe(0)
  })

  it('ignores sparse entries outside the requested window', () => {
    const old = dateFor(400)
    const filled = fillTimeline([{ date: old, totalMs: 999 }], 3)
    expect(filled.some((d) => d.totalMs === 999)).toBe(false)
  })
})

describe('StatsView helpers — buildHeatmapGrid', () => {
  it('builds a 53×7 grid, maps totals, and flags future cells', () => {
    const today = dateFor(0)
    const { weeks, monthLabels } = buildHeatmapGrid([{ date: today, totalMs: 1000 }])
    expect(weeks).toHaveLength(53)
    for (const week of weeks) expect(week).toHaveLength(7)

    const flat = weeks.flat()
    const todayCell = flat.find((d) => d.date === today)!
    expect(todayCell.totalMs).toBe(1000)
    expect(todayCell.isFuture).toBe(false)
    // Every cell dated after today must be flagged future.
    for (const cell of flat) if (cell.date > today) expect(cell.isFuture).toBe(true)

    expect(monthLabels.length).toBeGreaterThan(0)
    expect(monthLabels[0].label).toMatch(/[A-Za-z]{3}/)
  })
})

// ── Integration: full render with mocked services ───────────────────────────

vi.mock('../../services/stats', () => ({
  statsService: {
    getSummary: vi.fn(),
    getTimeline: vi.fn(),
    getByItem: vi.fn(),
    getStreaks: vi.fn(),
  },
}))
vi.mock('../../services/goals', () => ({
  goalsService: {
    getAll: vi.fn(),
    upsertPeriodGoal: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    addItem: vi.fn(),
    removeItem: vi.fn(),
  },
}))
vi.mock('../../services/library', () => ({
  libraryService: { getAll: vi.fn() },
}))
import { statsService } from '../../services/stats'
import { goalsService } from '../../services/goals'
import { libraryService } from '../../services/library'

const stats = statsService as unknown as Record<string, ReturnType<typeof vi.fn>>
const goals = goalsService as unknown as Record<string, ReturnType<typeof vi.fn>>
const library = libraryService as unknown as Record<string, ReturnType<typeof vi.fn>>

function goal(over: Partial<Goal>): Goal {
  return {
    id: 'g',
    type: 'time',
    title: '',
    period: 'daily',
    target_minutes: null,
    target_count: null,
    created_at: 0,
    current_value: 0,
    total_items: 0,
    items: [],
    ...over,
  }
}

const itemStat: ItemStats = {
  id: 'i1',
  title: 'Book One',
  author: 'Ann',
  content_type: 'epub',
  word_count: 1000,
  scroll_position: 0.5,
  total_ms: 600_000,
  session_count: 3,
  last_read_at: Date.UTC(2021, 0, 2, 12),
  avg_wpm: 220,
}

function renderStats() {
  return render(
    <MemoryRouter initialEntries={['/stats']}>
      <Routes>
        <Route path="/stats" element={<StatsView />} />
        <Route path="/" element={<div>LIBRARY HOME</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  stats.getSummary.mockResolvedValue({
    totalMs: 0,
    itemsStarted: 0,
    itemsFinished: 0,
    wordsRead: 0,
  })
  stats.getTimeline.mockResolvedValue([])
  stats.getByItem.mockResolvedValue([])
  stats.getStreaks.mockResolvedValue({ currentStreak: 0, longestStreak: 0 })
  goals.getAll.mockResolvedValue([])
  goals.upsertPeriodGoal.mockResolvedValue(undefined)
  goals.create.mockResolvedValue(undefined)
  goals.delete.mockResolvedValue(undefined)
  goals.addItem.mockResolvedValue(undefined)
  goals.removeItem.mockResolvedValue(undefined)
  library.getAll.mockResolvedValue([])
})

describe('StatsView — overview & item table', () => {
  it('renders formatted summary cards, streaks, and a per-item row', async () => {
    stats.getSummary.mockResolvedValue({
      totalMs: 2 * 3_600_000,
      itemsStarted: 3,
      itemsFinished: 1,
      wordsRead: 12_345,
    })
    stats.getStreaks.mockResolvedValue({ currentStreak: 5, longestStreak: 9 })
    stats.getByItem.mockResolvedValue([itemStat])
    renderStats()

    expect(await screen.findByText('By item')).toBeInTheDocument()
    expect(screen.getByText('2h')).toBeInTheDocument() // total reading time
    expect(screen.getByText('12K')).toBeInTheDocument() // words read
    expect(screen.getByText('5')).toBeInTheDocument() // current streak
    expect(screen.getByText('9')).toBeInTheDocument() // longest streak
    expect(screen.getByText('Book One')).toBeInTheDocument()
    expect(screen.getByText('220 wpm')).toBeInTheDocument()
  })

  it('shows an empty-state message when there is no reading history', async () => {
    renderStats()
    expect(await screen.findByText(/No reading history yet/)).toBeInTheDocument()
    // Streaks of 0 render as em dashes.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('navigates back to the library', async () => {
    renderStats()
    await screen.findByText('By item')
    fireEvent.click(screen.getByRole('button', { name: '← Library' }))
    expect(screen.getByText('LIBRARY HOME')).toBeInTheDocument()
  })
})

describe('StatsView — goals: period targets & lists', () => {
  it('sets a time target on an empty daily slot', async () => {
    renderStats()
    await screen.findByText('Reading Lists')

    const timeCard = screen
      .getByText('Reading Time')
      .closest('.stats-goal-period-card') as HTMLElement
    fireEvent.click(within(timeCard).getByRole('button', { name: /Daily/ }))
    fireEvent.change(within(timeCard).getByRole('spinbutton'), { target: { value: '30' } })
    await act(async () => {
      fireEvent.click(within(timeCard).getByRole('button', { name: 'Save' }))
    })
    expect(goals.upsertPeriodGoal).toHaveBeenCalledWith('time', 'daily', 30)
  })

  it('creates a reading list from the empty-state control', async () => {
    renderStats()
    await screen.findByText('Reading Lists')
    fireEvent.click(screen.getByRole('button', { name: '+ New list' }))
    fireEvent.change(screen.getByPlaceholderText('List name…'), { target: { value: 'Summer' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(goals.create).toHaveBeenCalledWith({ type: 'list', title: 'Summer' })
  })

  it('creates a list via Enter and cancels via the Cancel button', async () => {
    renderStats()
    await screen.findByText('Reading Lists')

    // Cancel path
    fireEvent.click(screen.getByRole('button', { name: '+ New list' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByPlaceholderText('List name…')).toBeNull()

    // Enter-to-create path
    fireEvent.click(screen.getByRole('button', { name: '+ New list' }))
    const input = screen.getByPlaceholderText('List name…')
    fireEvent.change(input, { target: { value: 'Winter' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(goals.create).toHaveBeenCalledWith({ type: 'list', title: 'Winter' })
  })
})

describe('StatsView — goals: populated list card', () => {
  const listGoal = goal({
    id: 'g-list',
    type: 'list',
    title: 'To Read',
    period: null,
    current_value: 1,
    total_items: 2,
    items: [
      { item_id: 'i1', title: 'In List Book', author: 'Zed', finished: true, scroll_position: 1 },
    ],
  })
  const addable = { id: 'i2', title: 'Addable Book', author: 'Amy', derived_from: null } as Item

  beforeEach(() => {
    goals.getAll.mockResolvedValue([
      goal({ id: 'g-time', type: 'time', period: 'daily', target_minutes: 30, current_value: 15 }),
      goal({ id: 'g-count', type: 'count', period: 'weekly', target_count: 5, current_value: 2 }),
      listGoal,
    ])
    library.getAll.mockResolvedValue([addable])
  })

  it('renders the progress rings and the list with its item', async () => {
    renderStats()
    expect(await screen.findByText('To Read')).toBeInTheDocument()
    expect(screen.getByText('In List Book')).toBeInTheDocument()
    expect(screen.getByText('15m')).toBeInTheDocument() // time ring value
    expect(screen.getByText('/5')).toBeInTheDocument() // count ring target
  })

  it('adds a searched book to the list', async () => {
    renderStats()
    const card = (await screen.findByText('To Read')).closest(
      '.stats-goal-list-card',
    ) as HTMLElement
    fireEvent.change(within(card).getByPlaceholderText('+ Add a book to this list…'), {
      target: { value: 'Add' },
    })
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: /Addable Book/ }))
    })
    expect(goals.addItem).toHaveBeenCalledWith('g-list', 'i2')
  })

  it('shows "No matching books" when the search has no results', async () => {
    renderStats()
    const card = (await screen.findByText('To Read')).closest(
      '.stats-goal-list-card',
    ) as HTMLElement
    fireEvent.change(within(card).getByPlaceholderText('+ Add a book to this list…'), {
      target: { value: 'zzzzz' },
    })
    expect(within(card).getByText('No matching books')).toBeInTheDocument()
  })

  it('clears an existing period goal from its editor', async () => {
    renderStats()
    await screen.findByText('To Read')
    const timeCard = screen
      .getByText('Reading Time')
      .closest('.stats-goal-period-card') as HTMLElement
    // The active Daily slot is a clickable div; open its editor, then Clear.
    fireEvent.click(within(timeCard).getByText('Daily').closest('.stats-period-slot')!)
    await act(async () => {
      fireEvent.click(within(timeCard).getByRole('button', { name: 'Clear' }))
    })
    expect(goals.upsertPeriodGoal).toHaveBeenCalledWith('time', 'daily', null)
  })

  it('removes an item and deletes the list', async () => {
    renderStats()
    const card = (await screen.findByText('To Read')).closest(
      '.stats-goal-list-card',
    ) as HTMLElement

    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Remove' }))
    })
    expect(goals.removeItem).toHaveBeenCalledWith('g-list', 'i1')

    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Delete list' }))
    })
    expect(goals.delete).toHaveBeenCalledWith('g-list')
  })
})
