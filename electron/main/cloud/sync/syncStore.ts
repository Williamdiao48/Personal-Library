// ─────────────────────────────────────────────────────────────────────────────
// syncStore — the local (SQLite) side of the sync engine.
//
// All DB reads/writes the orchestrator needs, kept behind small named functions so
// syncEngine.ts stays readable and every primitive is testable against the
// in-memory harness. The pure decision logic lives in reconcile.ts; this file just
// executes a plan.
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { SyncSpec, SyncRow } from './specs'
import { SYNC_SPEC_BY_TABLE } from './specs'
import { keyOf } from './reconcile'
import { indexFtsText, readStoredFtsText } from '../../db/ftsText'
import { NAME_TOMB_SEP, NAME_TOMB_SEP_SQL } from '../../db/nameTombstone'

/** Stable per-install id (created once). Used for the LWW tiebreak / debugging. */
export function getDeviceId(db: Database): string {
  const row = db.prepare('SELECT device_id FROM sync_meta WHERE id = 1').get() as
    { device_id: string } | undefined
  if (row) return row.device_id
  const id = randomUUID()
  db.prepare('INSERT INTO sync_meta (id, device_id) VALUES (1, ?)').run(id)
  return id
}

export function getCursor(db: Database, table: string): number {
  const row = db.prepare('SELECT pull_cursor FROM sync_cursors WHERE table_name = ?').get(table) as
    { pull_cursor: number } | undefined
  return row?.pull_cursor ?? 0
}

export function setCursor(db: Database, table: string, cursor: number): void {
  db.prepare(
    `INSERT INTO sync_cursors (table_name, pull_cursor) VALUES (?, ?)
     ON CONFLICT(table_name) DO UPDATE SET pull_cursor = excluded.pull_cursor`,
  ).run(table, cursor)
}

const keyWhere = (spec: SyncSpec) => spec.key.map((k) => `${k} = ?`).join(' AND ')
const keyParams = (spec: SyncSpec, row: SyncRow) => spec.key.map((k) => row[k])

/** Local rows queued for push (dirty = 1), as the synced-column projection. */
export function selectDirty(db: Database, spec: SyncSpec): SyncRow[] {
  return db
    .prepare(`SELECT ${spec.columns.join(', ')} FROM ${spec.table} WHERE dirty = 1`)
    .all() as SyncRow[]
}

/**
 * After a push, write the server-stamped updated_at back and clear dirty — but
 * ONLY for rows unchanged since we snapshotted them (a concurrent local edit
 * re-dirties the row with a new updated_at; that edit must survive and re-push next
 * round). `preRows` are the exact rows we pushed; `serverRows` are the read-back.
 * Append tables have no local updated_at and are immutable, so just clear dirty.
 */
export function applyReadback(
  db: Database,
  spec: SyncSpec,
  preRows: SyncRow[],
  serverRows: SyncRow[],
): void {
  const serverByKey = new Map(serverRows.map((r) => [keyOf(spec, r), r]))
  const where = keyWhere(spec)

  if (spec.mode === 'append') {
    const stmt = db.prepare(`UPDATE ${spec.table} SET dirty = 0 WHERE ${where}`)
    for (const pre of preRows) stmt.run(...keyParams(spec, pre))
    return
  }

  // Grow-only max registers (specs.merge): the server's GREATEST trigger may have
  // lifted the value above what we pushed (a peer had a higher one), so write the
  // server's echoed value back too — otherwise a device that pushed the shallower row
  // would keep its stale, lower max. Never regresses local: the guard below only
  // touches the still-unchanged pushed row, and server >= pushed by GREATEST.
  const mergeCols = spec.merge ? Object.keys(spec.merge) : []

  for (const pre of preRows) {
    const server = serverByKey.get(keyOf(spec, pre))
    if (!server) continue // server didn't echo this row back — leave dirty, retry
    const preClock = pre.updated_at
    // Clear only if the local row is still the one we pushed (dirty + same clock).
    // Param order must match the SQL: SET updated_at=?, [merge=?…], WHERE key=?…, [clock=?].
    const clockPred = preClock == null ? 'updated_at IS NULL' : 'updated_at = ?'
    const setCols = ['updated_at = ?', ...mergeCols.map((c) => `${c} = ?`)]
    const params: unknown[] = [
      server.updated_at,
      ...mergeCols.map((c) => (server[c] === undefined ? null : server[c])),
      ...keyParams(spec, pre),
    ]
    if (preClock != null) params.push(preClock)
    db.prepare(
      `UPDATE ${spec.table} SET ${setCols.join(', ')}, dirty = 0
       WHERE ${where} AND dirty = 1 AND ${clockPred}`,
    ).run(...params)
  }
}

