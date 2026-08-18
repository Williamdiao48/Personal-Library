// ─────────────────────────────────────────────────────────────────────────────
// The conflict engine — PURE (zero I/O, zero imports beyond specs types).
//
// This is the hard core of Phase 3, kept as a set of pure functions so the whole
// C1–C6 conflict matrix is unit-testable with no DB or network mocks (per the
// design's testing strategy). The orchestrator (Chunk 4) feeds it plain rows and
// applies the returned plan; all supabase/SQLite I/O lives outside this file.
// ─────────────────────────────────────────────────────────────────────────────

import type { SyncSpec, SyncRow } from './specs'

const KEY_SEP = '\u0000'

/** Composite primary-key string for a row (local shape — no user_id). */
export function keyOf(spec: SyncSpec, row: SyncRow): string {
  return spec.key.map((k) => String(row[k])).join(KEY_SEP)
}

/** The LWW comparand. Missing/NULL clock sorts oldest. */
export function clockOf(row: SyncRow): number {
  const v = row.updated_at
  return typeof v === 'number' ? v : 0
}

/**
 * Deterministic content fingerprint used ONLY to break an exact updated_at tie so
 * two devices converge on the identical winner. Serializes the synced columns in
 * their fixed spec order (order-stable, unlike JSON.stringify over an object).
 */
export function stableStringify(spec: SyncSpec, row: SyncRow): string {
  return JSON.stringify(spec.columns.map((c) => (row[c] === undefined ? null : row[c])))
}

/**
 * Fold a spec's `merge` (grow-only max) columns of `base` against `other`, returning
 * `base` UNCHANGED (same reference) when no register grows — so the caller can cheaply
 * detect "nothing to write" by identity. Only 'max' is defined today: the column
 * becomes max(base, other), treating null/undefined as absent (two absent values stay
 * absent rather than collapsing to 0). This is what makes a monotonic field converge
 * independently of the row-level LWW winner — it can never move backward across sync.
 */
export function foldMerge(spec: SyncSpec, base: SyncRow, other: SyncRow): SyncRow {
  if (!spec.merge) return base
  let out: SyncRow | null = null
  for (const [col, strat] of Object.entries(spec.merge)) {
    if (strat !== 'max') continue
    const a = typeof base[col] === 'number' ? (base[col] as number) : null
    const b = typeof other[col] === 'number' ? (other[col] as number) : null
    if (a == null && b == null) continue // both absent — leave the field as-is
    const folded = Math.max(a ?? 0, b ?? 0)
    if (folded !== a) {
      out = out ?? { ...base }
      out[col] = folded
    }
  }
  return out ?? base
}

/** Whether the incoming (remote) row should win LWW over the local row. */
export function incomingWins(spec: SyncSpec, incoming: SyncRow, local: SyncRow): boolean {
  const ci = clockOf(incoming)
  const cl = clockOf(local)
  if (ci > cl) return true
  if (ci < cl) return false
  // Exact tie (near-impossible with a server-stamped clock): converge on the
  // lexicographically-greater serialization so both devices pick the same row.
  return stableStringify(spec, incoming) > stableStringify(spec, local)
}

export interface PullPlan {
  /** Remote rows to write locally (caller upserts them with dirty=0). */
  apply: SyncRow[]
  /**
   * Keys the pull wanted to apply but a locally-dirty row blocked (kept for
   * observability/debugging; the local edit will push next cycle and the server
   * clock resolves the conflict). Not an error.
   */
  skippedDirty: string[]
}

/**
 * Decide which pulled rows to apply locally.
 *
 * Rule (per table): apply incoming iff
 *   - the local row is MISSING, or
 *   - the local row is NOT dirty AND (incoming wins LWW OR a merge register grew).
 * A locally-dirty row (unpushed local edit) is NEVER clobbered by a pull — this
 * is what makes conflict resolution skew-proof (the client wall clock never
 * decides whether a local edit survives; the row pushes next cycle and the
 * server-stamped clock decides; a dirty row's monotonic register re-converges via
 * applyReadback after that push). Append tables (reading_sessions) are a pure
 * union: apply iff the local side lacks the row.
 *
 * `merge` columns (grow-only max registers) sit OUTSIDE the LWW pick: whichever row
 * wins the row is folded with the loser's register so the register takes max(both).
 * That fixes the whole-row-LWW regression in BOTH directions — a newer-but-shallower
 * incoming row can't drag the field down (it wins the row but the fold keeps local's
 * higher value), and an older incoming row with a higher register still lifts local
 * even though it loses the row.
 */
export function planPull(
  spec: SyncSpec,
  remote: SyncRow[],
  localByKey: Map<string, SyncRow>,
): PullPlan {
  const apply: SyncRow[] = []
  const skippedDirty: string[] = []
  for (const inc of remote) {
    const k = keyOf(spec, inc)
    const local = localByKey.get(k)
    if (!local) {
      apply.push(inc)
      continue
    }
    if (spec.mode === 'append') continue // already have this immutable event
    if (local.dirty) {
      skippedDirty.push(k)
      continue
    }
    if (incomingWins(spec, inc, local)) {
      // Incoming wins the row; fold local's registers in so a shallower incoming
      // write can't regress a monotonic field.
      apply.push(foldMerge(spec, inc, local))
    } else {
      // Local wins the row, but an incoming register may still exceed it — apply a
      // register-lifted copy of local iff the fold actually grew something (foldMerge
      // returns local by identity when nothing changed, so this writes nothing in the
      // common case). The lifted value came from the server, so applyPull's dirty=0 is
      // correct — no re-push needed.
      const lifted = foldMerge(spec, local, inc)
      if (lifted !== local) apply.push(lifted)
    }
  }
  return { apply, skippedDirty }
}

export interface MergePlan {
  /** loser id → survivor id, for rewriting references before tombstoning the loser. */
  loserToSurvivor: Map<string, string>
  /** loser ids to soft-delete (tombstone + free their UNIQUE name). */
  tombstone: string[]
}

/**
 * C4 — the natural-key merge (the one place we merge rather than LWW).
 *
 * Two devices offline both create a tag/collection/theme with the same name but
 * different ids; on sync they collide on UNIQUE(user_id, name). Given the union of
 * LIVE rows for such a table, group by the natural key (name); any name held by
 * >1 id keeps a deterministic SURVIVOR (lexicographically-smallest id) and maps the
 * rest as losers. The orchestrator then rewrites each loser's references
 * (spec.referencedBy) onto the survivor and tombstones the loser. Idempotent and
 * convergent: every device computes the same survivor from the same id set.
 *
 * Pass only LIVE rows (deleted_at == null); tombstones don't participate.
 */
export function planNaturalKeyMerge(spec: SyncSpec, liveRows: SyncRow[]): MergePlan {
  const loserToSurvivor = new Map<string, string>()
  const tombstone: string[] = []
  if (!spec.naturalKey) return { loserToSurvivor, tombstone }

  const idsByName = new Map<string, string[]>()
  for (const r of liveRows) {
    if (r.deleted_at != null) continue
    const name = String(r[spec.naturalKey])
    const id = String(r[spec.key[0]])
    const arr = idsByName.get(name) ?? []
    arr.push(id)
    idsByName.set(name, arr)
  }

  for (const ids of idsByName.values()) {
    if (ids.length < 2) continue
    const sorted = [...ids].sort() // deterministic survivor = smallest id
    const survivor = sorted[0]
    for (const loser of sorted.slice(1)) {
      loserToSurvivor.set(loser, survivor)
      tombstone.push(loser)
    }
  }
  return { loserToSurvivor, tombstone }
}
