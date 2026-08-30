import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openTestDb, closeTestDb } from '../../../../test/db/harness'
import type { CloudRepo } from './cloudRepo'
import type { SyncRow } from './specs'
import { keyOf } from './reconcile'

// The R2 orphan reaper is fired (fire-and-forget) at the end of a successful round.
// Mock it so we can assert the trigger without touching R2 or the reaper's own logic.
const reap = vi.hoisted(() => ({ scheduleReap: vi.fn() }))
vi.mock('../reaper', () => ({ scheduleReap: reap.scheduleReap }))

import {
  getStatus,
  setEnabled,
  syncNow,
  schedule,
  notifyLocalMutation,
  flushNow,
  notifyAuthChange,
  __setRepoFactoryForTest,
  __resetForTest,
} from './syncService'
import { getCursor, setCursor, getLastSyncedUserId } from './syncStore'

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

/** An item that "thinks" it's already synced (dirty=0) — the stale state the
 *  account-switch reset has to re-dirty. */
function seedCleanItem(db: ReturnType<typeof openTestDb>, id: string): void {
  db.prepare(
    `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count, date_saved, date_modified, updated_at, dirty)
     VALUES (?, 'T', NULL, NULL, 'article', ?, 1, 100, 100, 100, 0)`,
  ).run(id, `${id}.html`)
}

