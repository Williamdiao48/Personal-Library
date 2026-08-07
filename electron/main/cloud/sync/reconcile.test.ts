import { describe, it, expect } from 'vitest'
import { SYNC_SPEC_BY_TABLE, type SyncRow, type SyncSpec } from './specs'
import { keyOf, clockOf, incomingWins, planPull, planNaturalKeyMerge } from './reconcile'

// The pure conflict engine. These tests ARE the C1–C6 conflict matrix — no DB,
// no mocks, just rows in and a plan out.

const items = SYNC_SPEC_BY_TABLE.items
const tags = SYNC_SPEC_BY_TABLE.tags
const itemTags = SYNC_SPEC_BY_TABLE.item_tags
const collItems = SYNC_SPEC_BY_TABLE.collection_items
const sessions = SYNC_SPEC_BY_TABLE.reading_sessions

const byKey = (spec: SyncSpec, rows: SyncRow[]) => new Map(rows.map((r) => [keyOf(spec, r), r]))

const item = (over: Partial<SyncRow> = {}): SyncRow => ({
  id: 'i1',
  title: 'T',
  content_type: 'article',
  updated_at: 100,
  deleted_at: null,
  ...over,
})

describe('keyOf / clockOf', () => {
  it('keyOf joins composite keys deterministically', () => {
    expect(keyOf(itemTags, { item_id: 'i1', tag_id: 't1' })).toBe(
      keyOf(itemTags, { item_id: 'i1', tag_id: 't1' }),
    )
    expect(keyOf(itemTags, { item_id: 'i1', tag_id: 't1' })).not.toBe(
      keyOf(itemTags, { item_id: 'i1', tag_id: 't2' }),
    )
  })
  it('clockOf treats missing/NULL updated_at as oldest (0)', () => {
    expect(clockOf({ updated_at: null })).toBe(0)
    expect(clockOf({})).toBe(0)
    expect(clockOf({ updated_at: 42 })).toBe(42)
  })
})

describe('C1 — same field edited on two devices (whole-row LWW)', () => {
  it('newer updated_at wins', () => {
    const local = item({ title: 'Local', updated_at: 100 })
    const remoteNewer = item({ title: 'Remote', updated_at: 200 })
    const remoteOlder = item({ title: 'Remote', updated_at: 50 })
    expect(incomingWins(items, remoteNewer, local)).toBe(true)
    expect(incomingWins(items, remoteOlder, local)).toBe(false)
  })

  it('planPull applies only the winners', () => {
    const local = [item({ id: 'i1', title: 'Local', updated_at: 100 })]
    const remote = [item({ id: 'i1', title: 'Remote', updated_at: 200 })]
    const plan = planPull(items, remote, byKey(items, local))
    expect(plan.apply).toHaveLength(1)
    expect(plan.apply[0].title).toBe('Remote')
  })
})

describe('C2 — edit on A vs delete on B (pure LWW on deleted_at)', () => {
  it('a later delete wins → tombstone applied', () => {
    const localEdit = item({ updated_at: 100, title: 'Edited' })
    const remoteDelete = item({ updated_at: 200, deleted_at: 200 })
    expect(incomingWins(items, remoteDelete, localEdit)).toBe(true)
  })
  it('a later edit wins → row resurrects with the edit', () => {
    const localDelete = item({ updated_at: 100, deleted_at: 100 })
    const remoteEdit = item({ updated_at: 200, deleted_at: null, title: 'Back' })
    expect(incomingWins(items, remoteEdit, localDelete)).toBe(true)
  })
})

describe('C3 — independent re-capture (new content_hash) — LWW, both blobs exist', () => {
  it('the newer row’s hash is authoritative; no merge, just LWW', () => {
    const local = item({ updated_at: 100, content_hash: 'hashA', blob_hash: 'blobA' })
    const remote = item({ updated_at: 200, content_hash: 'hashB', blob_hash: 'blobB' })
    const plan = planPull(items, [remote], byKey(items, [local]))
    expect(plan.apply[0].blob_hash).toBe('blobB')
  })
})

