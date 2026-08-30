// ─────────────────────────────────────────────────────────────────────────────
// cloudRepo — the ONE module that touches raw PostgREST (supabase-js).
//
// The design confines the hard-to-fake chained-query surface to this thin seam so
// the sync engine can mock a tiny flat interface (pull/push) instead of faking the
// supabase query builder. Real coverage of this module is the Phase-3 exit-gate
// spike against dev Supabase (Chunk 6), not CI.
//
// It maps between the LOCAL row shape (no user_id) and the Postgres mirror:
//   • push adds user_id, upserts, and `.select()`s back the SERVER-stamped
//     updated_at (the set_updated_at trigger overwrites whatever we send).
//   • pull filters by the per-table cursor (RLS scopes rows to the user) and strips
//     user_id so the engine only ever sees local-shaped rows.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js'
import type { SyncRow, SyncSpec } from './specs'

export interface CloudRepo {
  /** Rows changed on the server since `sinceCursor` (exclusive), oldest-first. */
  pull(spec: SyncSpec, sinceCursor: number): Promise<SyncRow[]>
  /** Upsert local rows; returns them with the server-stamped updated_at. */
  push(spec: SyncSpec, rows: SyncRow[]): Promise<SyncRow[]>
  /**
   * The maximum number of rows a single `pull` can return. The engine needs it to
   * tell a FULL (LIMIT-truncated) page from a drained one — a page whose last rows
   * share the max `updated_at` ms can straddle the LIMIT, and skipping past that ms
   * would silently drop the truncated tail. Optional: a fake that returns unbounded
   * pages omits it (the truncation-safe backoff then never triggers).
   */
  pageSize?: number
}

const PULL_PAGE = 1000

function stripUserId(row: Record<string, unknown>): SyncRow {
  const { user_id: _drop, ...rest } = row
  return rest as SyncRow
}

/**
 * The columns naming the REAL server unique constraint an upsert conflicts on.
 * Must match an actual PK/unique on the Postgres mirror:
 *   • Composite-key join tables (item_tags/collection_items/…) — server PK is
 *     (user_id, <local key>), so prepend user_id.
 *   • userScopedId single-entity tables (annotation_themes) — server PK is
 *     (user_id, id) because the id isn't globally unique (fixed preset ids), so
 *     prepend user_id here too even though the local key is single-column.
 *   • Everything else (items/tags/annotations/…) — a globally-unique `id`/`item_id`
 *     PK, used bare.
 */
export function conflictTargetFor(spec: SyncSpec): string[] {
  return spec.key.length > 1 || spec.userScopedId ? ['user_id', ...spec.key] : spec.key
}

/**
 * Build a CloudRepo over a live, authenticated Supabase client. `userId` is the
 * verified auth uid (RLS enforces it regardless, but push must stamp user_id to
 * satisfy the INSERT WITH CHECK policy).
 */
export function createSupabaseCloudRepo(client: SupabaseClient, userId: string): CloudRepo {
  return {
    pageSize: PULL_PAGE,

    async pull(spec, sinceCursor) {
      // append tables (reading_sessions) still order by the server updated_at.
      const { data, error } = await client
        .from(spec.table)
        .select('*')
        .gt('updated_at', sinceCursor)
        .order('updated_at', { ascending: true })
        .limit(PULL_PAGE)
      if (error) throw new Error(`pull ${spec.table} failed: ${error.message}`)
      return (data ?? []).map(stripUserId)
    },

    async push(spec, rows) {
      if (rows.length === 0) return []
      // Send only the synced columns + user_id; the server restamps updated_at.
      const payload = rows.map((r) => {
        const out: Record<string, unknown> = { user_id: userId }
        for (const c of spec.columns) out[c] = r[c] ?? null
        // append tables carry no local updated_at; the server column is NOT NULL,
        // so seed one (the trigger overwrites it anyway).
        if (spec.mode === 'append') out.updated_at = Date.now()
        return out
      })
      // The upsert conflict target must name a REAL server unique constraint
      // (see conflictTargetFor).
      const conflictTarget = conflictTargetFor(spec)
      const { data, error } = await client
        .from(spec.table)
        .upsert(payload, { onConflict: conflictTarget.join(',') })
        .select('*')
      if (error) throw new Error(`push ${spec.table} failed: ${error.message}`)
      return (data ?? []).map(stripUserId)
    },
  }
}
