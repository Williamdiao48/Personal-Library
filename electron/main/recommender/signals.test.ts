import { describe, it, expect, afterEach } from 'vitest'
import {
  openTestDb,
  closeTestDb,
  seedItem,
  seedSession,
  type TestDb,
} from '../../../test/db/harness'
import { loadItemSignals } from './signals'

// Needs the better-sqlite3 Node ABI (openTestDb). There's no progress seeder in
// the harness, so we insert progress rows directly.

function seedProgress(
  db: TestDb,
  itemId: string,
  over: {
    status?: string | null
    scroll_position?: number
    max_scroll_position?: number | null
  } = {},
): void {
  db.prepare(
    `INSERT INTO progress (item_id, scroll_position, max_scroll_position, status, last_read_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    itemId,
    over.scroll_position ?? 0,
    over.max_scroll_position ?? null,
    over.status ?? null,
    1_700_000_000_000,
  )
}

const byId = (rows: ReturnType<typeof loadItemSignals>, id: string) =>
  rows.find((r) => r.id === id)!

describe('loadItemSignals', () => {
  afterEach(() => closeTestDb())

  it('passes rating through, and 0 is distinct from null (not "unrated")', () => {
    const db = openTestDb()
    const rated = seedItem(db, { rating: 4.5 })
    const zero = seedItem(db, { rating: 0 })
    const unrated = seedItem(db, {})
    const rows = loadItemSignals()
    expect(byId(rows, rated).rating).toBe(4.5)
    expect(byId(rows, zero).rating).toBe(0)
    expect(byId(rows, unrated).rating).toBeNull()
  })

  it('prefers the explicit status over the scroll inference', () => {
    const db = openTestDb()
    // scrolled to the end but explicitly marked on-hold → on-hold wins
    const id = seedItem(db, {})
    seedProgress(db, id, { status: 'on-hold', scroll_position: 1, max_scroll_position: 1 })
    expect(byId(loadItemSignals(), id).status).toBe('on-hold')
  })

  it('infers finished / reading / unread from depth when status is null', () => {
    const db = openTestDb()
    const finished = seedItem(db, {})
    const reading = seedItem(db, {})
    const unread = seedItem(db, {})
    const noRow = seedItem(db, {})
    seedProgress(db, finished, { max_scroll_position: 1, scroll_position: 0.2 }) // read to end, scrolled back
    seedProgress(db, reading, { scroll_position: 0.4 })
    seedProgress(db, unread, { scroll_position: 0 })
    // noRow: no progress row at all
    const rows = loadItemSignals()
    expect(byId(rows, finished).status).toBe('finished')
    expect(byId(rows, finished).depth).toBeCloseTo(1, 6)
    expect(byId(rows, reading).status).toBe('reading')
    expect(byId(rows, unread).status).toBe('unread')
    expect(byId(rows, noRow).status).toBe('unread')
    expect(byId(rows, noRow).depth).toBe(0)
  })

  it('sums reading-session minutes (none → 0)', () => {
    const db = openTestDb()
    const busy = seedItem(db, {})
    const idle = seedItem(db, {})
    seedSession(db, busy, { duration: 90_000 }) // 1.5 min
    seedSession(db, busy, { duration: 30_000 }) // +0.5 min → 2 min total
    const rows = loadItemSignals()
    expect(byId(rows, busy).minutes).toBeCloseTo(2, 6)
    expect(byId(rows, idle).minutes).toBe(0)
  })

  it('reports hasReview only for a non-empty review', () => {
    const db = openTestDb()
    const wrote = seedItem(db, { review: 'Loved the pacing.' })
    const blank = seedItem(db, { review: '   ' })
    const none = seedItem(db, {})
    const rows = loadItemSignals()
    expect(byId(rows, wrote).hasReview).toBe(true)
    expect(byId(rows, blank).hasReview).toBe(false)
    expect(byId(rows, none).hasReview).toBe(false)
  })

  it('excludes soft-deleted items', () => {
    const db = openTestDb()
    const live = seedItem(db, {})
    seedItem(db, { deleted_at: 1_700_000_000_000 })
    const rows = loadItemSignals()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(live)
  })
})
