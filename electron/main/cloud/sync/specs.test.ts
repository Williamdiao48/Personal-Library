import { describe, it, expect } from 'vitest'
import { SYNC_SPEC_BY_TABLE } from './specs'

// Electron-free / ABI-agnostic (pure module) — no DB, no rebuild toggle needed.
describe('SYNC_SPECS', () => {
  it('syncs items.file_hash so an import de-dups across a user’s devices', () => {
    // Without this column in the spec, a row synced to a second device arrives
    // with file_hash = NULL and the local findDuplicateByFileHash query can't
    // match it → the same file re-imported there mints a duplicate item.
    expect(SYNC_SPEC_BY_TABLE.items.columns).toContain('file_hash')
  })

  it('keeps items as whole-row LWW (file_hash rides the same conflict class)', () => {
    expect(SYNC_SPEC_BY_TABLE.items.mode).toBe('lww')
  })

  it('syncs items.purged_at so permanent-delete cascades (peers hide it + the blob is reapable)', () => {
    // If purged_at didn't sync, a permanent-delete on one device would leave the
    // item lingering in every other device's Trash and the shared R2 blob could
    // never be safely reaped (no cross-device signal that the bytes are unwanted).
    expect(SYNC_SPEC_BY_TABLE.items.columns).toContain('purged_at')
  })

  it('flags annotation_themes as userScopedId (its preset ids collide across users)', () => {
    // annotation_themes seeds fixed preset ids ('preset-love', …) identically on
    // every device, so `id` is NOT globally unique — the server PK is (user_id,
    // id). The flag drives cloudRepo's conflict target to name that real
    // constraint; without it a 2nd user's push RLS-fails on the 1st user's row.
    expect(SYNC_SPEC_BY_TABLE.annotation_themes.userScopedId).toBe(true)
  })

  it('leaves UUID-keyed single-entity tables un-userScopedId', () => {
    // items/tags/annotations/goals key on locally-generated UUIDs that never
    // collide across users, so they keep a bare global `id` PK.
    for (const t of ['items', 'tags', 'annotations', 'goals'] as const) {
      expect(SYNC_SPEC_BY_TABLE[t].userScopedId).toBeUndefined()
    }
  })
})