/** Local rows for the given keys, so the engine can compare LWW. Keyed by keyOf. */
export function localByKeys(db: Database, spec: SyncSpec, rows: SyncRow[]): Map<string, SyncRow> {
  const cols = [...spec.columns, 'dirty']
  const stmt = db.prepare(`SELECT ${cols.join(', ')} FROM ${spec.table} WHERE ${keyWhere(spec)}`)
  const map = new Map<string, SyncRow>()
  for (const r of rows) {
    const local = stmt.get(...keyParams(spec, r)) as SyncRow | undefined
    if (local) map.set(keyOf(spec, r), local)
  }
  return map
}

/** Upsert a single row (dirty=0). Shared by applyPull and the C4 survivor insert. */
function upsertOne(db: Database, spec: SyncSpec, row: SyncRow): void {
  const cols = spec.columns
  const placeholders = cols.map(() => '?').join(', ')
  const nonKey = cols.filter((c) => !spec.key.includes(c))
  db.prepare(
    `INSERT INTO ${spec.table} (${cols.join(', ')}, dirty) VALUES (${placeholders}, 0)
     ON CONFLICT(${spec.key.join(', ')}) DO UPDATE SET
       ${nonKey.map((c) => `${c} = excluded.${c}`).join(', ')}, dirty = 0`,
  ).run(...cols.map((c) => (row[c] === undefined ? null : row[c])))
}

/**
 * Write the winning pulled rows locally with dirty = 0 (a pulled row must not
 * immediately re-push). Upsert for LWW tables; INSERT-OR-IGNORE for append events.
 * For items, keep the local FTS index in step (title/author change → re-index,
 * preserving any content already indexed from the local file).
 */
