import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { bringUpSchema } from '../../db/index'
import { keyOf } from './reconcile'
import { type SyncRow } from './specs'
import type { CloudRepo } from './cloudRepo'
import { runSyncRound } from './syncEngine'

// End-to-end sync tests: a fake in-memory "server" (standing in for the cloudRepo
// seam + Postgres) drives independent device DBs through real sync rounds. This
// exercises the whole engine — dirty push + server-stamped read-back, cursor pull,
// LWW apply, tombstone propagation, C4 merge, append union — with zero network.

// ── A fake server: server-stamped monotonic updated_at + cursor pull, exactly the
//    contract cloudRepo/Postgres provide. ────────────────────────────────────────
function makeFakeServer(): { repo: CloudRepo; clock: () => number } {
  const tables = new Map<string, Map<string, SyncRow>>()
  let clock = 1000
  const tbl = (t: string) => {
    let m = tables.get(t)
    if (!m) tables.set(t, (m = new Map()))
    return m
  }
  const repo: CloudRepo = {
    async push(spec, rows) {
      const m = tbl(spec.table)
      const out: SyncRow[] = []
      for (const r of rows) {
        clock += 1
        const prev = m.get(keyOf(spec, r))
        const stamped: SyncRow = {}
        for (const c of spec.columns) stamped[c] = r[c] ?? null
        // Model the server-side grow-only max trigger (specs.merge → GREATEST(new,old)),
        // so a shallower push can't lower the authoritative high-water mark.
        for (const [col, strat] of Object.entries(spec.merge ?? {})) {
          if (strat !== 'max' || !prev) continue
          const a = typeof stamped[col] === 'number' ? (stamped[col] as number) : null
          const b = typeof prev[col] === 'number' ? (prev[col] as number) : null
          if (a != null || b != null) stamped[col] = Math.max(a ?? 0, b ?? 0)
        }
        stamped.updated_at = clock // server trigger overwrites the client value
        m.set(keyOf(spec, stamped), stamped)
        out.push(stamped)
      }
      return out
    },
    async pull(spec, cursor) {
      return [...tbl(spec.table).values()]
        .filter((r) => Number(r.updated_at ?? 0) > cursor)
        .sort((a, b) => Number(a.updated_at ?? 0) - Number(b.updated_at ?? 0))
        .map((r) => ({ ...r }))
    },
  }
  return { repo, clock: () => clock }
}

function newDevice(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  bringUpSchema(db)
  return db
}

function seedItem(db: Database.Database, id: string, over: Partial<SyncRow> = {}): void {
  db.prepare(
    `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count, cover_path, description, date_saved, date_modified, updated_at)
     VALUES (?, ?, ?, ?, 'article', ?, 1, NULL, NULL, 100, 100, ?)`,
  ).run(id, over.title ?? 'T', over.author ?? null, null, `${id}.html`, over.updated_at ?? 100)
}

const liveIds = (db: Database.Database): string[] =>
  (
    db.prepare('SELECT id FROM items WHERE deleted_at IS NULL ORDER BY id').all() as {
      id: string
    }[]
  ).map((r) => r.id)

let server: ReturnType<typeof makeFakeServer>
let A: Database.Database
let B: Database.Database

beforeEach(() => {
  server = makeFakeServer()
  A = newDevice()
  B = newDevice()
})

describe('push', () => {
  it('clears dirty and writes the server-stamped updated_at back', async () => {
    seedItem(A, 'i1')
    expect(A.prepare('SELECT dirty FROM items WHERE id = ?').get('i1')).toMatchObject({ dirty: 1 })

    const report = await runSyncRound(A, server.repo)

    expect(report.ok).toBe(true)
    expect(report.pushed.items).toBe(1)
    const row = A.prepare('SELECT dirty, updated_at FROM items WHERE id = ?').get('i1') as {
      dirty: number
      updated_at: number
    }
    expect(row.dirty).toBe(0) // no longer queued
    expect(row.updated_at).toBeGreaterThan(1000) // server clock, not the seed's 100
  })
})

