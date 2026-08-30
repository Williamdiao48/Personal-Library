import { describe, it, expect } from 'vitest'
import { conflictTargetFor } from './cloudRepo'
import { SYNC_SPEC_BY_TABLE } from './specs'

// Electron-free / ABI-agnostic (pure helper) — no DB, no live Supabase, no rebuild
// toggle. The live push/pull path is covered by the Phase-3 spike, not CI; this
// pins only the pure conflict-target derivation, whose branches map 1:1 to a REAL
// server unique constraint (a wrong target is a runtime PostgREST error).
describe('conflictTargetFor', () => {
  it('uses the bare id for a globally-unique single-entity table (items)', () => {
    // Server PK is a plain `id` (locally-generated uuid) — never collides.
    expect(conflictTargetFor(SYNC_SPEC_BY_TABLE.items)).toEqual(['id'])
  })

  it('prepends user_id for a composite-key join table (item_tags)', () => {
    // Server PK is (user_id, item_id, tag_id); the local key alone is not unique.
    expect(conflictTargetFor(SYNC_SPEC_BY_TABLE.item_tags)).toEqual([
      'user_id',
      'item_id',
      'tag_id',
    ])
  })

  it('prepends user_id for a userScopedId single-key table (annotation_themes)', () => {
    // Server PK is (user_id, id) because preset ids collide across users. Without
    // the widen, onConflict:'id' names a constraint that no longer exists → error.
    expect(conflictTargetFor(SYNC_SPEC_BY_TABLE.annotation_themes)).toEqual(['user_id', 'id'])
  })
})
