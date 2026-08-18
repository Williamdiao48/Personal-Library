// ─────────────────────────────────────────────────────────────────────────────
// syncEngine — the orchestrator. Runs ONE sync round: push all dirty rows, then
// pull + apply changes, both in FK-parent-first order. All decisions are made by
// the pure reconcile.ts; all I/O goes through the CloudRepo seam + syncStore. Kept
// thin and free of supabase-js so it can be tested with a fake repo + the harness.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from 'better-sqlite3'
import { SYNC_SPECS } from './specs'
import { planPull } from './reconcile'
import type { CloudRepo } from './cloudRepo'
import {
  selectDirty,
  applyReadback,
  getCursor,
  setCursor,
  localByKeys,
  applyPull,
  resolveNameCollisions,
} from './syncStore'

export interface SyncReport {
  ok: boolean
  pushed: Record<string, number>
  applied: Record<string, number>
  error?: string
}

// Keep the pull drain bounded per table so one round can't spin forever on a busy
// table; leftover changes are picked up next round (polling makes it eventual).
const MAX_PULL_PAGES = 50

/**
 * Push all locally-dirty rows (server stamps updated_at; we read it back and clear
 * dirty), then pull and apply remote changes since each table's cursor. Never
 * throws — a network/PostgREST error ends the round early and is reported, leaving
 * already-applied batches durably committed (cursors advance transactionally).
 */
export async function runSyncRound(db: Database, repo: CloudRepo): Promise<SyncReport> {
  const report: SyncReport = { ok: true, pushed: {}, applied: {} }
  const addApplied = (table: string, n: number) => {
    if (n > 0) report.applied[table] = (report.applied[table] ?? 0) + n
  }

  try {
    // ── PRE-PULL natural-key tables (C4) ─────────────────────────────────────────
    // A device must pull + merge same-named rows BEFORE it pushes its own live copy.
    // Otherwise the second device to sync pushes the contested name and trips the
    // server UNIQUE(user_id, name) (23505) BEFORE it reaches the pull phase where the
    // merge would run — its round aborts and it deadlocks. Pulling first lets
    // resolveNameCollisions rename the local loser to a freed tombstone name, so the
    // push below carries no colliding name. Only tags/collections/annotation_themes
    // have a naturalKey, and none FK-depend on a not-yet-pulled table (the ref-repoint
    // only touches links whose rows already exist locally), so this is FK-safe.
    for (const spec of SYNC_SPECS) {
      if (spec.naturalKey) addApplied(spec.table, await pullTable(db, repo, spec))
    }

    // ── PUSH (parent-first: a child's FK parent must exist server-side) ──────────
    for (const spec of SYNC_SPECS) {
      const dirty = selectDirty(db, spec)
      if (dirty.length === 0) continue
      const server = await repo.push(spec, dirty)
      db.transaction(() => applyReadback(db, spec, dirty, server))()
      report.pushed[spec.table] = dirty.length
    }

    // ── PULL + apply (parent-first: applied children reference existing parents) ──
    for (const spec of SYNC_SPECS) {
      addApplied(spec.table, await pullTable(db, repo, spec))
    }
  } catch (err) {
    report.ok = false
    report.error = err instanceof Error ? err.message : String(err)
  }

  return report
}

/**
 * Drain one table's pull queue (bounded by MAX_PULL_PAGES) and apply it, advancing
 * the cursor transactionally with each batch. Returns the number of rows applied.
 * Idempotent — safe to call twice a round (the C4 pre-pull + the main pull loop): the
 * second call resumes from the advanced cursor, so it re-does no work.
 */
async function pullTable(
  db: Database,
  repo: CloudRepo,
  spec: (typeof SYNC_SPECS)[number],
): Promise<number> {
  let applied = 0
  for (let page = 0; page < MAX_PULL_PAGES; page++) {
    const cursor = getCursor(db, spec.table)
    const remote = await repo.pull(spec, cursor)
    if (remote.length === 0) break

    const now = Date.now()
    db.transaction(() => {
      // Defer FK enforcement to COMMIT for this apply. A pulled page is ordered by
      // updated_at, NOT by dependency, so a row can reference a sibling that arrives
      // later in the same batch — most sharply items.derived_from → items(id), a
      // self-referential FK where a source edited after its derived child sorts AFTER
      // it. Immediate FK checking then aborts the whole round on the out-of-order
      // insert (a fresh device's first pull deterministically breaks). Deferring makes
      // the batch consistent-as-a-set: any genuine dangling ref still fails at commit,
      // so this relaxes ordering without masking real corruption. Auto-resets at commit.
      db.pragma('defer_foreign_keys = ON')
      // C4 first: free any losing UNIQUE name before applyPull inserts winners.
      if (spec.naturalKey) resolveNameCollisions(db, spec, remote, now)
      const plan = planPull(spec, remote, localByKeys(db, spec, remote))
      applyPull(db, spec, plan.apply)
      applied += plan.apply.length

      // Advance the cursor in the SAME txn as the apply (crash → re-pull, never
      // skip). The cursor is a `.gt(updated_at)` bound and updated_at is ms-
      // truncated, so several rows can share the max ms in a batch. If this page is
      // FULL (LIMIT-truncated), the max-ms rows may continue onto the next page, so
      // advancing to the max would skip that tail. Back off to just BEFORE the max
      // ms instead: the next page re-includes — and idempotently re-applies — that
      // ms's rows. A non-full page is fully drained → advance to the max. (A full
      // page whose rows ALL share one ms can't be sub-paged by timestamp, so advance
      // and accept the loss — an astronomically unlikely >LIMIT-rows-in-one-ms case.)
      let maxTs = cursor
      let minTs = Number.POSITIVE_INFINITY
      for (const r of remote) {
        const ts = Number(r.updated_at ?? 0)
        if (ts > maxTs) maxTs = ts
        if (ts < minTs) minTs = ts
      }
      const full = repo.pageSize !== undefined && remote.length >= repo.pageSize
      const newCursor = full && minTs !== maxTs ? maxTs - 1 : maxTs
      setCursor(db, spec.table, newCursor)
      if (newCursor <= cursor) remote.length = 0 // no forward progress → stop paging
    })()
    if (remote.length === 0) break // drained (or the no-progress guard fired)
  }
  return applied
}
