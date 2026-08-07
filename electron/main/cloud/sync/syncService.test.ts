import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openTestDb, closeTestDb } from '../../../../test/db/harness'
import type { CloudRepo } from './cloudRepo'
import type { SyncRow } from './specs'
import { keyOf } from './reconcile'
import {
  getStatus,
  setEnabled,
  syncNow,
  schedule,
  notifyAuthChange,
  __setRepoFactoryForTest,
  __resetForTest,
} from './syncService'

// syncService is the long-lived driver around runSyncRound: the enabled gate, the
// triggers (sign-in event, poll, manual), single-flight, and broadcast status.
// The Supabase seam is faked via __setRepoFactoryForTest so these run with the
// in-memory db harness and zero network.

// A minimal in-memory server, same server-stamped-clock contract as cloudRepo.
function makeFakeServer(): { repo: CloudRepo; pushed: () => number } {
  const tables = new Map<string, Map<string, SyncRow>>()
  let clock = 1000
  let pushes = 0
  const tbl = (t: string) => {
    let m = tables.get(t)
    if (!m) tables.set(t, (m = new Map()))
    return m
  }
  return {
    pushed: () => pushes,
    repo: {
      async push(spec, rows) {
        const m = tbl(spec.table)
        const out: SyncRow[] = []
        for (const r of rows) {
          pushes++
          clock += 1
          const stamped: SyncRow = {}
          for (const c of spec.columns) stamped[c] = r[c] ?? null
          stamped.updated_at = clock
          m.set(keyOf(spec, stamped), stamped)
          out.push(stamped)
        }
        return out
      },
      async pull(spec, cursor) {
        return [...tbl(spec.table).values()]
          .filter((r) => Number(r.updated_at ?? 0) > cursor)
          .map((r) => ({ ...r }))
      },
    },
  }
}

function seedDirtyItem(db: ReturnType<typeof openTestDb>, id: string): void {
  db.prepare(
    `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count, date_saved, date_modified, updated_at, dirty)
     VALUES (?, 'T', NULL, NULL, 'article', ?, 1, 100, 100, 100, 1)`,
  ).run(id, `${id}.html`)
}

let db: ReturnType<typeof openTestDb>

beforeEach(() => {
  __resetForTest()
  db = openTestDb()
})

afterEach(() => {
  __resetForTest()
  closeTestDb()
})

describe('enabled gate', () => {
  it('syncNow no-ops (does not touch the repo) while disabled', async () => {
    const server = makeFakeServer()
    __setRepoFactoryForTest(async () => server.repo)
    seedDirtyItem(db, 'i1')

    const status = await syncNow()

    expect(status.enabled).toBe(false)
    expect(server.pushed()).toBe(0)
    // Row stays dirty — nothing was pushed.
    expect(db.prepare('SELECT dirty FROM items WHERE id = ?').get('i1')).toMatchObject({ dirty: 1 })
  })

  it('runs a real round once enabled + a repo is available', async () => {
    const server = makeFakeServer()
    __setRepoFactoryForTest(async () => server.repo)
    setEnabled(true)
    seedDirtyItem(db, 'i1')

    const status = await syncNow()

    expect(status.enabled).toBe(true)
    expect(status.signedIn).toBe(true)
    // A fresh DB also seeds 10 default annotation themes (dirty=1), so the item is
    // one of several pushed rows — assert the round pushed and cleared it.
    expect(server.pushed()).toBeGreaterThan(0)
    expect(status.lastSyncedAt).toBeGreaterThan(0)
    expect(status.lastError).toBeNull()
    expect(db.prepare('SELECT dirty FROM items WHERE id = ?').get('i1')).toMatchObject({ dirty: 0 })
  })
})

describe('signed-out repo factory', () => {
  it('is not an error — reports signedIn=false and skips the round', async () => {
    __setRepoFactoryForTest(async () => null) // signed out / unconfigured
    setEnabled(true)
    seedDirtyItem(db, 'i1')

    const status = await syncNow()

    expect(status.signedIn).toBe(false)
    expect(status.lastError).toBeNull()
    expect(db.prepare('SELECT dirty FROM items WHERE id = ?').get('i1')).toMatchObject({ dirty: 1 })
  })
})

describe('failure reporting', () => {
  it('a failing round sets lastError without throwing', async () => {
    __setRepoFactoryForTest(async () => ({
      push: async () => {
        throw new Error('PostgREST down')
      },
      pull: async () => [],
    }))
    setEnabled(true)
    seedDirtyItem(db, 'i1')

    const status = await syncNow()

    expect(status.lastError).toContain('PostgREST down')
    expect(status.lastSyncedAt).toBeNull()
  })
})

describe('single-flight', () => {
  it('a concurrent syncNow coalesces into a single trailing rerun', async () => {
    let active = 0
    let maxConcurrent = 0
    const server = makeFakeServer()
    __setRepoFactoryForTest(async () => {
      active++
      maxConcurrent = Math.max(maxConcurrent, active)
      // Yield so the second call can observe `running`.
      await Promise.resolve()
      active--
      return server.repo
    })
    setEnabled(true)
    seedDirtyItem(db, 'i1')

    const [a, b] = await Promise.all([syncNow(), syncNow()])

    expect(maxConcurrent).toBe(1) // never two rounds at once
    expect(a.running).toBe(false) // the round that actually ran finished
    // `b` was rejected by the guard while `a` was in flight → it reports the live
    // (running) status and queues a trailing rerun rather than racing.
    expect(b.running).toBe(true)
  })
})

describe('notifyAuthChange', () => {
  it('sign-out flips signedIn false without a sync', async () => {
    const server = makeFakeServer()
    __setRepoFactoryForTest(async () => server.repo)
    setEnabled(true)

    notifyAuthChange(false)

    expect(getStatus().signedIn).toBe(false)
    expect(server.pushed()).toBe(0)
  })

  it('sign-in while enabled schedules a debounced round', async () => {
    vi.useFakeTimers()
    try {
      const server = makeFakeServer()
      let rounds = 0
      __setRepoFactoryForTest(async () => {
        rounds++
        return server.repo
      })
      setEnabled(true) // this itself schedules one round
      seedDirtyItem(db, 'i1')

      notifyAuthChange(true)
      await vi.advanceTimersByTimeAsync(5_000) // past the debounce window

      expect(rounds).toBe(1) // setEnabled + sign-in coalesced into one round
      expect(server.pushed()).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('schedule (debounce)', () => {
  it('collapses a burst into one round', async () => {
    vi.useFakeTimers()
    try {
      const server = makeFakeServer()
      let rounds = 0
      __setRepoFactoryForTest(async () => {
        rounds++
        return server.repo
      })
      setEnabled(true)
      seedDirtyItem(db, 'i1')

      schedule()
      schedule()
      schedule()
      await vi.advanceTimersByTimeAsync(5_000)

      expect(rounds).toBe(1) // the burst (plus setEnabled's own) ran exactly once
    } finally {
      vi.useRealTimers()
    }
  })

  it('is a no-op while disabled', async () => {
    vi.useFakeTimers()
    try {
      let rounds = 0
      __setRepoFactoryForTest(async () => {
        rounds++
        return makeFakeServer().repo
      })
      schedule()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(rounds).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