describe('two-device convergence', () => {
  it('an item created on A appears on B after both sync', async () => {
    seedItem(A, 'i1', { title: 'From A' })
    await runSyncRound(A, server.repo) // push i1 up
    expect(liveIds(B)).toEqual([]) // B hasn't synced yet

    await runSyncRound(B, server.repo) // pull i1 down
    expect(liveIds(B)).toEqual(['i1'])
    expect(B.prepare('SELECT title, dirty FROM items WHERE id = ?').get('i1')).toMatchObject({
      title: 'From A',
      dirty: 0, // a pulled row must not re-push
    })
  })

  it('a trash on A propagates as a tombstone that hides the item on B', async () => {
    seedItem(A, 'i1')
    await runSyncRound(A, server.repo)
    await runSyncRound(B, server.repo)
    expect(liveIds(B)).toEqual(['i1'])

    // A trashes it (soft-delete → dirty tombstone) and syncs.
    A.prepare('UPDATE items SET deleted_at = 5, dirty = 1 WHERE id = ?').run('i1')
    await runSyncRound(A, server.repo)
    await runSyncRound(B, server.repo)

    expect(liveIds(B)).toEqual([]) // gone from B's library
    expect(B.prepare('SELECT deleted_at FROM items WHERE id = ?').get('i1')).not.toMatchObject({
      deleted_at: null,
    })
  })
})

describe('LWW — last device to sync wins', () => {
  it('B’s later-synced edit overwrites A’s earlier one', async () => {
    seedItem(A, 'i1', { title: 'orig' })
    await runSyncRound(A, server.repo)
    await runSyncRound(B, server.repo) // both start from 'orig'

    // Both edit the same row offline.
    A.prepare('UPDATE items SET title = ?, dirty = 1 WHERE id = ?').run('edit-A', 'i1')
    B.prepare('UPDATE items SET title = ?, dirty = 1 WHERE id = ?').run('edit-B', 'i1')

    await runSyncRound(A, server.repo) // A syncs first
    await runSyncRound(B, server.repo) // B syncs second → B's push stamps the newest clock
    await runSyncRound(A, server.repo) // A pulls B's newer version

    expect(A.prepare('SELECT title FROM items WHERE id = ?').get('i1')).toMatchObject({
      title: 'edit-B',
    })
  })
})

describe('C4 — same-named tag created independently on two devices', () => {
  it('converges to a single survivor tag with the membership repointed', async () => {
    // Shared item, then each device makes its OWN "sci-fi" tag + link, all offline.
    seedItem(A, 'i1')
    seedItem(B, 'i1', { updated_at: 100 })
    const now = 200
    A.prepare(
      `INSERT INTO tags (id, name, color, updated_at) VALUES ('aaa','sci-fi','#fff',?)`,
    ).run(now)
    B.prepare(
      `INSERT INTO tags (id, name, color, updated_at) VALUES ('zzz','sci-fi','#000',?)`,
    ).run(now)
    A.prepare(`INSERT INTO item_tags (item_id, tag_id, updated_at) VALUES ('i1','aaa',?)`).run(now)
    B.prepare(`INSERT INTO item_tags (item_id, tag_id, updated_at) VALUES ('i1','zzz',?)`).run(now)

    // Converge: a few rounds each so both push and pull settle.
    for (let i = 0; i < 4; i++) {
      await runSyncRound(A, server.repo)
      await runSyncRound(B, server.repo)
    }

    // Each device now sees exactly ONE live 'sci-fi' tag, and it's the survivor 'aaa'.
    for (const db of [A, B]) {
      const live = db
        .prepare(`SELECT id FROM tags WHERE name = 'sci-fi' AND deleted_at IS NULL`)
        .all() as { id: string }[]
      expect(live.map((r) => r.id)).toEqual(['aaa'])
      // The loser 'zzz' is tombstoned…
      expect(db.prepare(`SELECT deleted_at FROM tags WHERE id = 'zzz'`).get()).not.toMatchObject({
        deleted_at: null,
      })
      // …and the item's live membership points at the survivor.
      const links = db
        .prepare(`SELECT tag_id FROM item_tags WHERE item_id = 'i1' AND deleted_at IS NULL`)
        .all() as { tag_id: string }[]
      expect(links.map((l) => l.tag_id)).toEqual(['aaa'])
    }
  })
})