export function applyPull(db: Database, spec: SyncSpec, rows: SyncRow[]): void {
  if (rows.length === 0) return
  if (spec.mode === 'append') {
    const cols = spec.columns
    const placeholders = cols.map(() => '?').join(', ')
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO ${spec.table} (${cols.join(', ')}, dirty) VALUES (${placeholders}, 0)`,
    )
    for (const r of rows) stmt.run(...cols.map((c) => (r[c] === undefined ? null : r[c])))
    return
  }
  for (const r of rows) {
    upsertOne(db, spec, r)
    if (spec.table === 'items') reindexItemFts(db, r)
  }
}

/** Re-derive the FTS postings for a pulled item (title/author from the row; content
 *  preserved from the local index if the bytes were already downloaded, else ''). */
function reindexItemFts(db: Database, row: SyncRow): void {
  const id = String(row.id)
  const rowidRow = db.prepare('SELECT rowid FROM items WHERE id = ?').get(id) as
    { rowid: number } | undefined
  if (!rowidRow) return
  const title = (row.title as string) ?? ''
  const author = (row.author as string) ?? ''
  const prior = readStoredFtsText(db, id)
  const content = prior?.content ?? ''
  // Contentless FTS5: delete the old postings (exact stored values) before insert.
  if (prior) {
    db.prepare(
      `INSERT INTO items_fts(items_fts, rowid, title, author, content) VALUES('delete', ?, ?, ?, ?)`,
    ).run(rowidRow.rowid, prior.title, prior.author, prior.content)
  }
  db.prepare(`INSERT INTO items_fts(rowid, title, author, content) VALUES(?, ?, ?, ?)`).run(
    rowidRow.rowid,
    title,
    author,
    content,
  )
  indexFtsText(db, id, title, author, content)
}

/**
 * C4 — the natural-key merge, integrated into the pull so it runs BEFORE applyPull
 * frees the local UNIQUE(name). For each incoming LIVE row whose name already
 * belongs to a DIFFERENT live local row, pick the deterministic survivor (smallest
 * id — the same rule planNaturalKeyMerge encodes) and resolve the loser:
 *   • Free the loser's name + ensure the survivor row exists locally FIRST, so the
 *     reference repoint has a valid FK target (the survivor may still be an
 *     unapplied incoming row — applyPull runs after this pass).
 *   • Repoint the loser's references onto the survivor (create survivor ref +
 *     tombstone loser ref, so the loser ref's removal propagates instead of
 *     orphaning the server's copy as a dangling link).
 *   • A LOCAL loser is tombstoned here; an INCOMING loser is mutated to a tombstone
 *     so applyPull writes it as one (its authoritative server tombstone is pushed by
 *     the device that OWNS it, which runs the same deterministic merge).
 * Deterministic survivor ⇒ both devices converge; idempotent across rounds.
 */
export function resolveNameCollisions(
  db: Database,
  spec: SyncSpec,
  remote: SyncRow[],
  now: number,
): void {
  if (!spec.naturalKey) return
  const nk = spec.naturalKey
  const idCol = spec.key[0]
  const refs = spec.referencedBy ?? []
  const findLocal = db.prepare(
    `SELECT ${idCol} AS id FROM ${spec.table} WHERE ${nk} = ? AND deleted_at IS NULL AND ${idCol} != ?`,
  )

  for (const r of remote) {
    if (r.deleted_at != null) continue // an incoming tombstone can't hold a live name
    const name = r[nk]
    const rid = String(r[idCol])
    const local = findLocal.get(name, rid) as { id: string } | undefined
    if (!local) continue

    const survivor = [rid, local.id].sort()[0]
    const loser = survivor === rid ? local.id : rid

    if (loser === local.id) {
      // Local row loses → tombstone it (frees its UNIQUE name via the null-suffix),
      // then materialize the incoming survivor now so refs have a valid FK target.
      db.prepare(
        `UPDATE ${spec.table} SET deleted_at = ?, updated_at = ?, dirty = 1, ${nk} = ${nk} || ${NAME_TOMB_SEP_SQL} || ${idCol} WHERE ${idCol} = ?`,
      ).run(now, now, local.id)
      upsertOne(db, spec, r) // survivor is the incoming row r
    } else {
      // Incoming row loses → apply it as a tombstone (its owner pushes the real one).
      // The survivor is the existing local row, so refs already have a valid target.
      r.deleted_at = now
      r[nk] = `${String(name)}${NAME_TOMB_SEP}${rid}`
    }

    for (const ref of refs) {
      const refSpec = SYNC_SPEC_BY_TABLE[ref.table]
      const otherKeys = refSpec.key.filter((k) => k !== ref.col)
      const cols = otherKeys.join(', ')
      // Repoint = create the survivor-pointing row for each live loser ref (revive on
      // conflict), THEN tombstone the loser refs. Not an in-place key UPDATE — the
      // loser ref must survive as a propagating tombstone so its removal reaches the
      // server (an in-place UPDATE would orphan the server's copy as a dangling link).
      db.prepare(
        `INSERT INTO ${ref.table} (${cols}, ${ref.col}, updated_at, dirty)
           SELECT ${cols}, ?, ?, 1 FROM ${ref.table} WHERE ${ref.col} = ? AND deleted_at IS NULL
         ON CONFLICT(${refSpec.key.join(', ')}) DO UPDATE SET
           deleted_at = NULL, updated_at = excluded.updated_at, dirty = 1`,
      ).run(survivor, now, loser)
      db.prepare(
        `UPDATE ${ref.table} SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE ${ref.col} = ? AND deleted_at IS NULL`,
      ).run(now, now, loser)
    }
  }
}

export { SYNC_SPEC_BY_TABLE }