function dirtyCount(db: ReturnType<typeof openTestDb>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE dirty = 1`).get() as { n: number }).n
}

let db: ReturnType<typeof openTestDb>

beforeEach(() => {
  __resetForTest()
  reap.scheduleReap.mockClear()
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

    notifyAuthChange(null)

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

      notifyAuthChange('user-a')
      await vi.advanceTimersByTimeAsync(5_000) // past the debounce window

      expect(rounds).toBe(1) // setEnabled + sign-in coalesced into one round
      expect(server.pushed()).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('account-identity reconciliation', () => {
  // sync_cursors + per-row `dirty` are device-global, not per-account, so signing
  // into a different account on the same device must discard the previous account's
  // sync state and re-sync the whole local library — else the library stays dirty=0
  // (silent no-backup to the new account) and the first child edit orphan-FK-fails.
  it('first sign-in records the account without resetting sync state', () => {
    seedCleanItem(db, 'i1') // a row that already looks synced (dirty=0)
    setCursor(db, 'items', 500)

    notifyAuthChange('user-a')

    expect(getLastSyncedUserId(db)).toBe('user-a')
    // No prior account → no reset: the existing cursor + clean row are left alone.
    expect(getCursor(db, 'items')).toBe(500)
    expect(dirtyCount(db, 'items')).toBe(0)
  })

  it('re-signing into the SAME account leaves sync state untouched', () => {
    notifyAuthChange('user-a') // records user-a
    seedCleanItem(db, 'i1')
    setCursor(db, 'items', 500)

    notifyAuthChange('user-a') // same account again

    expect(getCursor(db, 'items')).toBe(500)
    expect(dirtyCount(db, 'items')).toBe(0)
  })

  it('signing into a DIFFERENT account clears cursors and re-dirties the library', () => {
    notifyAuthChange('user-a') // establish user-a as the last-synced account
    seedCleanItem(db, 'i1') // rows that "think" they're synced to user-a
    seedCleanItem(db, 'i2')
    setCursor(db, 'items', 500)

    notifyAuthChange('user-b') // account switch on the same device

    expect(getLastSyncedUserId(db)).toBe('user-b')
    expect(getCursor(db, 'items')).toBe(0) // cursor cleared → full re-pull from 0
    expect(dirtyCount(db, 'items')).toBe(2) // whole library re-dirtied → full re-push
  })

  it('sign-out does not change the recorded account', () => {
    notifyAuthChange('user-a')
    notifyAuthChange(null)
    expect(getLastSyncedUserId(db)).toBe('user-a')
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

describe('flushNow (durable push)', () => {
  it('runs a round and pushes dirty rows synchronously (no debounce) when enabled', async () => {
    const server = makeFakeServer()
    __setRepoFactoryForTest(async () => server.repo)
    setEnabled(true)
    seedDirtyItem(db, 'i1')

    // Unlike schedule()/notifyLocalMutation, flushNow resolves only after the push
    // has actually happened — no fake timers needed.
    const status = await flushNow()

    expect(status.lastSyncedAt).toBeGreaterThan(0)
    expect(server.pushed()).toBeGreaterThan(0)
    expect(db.prepare('SELECT dirty FROM items WHERE id = ?').get('i1')).toMatchObject({ dirty: 0 })
  })

  it('waits out an in-flight round, then forces one that sees the newest write', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const server = makeFakeServer()
    let calls = 0
    __setRepoFactoryForTest(async () => {
      // Block only the FIRST round so we can start a second write mid-flight.
      if (calls++ === 0) await gate
      return server.repo
    })
    setEnabled(true)
    seedDirtyItem(db, 'i1')

    // Kick a round that stalls inside the repo lookup, then dirty a NEW row and
    // flushNow — it must not resolve until that new row is pushed.
    const first = syncNow()
    seedDirtyItem(db, 'i2')
    const flushed = flushNow()
    release()
    await Promise.all([first, flushed])

    // Both rows land dirty=0 — the flush's forced round observed i2.
    expect(db.prepare('SELECT dirty FROM items WHERE id = ?').get('i1')).toMatchObject({ dirty: 0 })
    expect(db.prepare('SELECT dirty FROM items WHERE id = ?').get('i2')).toMatchObject({ dirty: 0 })
  })

  it('no-ops while sync is disabled', async () => {
    const server = makeFakeServer()
    __setRepoFactoryForTest(async () => server.repo)
    seedDirtyItem(db, 'i1')

    const status = await flushNow()

    expect(status.enabled).toBe(false)
    expect(server.pushed()).toBe(0)
    expect(db.prepare('SELECT dirty FROM items WHERE id = ?').get('i1')).toMatchObject({ dirty: 1 })
  })
})

describe('orphan reaper trigger', () => {
  it('schedules a reap after a successful round (items table is now fresh)', async () => {
    const server = makeFakeServer()
    __setRepoFactoryForTest(async () => server.repo)
    setEnabled(true)
    seedDirtyItem(db, 'i1')

    await syncNow()

    expect(reap.scheduleReap).toHaveBeenCalledTimes(1)
  })

  it('does NOT reap after a failed round (stale reference set)', async () => {
    __setRepoFactoryForTest(async () => ({
      push: async () => {
        throw new Error('PostgREST down')
      },
      pull: async () => [],
    }))
    setEnabled(true)
    seedDirtyItem(db, 'i1')

    await syncNow()

    expect(reap.scheduleReap).not.toHaveBeenCalled()
  })

  it('does NOT reap when signed out (no round ran)', async () => {
    __setRepoFactoryForTest(async () => null)
    setEnabled(true)

    await syncNow()

    expect(reap.scheduleReap).not.toHaveBeenCalled()
  })
})

describe('notifyLocalMutation', () => {
  it('schedules a debounced round after a local write when enabled', async () => {
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

      // A burst of local mutations (e.g. rating then review then tag) collapses
      // into a single push round.
      notifyLocalMutation()
      notifyLocalMutation()
      notifyLocalMutation()
      await vi.advanceTimersByTimeAsync(5_000)

      expect(rounds).toBe(1)
      expect(server.pushed()).toBeGreaterThan(0)
      expect(db.prepare('SELECT dirty FROM items WHERE id = ?').get('i1')).toMatchObject({
        dirty: 0,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('is a no-op while sync is disabled (local-only user pays nothing)', async () => {
    vi.useFakeTimers()
    try {
      let rounds = 0
      __setRepoFactoryForTest(async () => {
        rounds++
        return makeFakeServer().repo
      })
      seedDirtyItem(db, 'i1')

      notifyLocalMutation()
      await vi.advanceTimersByTimeAsync(5_000)

      expect(rounds).toBe(0)
      // Row stays dirty locally, ready to push if the user ever enables sync.
      expect(db.prepare('SELECT dirty FROM items WHERE id = ?').get('i1')).toMatchObject({
        dirty: 1,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

// A repo whose push always throws → runSyncRound reports the round as failed
// (surfaced via the driver's catch). pull is a no-op so the pre-pull phase is clean.
const failingRepo = (): CloudRepo => ({
  push: async () => {
    throw new Error('PostgREST down')
  },
  pull: async () => [],
})

const POLL_MS = 2 * 60_000

describe('exponential backoff', () => {
  it('each consecutive failure doubles the next poll delay', async () => {
    vi.useFakeTimers()
    try {
      __setRepoFactoryForTest(async () => failingRepo())
      setEnabled(true) // arms the debounce (signedIn flips true inside the first round)
      seedDirtyItem(db, 'i1')

      // 1st round fires via the debounce, fails → streak 1, poll re-armed backed off.
      await vi.advanceTimersByTimeAsync(4_000)
      const now1 = Date.now()
      expect(getStatus().consecutiveFailures).toBe(1)
      const delay1 = getStatus().nextRetryAt! - now1
      expect(delay1).toBe(POLL_MS * 2) // 2m base → 4m after one failure

      // Advancing by exactly delay1 lands on the poll → 2nd failure → delay doubles.
      await vi.advanceTimersByTimeAsync(delay1)
      const now2 = Date.now()
      expect(getStatus().consecutiveFailures).toBe(2)
      const delay2 = getStatus().nextRetryAt! - now2
      expect(delay2).toBe(delay1 * 2) // 8m
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps the backoff at MAX_BACKOFF_MS and never fires before it', async () => {
    vi.useFakeTimers()
    try {
      __setRepoFactoryForTest(async () => failingRepo())
      setEnabled(true)
      seedDirtyItem(db, 'i1')
      await vi.advanceTimersByTimeAsync(4_000) // failure 1

      // Drive several more failures by advancing to each armed retry.
      for (let i = 0; i < 6; i++) {
        const wait = getStatus().nextRetryAt! - Date.now()
        await vi.advanceTimersByTimeAsync(wait)
      }
      // The delay has plateaued at the 30-minute ceiling, not kept doubling.
      expect(getStatus().nextRetryAt! - Date.now()).toBe(30 * 60_000)
      expect(getStatus().consecutiveFailures).toBeGreaterThanOrEqual(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a success resets the streak and returns the poll to the base cadence', async () => {
    vi.useFakeTimers()
    try {
      let mode: 'fail' | 'ok' = 'fail'
      const server = makeFakeServer()
      __setRepoFactoryForTest(async () => (mode === 'fail' ? failingRepo() : server.repo))
      setEnabled(true)
      seedDirtyItem(db, 'i1')

      await vi.advanceTimersByTimeAsync(4_000) // failure 1
      const backedOff = getStatus().nextRetryAt! - Date.now()
      expect(getStatus().consecutiveFailures).toBe(1)
      expect(backedOff).toBe(POLL_MS * 2)

      // A manual syncNow runs IMMEDIATELY — it doesn't wait out the 4m backoff — and
      // now succeeds, so the streak clears and the poll returns to the 2m base.
      mode = 'ok'
      await syncNow()
      expect(getStatus().consecutiveFailures).toBe(0)
      expect(getStatus().lastError).toBeNull()
      expect(getStatus().nextRetryAt! - Date.now()).toBe(POLL_MS) // base cadence
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('pendingDirty observability', () => {
  it('counts rows queued to push and drops to 0 after a successful round', async () => {
    const server = makeFakeServer()
    __setRepoFactoryForTest(async () => server.repo)
    seedDirtyItem(db, 'i1')
    seedDirtyItem(db, 'i2')

    // Before syncing, the two items (plus the fresh DB's default dirty rows) are queued.
    expect(getStatus().pendingDirty).toBeGreaterThanOrEqual(2)

    setEnabled(true)
    await syncNow()

    // Everything pushed + read back → nothing left dirty.
    expect(getStatus().pendingDirty).toBe(0)
  })
})