describe('append events (reading_sessions) — union, never duplicated', () => {
  it('a session on A appears once on B and re-sync is idempotent', async () => {
    seedItem(A, 'i1')
    await runSyncRound(A, server.repo)
    await runSyncRound(B, server.repo)
    A.prepare(
      `INSERT INTO reading_sessions (id, item_id, started_at, ended_at, duration) VALUES ('s1','i1',1,2,1)`,
    ).run()

    await runSyncRound(A, server.repo)
    await runSyncRound(B, server.repo)
    await runSyncRound(B, server.repo) // extra round must not duplicate

    expect(B.prepare(`SELECT COUNT(*) n FROM reading_sessions WHERE id = 's1'`).get()).toEqual({
      n: 1,
    })
  })
})

describe('pull pagination — a tie on the max updated_at must not skip the truncated tail', () => {
  // Regression: the cursor is a `.gt(updated_at)` bound and updated_at is ms-
  // truncated, so a full (LIMIT-capped) page can END in the middle of a run of rows
  // sharing one ms. Advancing the cursor to that ms skips the rows of that ms that
  // fell just past the LIMIT — silently dropping them on the pulling device. This
  // bites exactly the initial sync of a large library (a bulk push stamps many rows
  // within the same ms). The fix backs the cursor off to before the max ms on a full
  // page so the next page re-includes the tail.
  function makePagedServer(rows: SyncRow[], pageSize: number): CloudRepo {
    return {
      pageSize,
      push: async () => [],
      async pull(spec, cursor) {
        if (spec.table !== 'items') return []
        return rows
          .filter((r) => Number(r.updated_at) > cursor)
          .sort((a, b) => Number(a.updated_at) - Number(b.updated_at))
          .slice(0, pageSize) // emulate PostgREST .limit(pageSize)
          .map((r) => ({ ...r }))
      },
    }
  }

  const serverItem = (id: string, updated_at: number): SyncRow => ({
    id,
    title: id,
    author: null,
    source_url: null,
    content_type: 'article',
    file_path: `${id}.html`,
    cover_path: null,
    word_count: null,
    description: null,
    date_saved: 100,
    date_modified: 100,
    updated_at,
    deleted_at: null,
  })

  it('pulls every row when a shared-ms tie straddles the LIMIT boundary', async () => {
    // updated_at: i1=10, i2=20, i3=20, i4=30 with pageSize 2. A cursor that jumps to
    // the batch max (20) after page 1 = [i1@10, i2@20] would skip i3@20.
    const repo = makePagedServer(
      [serverItem('i1', 10), serverItem('i2', 20), serverItem('i3', 20), serverItem('i4', 30)],
      2,
    )
    await runSyncRound(B, repo)
    expect(liveIds(B)).toEqual(['i1', 'i2', 'i3', 'i4'])
  })

  it('is idempotent — a second round pulls nothing new and keeps the cursor put', async () => {
    const repo = makePagedServer([serverItem('i1', 10), serverItem('i2', 20)], 2)
    await runSyncRound(B, repo)
    const report = await runSyncRound(B, repo)
    expect(report.applied.items ?? 0).toBe(0)
    expect(liveIds(B)).toEqual(['i1', 'i2'])
  })
})

