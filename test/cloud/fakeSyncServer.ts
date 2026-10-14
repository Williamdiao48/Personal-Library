// A fake in-memory sync "server" standing in for the cloudRepo seam + Postgres:
// a server-stamped monotonic updated_at and cursor pull, the same contract that
// cloudRepo/Postgres provide. Shared by the sync-engine suite and the two-device blob
// suite, so device DBs can go through real runSyncRound rounds with no network.
import { keyOf } from '../../electron/main/cloud/sync/reconcile'
import type { SyncRow } from '../../electron/main/cloud/sync/specs'
import type { CloudRepo } from '../../electron/main/cloud/sync/cloudRepo'

export function makeFakeServer(): { repo: CloudRepo; clock: () => number } {
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
