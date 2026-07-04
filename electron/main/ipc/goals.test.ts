import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { invoke, resetIpc } from '../../../test/stubs/electron'
import {
  openTestDb,
  closeTestDb,
  seedItem,
  seedSession,
  type TestDb,
} from '../../../test/db/harness'
import { registerGoalsHandlers } from './goals'

let db: TestDb

beforeEach(() => {
  resetIpc()
  db = openTestDb()
  registerGoalsHandlers()
})
afterEach(() => closeTestDb())

// Give an item explicit progress (status/scroll) for count/list goal math.
function setProgress(
  itemId: string,
  over: { status?: string; scroll?: number; lastRead?: number },
) {
  db.prepare(
    `INSERT INTO progress (item_id, scroll_position, status, last_read_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       scroll_position = excluded.scroll_position,
       status = excluded.status,
       last_read_at = excluded.last_read_at`,
  ).run(itemId, over.scroll ?? 0, over.status ?? null, over.lastRead ?? Date.now())
}

describe('goals IPC — CRUD', () => {
  it('create returns a goal with computed fields', async () => {
    const g = (await invoke('goals:create', {
      type: 'time',
      title: 'Read more',
      period: 'daily',
      targetMinutes: 30,
    })) as any
    expect(g).toMatchObject({
      type: 'time',
      title: 'Read more',
      target_minutes: 30,
      current_value: 0,
    })
    expect(((await invoke('goals:getAll')) as any[]).length).toBe(1)
  })

  it('update patches individual fields', async () => {
    const g = (await invoke('goals:create', {
      type: 'time',
      title: 'x',
      period: 'daily',
      targetMinutes: 10,
    })) as any
    await invoke('goals:update', g.id, { title: 'renamed', targetMinutes: 45 })
    const row = db.prepare('SELECT title, target_minutes FROM goals WHERE id = ?').get(g.id) as any
    expect(row).toEqual({ title: 'renamed', target_minutes: 45 })
  })

  it('delete removes the goal', async () => {
    const g = (await invoke('goals:create', { type: 'list', title: 'TBR' })) as any
    await invoke('goals:delete', g.id)
    expect(((await invoke('goals:getAll')) as any[]).length).toBe(0)
  })
})

describe('goals IPC — progress computation', () => {
  it('time goal sums reading-session minutes in the current period', async () => {
    const item = seedItem(db, {})
    seedSession(db, item, { started_at: Date.now(), duration: 30 * 60_000 }) // 30 min
    seedSession(db, item, { started_at: Date.now(), duration: 15 * 60_000 }) // 15 min
    const g = (await invoke('goals:create', {
      type: 'time',
      title: 't',
      period: 'daily',
      targetMinutes: 60,
    })) as any
    expect(g.current_value).toBe(45) // ms summed → minutes
  })

  it('count goal counts finished items in the current period', async () => {
    const a = seedItem(db, {})
    const b = seedItem(db, {})
    setProgress(a, { status: 'finished', lastRead: Date.now() })
    setProgress(b, { scroll: 0.4, lastRead: Date.now() }) // not finished
    const g = (await invoke('goals:create', {
      type: 'count',
      title: 'c',
      period: 'daily',
      targetCount: 3,
    })) as any
    expect(g.current_value).toBe(1)
  })

  it('list goal reports finished/total and groups a PDF with its derived EPUB', async () => {
    seedItem(db, { id: 'pdf', title: 'Book' })
    seedItem(db, { id: 'epub', title: 'Book (EPUB)' })
    db.prepare('UPDATE items SET derived_from = ? WHERE id = ?').run('pdf', 'epub')
    setProgress('epub', { scroll: 1 }) // finished via the derived member

    const g = (await invoke('goals:create', { type: 'list', title: 'TBR' })) as any
    await invoke('goals:addItem', g.id, 'pdf')
    await invoke('goals:addItem', g.id, 'epub')

    const [reloaded] = (await invoke('goals:getAll')) as any[]
    expect(reloaded.total_items).toBe(1) // grouped as one book
    expect(reloaded.current_value).toBe(1) // finished via derived EPUB
    expect(reloaded.items).toHaveLength(1)
  })

  it('removeItem detaches an item from a list goal', async () => {
    const item = seedItem(db, {})
    const g = (await invoke('goals:create', { type: 'list', title: 'TBR' })) as any
    await invoke('goals:addItem', g.id, item)
    await invoke('goals:removeItem', g.id, item)
    const [reloaded] = (await invoke('goals:getAll')) as any[]
    expect(reloaded.total_items).toBe(0)
  })
})

describe('goals IPC — upsertPeriodGoal', () => {
  it('creates, then updates, then deletes a period goal', async () => {
    const created = (await invoke('goals:upsertPeriodGoal', 'time', 'weekly', 120)) as any
    expect(created).toMatchObject({ type: 'time', period: 'weekly', target_minutes: 120 })
    expect(created.title).toBe('Weekly reading time')

    const updated = (await invoke('goals:upsertPeriodGoal', 'time', 'weekly', 200)) as any
    expect(updated.target_minutes).toBe(200)
    expect(((await invoke('goals:getAll')) as any[]).length).toBe(1) // upsert, not duplicate

    const deleted = await invoke('goals:upsertPeriodGoal', 'time', 'weekly', 0)
    expect(deleted).toBeNull()
    expect(((await invoke('goals:getAll')) as any[]).length).toBe(0)
  })
})