describe('grow-only max register (progress.max_scroll_position) — end to end', () => {
  const seedProgress = (
    db: Database.Database,
    itemId: string,
    max: number,
    scroll: number,
    updated_at: number,
  ): void => {
    db.prepare(
      `INSERT INTO progress (item_id, scroll_position, max_scroll_position, updated_at, dirty)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(itemId, scroll, max, updated_at)
  }
  const maxOf = (db: Database.Database, itemId: string): number =>
    (
      db.prepare('SELECT max_scroll_position AS m FROM progress WHERE item_id = ?').get(itemId) as {
        m: number
      }
    ).m

  it('a newer-but-shallower peer write cannot drag the high-water mark backward', async () => {
    // Both devices hold the item; A read to 80% and synced, B never pulled that progress.
    seedItem(A, 'i1')
    await runSyncRound(A, server.repo)
    await runSyncRound(B, server.repo) // B pulls item metadata only (no progress yet)

    seedProgress(A, 'i1', 0.8, 0.8, 500)
    await runSyncRound(A, server.repo) // server high-water = 0.8

    // B, unaware of A's 0.8, opens at 10% and syncs. progress has no naturalKey, so B
    // PUSHES 0.1 before it pulls — the exact ordering that plain LWW would regress.
    seedProgress(B, 'i1', 0.1, 0.1, 600)
    await runSyncRound(B, server.repo)

    // The server GREATEST trigger clamped B's push up to 0.8, and applyReadback wrote
    // that back — so B's furthest-read never went below what the account already knew.
    expect(maxOf(B, 'i1')).toBe(0.8)
    expect(
      B.prepare('SELECT scroll_position AS s FROM progress WHERE item_id = ?').get('i1'),
    ).toMatchObject({
      s: 0.1, // current position still follows B's latest write
    })

    // And it propagates back to A undamaged.
    await runSyncRound(A, server.repo)
    expect(maxOf(A, 'i1')).toBe(0.8)
  })

  it('a peer’s deeper read lifts a caught-up (non-dirty) device on pull', async () => {
    seedItem(A, 'i1')
    seedProgress(A, 'i1', 0.2, 0.2, 300)
    await runSyncRound(A, server.repo)
    await runSyncRound(B, server.repo) // B pulls item + progress 0.2 (now non-dirty on B)
    expect(maxOf(B, 'i1')).toBe(0.2)

    // A reads deeper to 90% and syncs.
    A.prepare(
      'UPDATE progress SET scroll_position = 0.9, max_scroll_position = 0.9, updated_at = 400, dirty = 1 WHERE item_id = ?',
    ).run('i1')
    await runSyncRound(A, server.repo)

    await runSyncRound(B, server.repo) // B pulls A's deeper read
    expect(maxOf(B, 'i1')).toBe(0.9)
  })
})

describe('FK ordering — a self-referential derived_from applied before its source', () => {
  // Regression: items.derived_from → items(id) is an immediate, self-referential FK.
  // The pull applies rows in updated_at order, NOT dependency order — so if a derived
  // item (a converted PDF↔EPUB pair) has an OLDER updated_at than its source (source
  // edited after the derivation), a fresh device pulls the derived row first and the
  // insert trips the FK, aborting the whole round. Deterministic → sync stays broken.
  const seedDerived = (
    db: Database.Database,
    id: string,
    derivedFrom: string,
    updated_at: number,
  ): void => {
    db.prepare(
      `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count, cover_path, description, date_saved, date_modified, derived_from, updated_at)
       VALUES (?, 'D', NULL, NULL, 'epub', ?, 1, NULL, NULL, 100, 100, ?, ?)`,
    ).run(id, `${id}.epub`, derivedFrom, updated_at)
  }

  it('pulls the pair without a FOREIGN KEY failure even when the source is newer', async () => {
    // A: source + its derived child, both pushed.
    seedItem(A, 'src')
    seedDerived(A, 'der', 'src', 150)
    await runSyncRound(A, server.repo)

    // A edits the source later, so on the server src.updated_at > der.updated_at.
    A.prepare("UPDATE items SET title = 'src-v2', dirty = 1 WHERE id = 'src'").run()
    await runSyncRound(A, server.repo)

    // B (fresh) pulls: ascending updated_at ⇒ der BEFORE src ⇒ der.derived_from='src'
    // references a not-yet-applied row. Must not fail the round.
    const report = await runSyncRound(B, server.repo)
    expect(report.ok).toBe(true)
    expect(report.error).toBeUndefined()
    expect(liveIds(B).sort()).toEqual(['der', 'src'])
    expect(B.prepare("SELECT derived_from FROM items WHERE id = 'der'").get()).toMatchObject({
      derived_from: 'src',
    })
  })
})

describe('resilience', () => {
  it('a failing pull ends the round cleanly (ok=false, no throw)', async () => {
    seedItem(A, 'i1')
    // Fail the pull only for a non-naturalKey table (items), so the C4 pre-pull of the
    // naturalKey tables succeeds, the push half commits, and the MAIN pull phase then
    // blows up — exercising the "error mid-round leaves committed work durable" path.
    const flaky: CloudRepo = {
      push: server.repo.push,
      pull: async (spec, cursor) => {
        if (spec.table === 'items') throw new Error('PostgREST down')
        return server.repo.pull(spec, cursor)
      },
    }
    const report = await runSyncRound(A, flaky)
    expect(report.ok).toBe(false)
    expect(report.error).toContain('PostgREST down')
    // The push half still committed before the pull blew up.
    expect(A.prepare('SELECT dirty FROM items WHERE id = ?').get('i1')).toMatchObject({ dirty: 0 })
  })
})