describe('C4 — same-named tag on two devices → natural-key merge', () => {
  it('picks the deterministic survivor (smallest id) and maps losers', () => {
    const rows: SyncRow[] = [
      { id: 'ttt', name: 'sci-fi', deleted_at: null },
      { id: 'aaa', name: 'sci-fi', deleted_at: null },
      { id: 'mmm', name: 'sci-fi', deleted_at: null },
      { id: 'solo', name: 'fantasy', deleted_at: null },
    ]
    const plan = planNaturalKeyMerge(tags, rows)
    expect(plan.tombstone.sort()).toEqual(['mmm', 'ttt'])
    expect(plan.loserToSurvivor.get('ttt')).toBe('aaa')
    expect(plan.loserToSurvivor.get('mmm')).toBe('aaa')
    expect(plan.loserToSurvivor.has('solo')).toBe(false) // unique name → untouched
  })

  it('converges regardless of input order (both devices compute the same survivor)', () => {
    const a: SyncRow[] = [
      { id: 'b', name: 'x', deleted_at: null },
      { id: 'a', name: 'x', deleted_at: null },
    ]
    const b = [...a].reverse()
    expect(planNaturalKeyMerge(tags, a).loserToSurvivor.get('b')).toBe('a')
    expect(planNaturalKeyMerge(tags, b).loserToSurvivor.get('b')).toBe('a')
  })

  it('ignores tombstoned rows (a deleted duplicate is not a collision)', () => {
    const rows: SyncRow[] = [
      { id: 'a', name: 'x', deleted_at: null },
      { id: 'b', name: 'x', deleted_at: 12345 }, // already tombstoned
    ]
    expect(planNaturalKeyMerge(tags, rows).tombstone).toEqual([])
  })

  it('is a no-op for tables without a natural key (items)', () => {
    const rows: SyncRow[] = [item({ id: 'i1' }), item({ id: 'i2' })]
    expect(planNaturalKeyMerge(items, rows).tombstone).toEqual([])
  })
})

describe('C5 — same content_hash, different item ids → NOT merged', () => {
  it('two distinct items sharing bytes stay two rows (dedupe is at the blob layer)', () => {
    // items has no naturalKey, so identical blob_hash never triggers a merge.
    const rows: SyncRow[] = [
      item({ id: 'i1', blob_hash: 'sameBlob' }),
      item({ id: 'i2', blob_hash: 'sameBlob' }),
    ]
    expect(planNaturalKeyMerge(items, rows).tombstone).toEqual([])
    // And a pull of one doesn't disturb the other (distinct keys).
    const plan = planPull(items, [rows[1]], byKey(items, [rows[0]]))
    expect(plan.apply).toHaveLength(1)
    expect(plan.apply[0].id).toBe('i2')
  })
})

describe('C6 — collection membership + ordering (per-row LWW; sort_order is a field)', () => {
  const ci = (over: Partial<SyncRow>): SyncRow => ({
    collection_id: 'c1',
    item_id: 'i1',
    sort_order: 0,
    updated_at: 100,
    deleted_at: null,
    ...over,
  })
  it('a newer reorder wins the position (last reorder wins, lossy by design)', () => {
    const local = ci({ sort_order: 3, updated_at: 100 })
    const remote = ci({ sort_order: 7, updated_at: 200 })
    const plan = planPull(collItems, [remote], byKey(collItems, [local]))
    expect(plan.apply[0].sort_order).toBe(7)
  })
  it('a membership removal (tombstone) propagates by LWW like any row', () => {
    const local = ci({ updated_at: 100, deleted_at: null })
    const remote = ci({ updated_at: 200, deleted_at: 200 })
    const plan = planPull(collItems, [remote], byKey(collItems, [local]))
    expect(plan.apply[0].deleted_at).toBe(200)
  })
})

describe('dirty-skip — an unpushed local edit is never clobbered by a pull', () => {
  it('skips a locally-dirty row even if the incoming row is newer', () => {
    const localDirty = item({ updated_at: 100, title: 'Local unpushed', dirty: 1 })
    const remoteNewer = item({ updated_at: 999, title: 'Remote' })
    const plan = planPull(items, [remoteNewer], byKey(items, [localDirty]))
    expect(plan.apply).toEqual([])
    expect(plan.skippedDirty).toEqual([keyOf(items, localDirty)])
  })
  it('applies to a clean (non-dirty) local row', () => {
    const localClean = item({ updated_at: 100, dirty: 0 })
    const remoteNewer = item({ updated_at: 999, title: 'Remote' })
    const plan = planPull(items, [remoteNewer], byKey(items, [localClean]))
    expect(plan.apply).toHaveLength(1)
  })
})

describe('append mode (reading_sessions) — union by id, no LWW', () => {
  const s = (over: Partial<SyncRow>): SyncRow => ({
    id: 's1',
    item_id: 'i1',
    started_at: 1,
    ended_at: 2,
    duration: 1,
    ...over,
  })
  it('applies a session the local side lacks', () => {
    const plan = planPull(sessions, [s({ id: 's1' })], byKey(sessions, []))
    expect(plan.apply).toHaveLength(1)
  })
  it('never re-applies a session already present locally (immutable event)', () => {
    const local = [s({ id: 's1', duration: 1 })]
    const remote = [s({ id: 's1', duration: 999 })] // even if server differs, ignore
    const plan = planPull(sessions, remote, byKey(sessions, local))
    expect(plan.apply).toEqual([])
  })
})

describe('tie-break — equal updated_at converges deterministically', () => {
  it('picks the lexicographically-greater serialization on an exact clock tie', () => {
    const local = item({ title: 'AAA', updated_at: 500 })
    const remoteHi = item({ title: 'ZZZ', updated_at: 500 })
    const remoteLo = item({ title: 'AAA', updated_at: 500 })
    expect(incomingWins(items, remoteHi, local)).toBe(true) // ZZZ > AAA
    expect(incomingWins(items, remoteLo, local)).toBe(false) // identical → keep local
  })
})
