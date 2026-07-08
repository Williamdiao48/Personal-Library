import { describe, it, expect, afterEach } from 'vitest'
import {
  openTestDb,
  closeTestDb,
  seedItem,
  seedEmbedding,
  type TestDb,
} from '../../../test/db/harness'
import { encodeVector } from './embeddingCodec'
import { cosine } from './vectorMath'
import { buildTasteCentroids, classifyTier, buildTaste, TASTE } from './taste'
import type { ItemWithSignals } from './signals'

const v = (...xs: number[]) => Float32Array.from(xs)
const l2 = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0))

const sig = (over: Partial<ItemWithSignals> = {}): ItemWithSignals => ({
  id: 'x',
  rating: null,
  status: 'unread',
  depth: 0,
  minutes: 0,
  hasReview: false,
  ...over,
})

// ── Pure: buildTasteCentroids (no db) ────────────────────────────────────────
describe('buildTasteCentroids', () => {
  it('liked-only → the normalized weighted mean, unit length, k=1', () => {
    const east = v(1, 0)
    const sigs = [sig({ id: 'a', rating: 5 }), sig({ id: 'b', rating: 4 })]
    const vecs = new Map([
      ['a', east],
      ['b', east],
    ])
    const [taste, ...rest] = buildTasteCentroids(sigs, vecs)
    expect(rest).toHaveLength(0) // k=1
    expect(cosine(taste, east)).toBeCloseTo(1, 6)
    expect(l2(taste)).toBeCloseTo(1, 6)
  })

  it('a disliked item pushes the taste vector away from it', () => {
    const east = v(1, 0)
    const north = v(0, 1)
    const sigs = [sig({ id: 'like', rating: 5 }), sig({ id: 'hate', rating: 0 })]
    const vecs = new Map([
      ['like', east],
      ['hate', north],
    ])
    const [taste] = buildTasteCentroids(sigs, vecs)
    // taste = normalize(east − β·north) → tilts south of east, so it's strictly
    // less aligned with north than the pure liked centroid (east) is.
    expect(cosine(taste, north)).toBeLessThan(cosine(east, north))
    expect(cosine(taste, north)).toBeLessThan(0)
  })

  it('empty liked set → [] (cold start)', () => {
    const sigs = [sig({ id: 'a', status: 'dropped' })] // negative only
    const vecs = new Map([['a', v(1, 0)]])
    expect(buildTasteCentroids(sigs, vecs)).toEqual([])
  })

  it('skips items with no embedding', () => {
    const sigs = [sig({ id: 'a', rating: 5 }), sig({ id: 'ghost', rating: 5 })]
    const vecs = new Map([['a', v(1, 0)]]) // 'ghost' un-embedded
    const [taste] = buildTasteCentroids(sigs, vecs)
    expect(cosine(taste, v(1, 0))).toBeCloseTo(1, 6) // only 'a' contributed
  })
})

// ── Pure: classifyTier ───────────────────────────────────────────────────────
describe('classifyTier', () => {
  const n = (count: number) => Array.from({ length: count }, (_, i) => sig({ id: `i${i}` }))

  it('0 → empty, 1 → thin, THIN_MAX → thin', () => {
    expect(classifyTier(n(0))).toBe('empty')
    expect(classifyTier(n(1))).toBe('thin')
    expect(classifyTier(n(TASTE.THIN_MAX))).toBe('thin')
  })

  it('THIN_MAX+1..NORMAL_MAX → normal', () => {
    expect(classifyTier(n(TASTE.THIN_MAX + 1))).toBe('normal')
    expect(classifyTier(n(TASTE.NORMAL_MAX))).toBe('normal')
  })

  it('above NORMAL_MAX → power', () => {
    expect(classifyTier(n(TASTE.NORMAL_MAX + 1))).toBe('power')
  })
})

// ── DB-backed: buildTaste orchestrator (Node ABI) ────────────────────────────
describe('buildTaste (orchestrator)', () => {
  afterEach(() => closeTestDb())

  const seedWithVec = (db: TestDb, over: Parameters<typeof seedItem>[1], vec: Float32Array) => {
    const id = seedItem(db, over)
    seedEmbedding(db, id, { embedding: encodeVector(vec) })
    return id
  }

  it('assembles a unit-length taste vector, tier, and weight-sorted liked set', () => {
    const db = openTestDb()
    seedWithVec(db, { rating: 5 }, v(1, 0, 0))
    seedWithVec(db, { rating: 4 }, v(0, 1, 0))
    const res = buildTaste()
    expect(res.tier).toBe('thin') // 2 embeddable items
    expect(res.centroids).toHaveLength(1)
    expect(l2(res.centroids[0])).toBeCloseTo(1, 5)
    expect(res.liked).toHaveLength(2)
    // 5★ outweighs 4★ → sorted first
    expect(res.liked[0].weight).toBeGreaterThan(res.liked[1].weight)
  })

  it('a rating change moves the taste vector (re-weight, no re-embed — D1)', () => {
    const db = openTestDb()
    const a = seedWithVec(db, { rating: 5 }, v(1, 0))
    seedWithVec(db, { rating: 5 }, v(0, 1))
    const before = buildTaste().centroids[0]
    // flip item `a` from loved to hated → taste should swing toward the other item
    db.prepare('UPDATE items SET rating = 0 WHERE id = ?').run(a)
    const after = buildTaste().centroids[0]
    expect(cosine(before, after)).toBeLessThan(0.999)
  })

  it('excludes a rated item that has no embedding (skipped everywhere)', () => {
    const db = openTestDb()
    seedWithVec(db, { rating: 5 }, v(1, 0))
    seedItem(db, { rating: 5 }) // rated but NOT embedded
    const res = buildTaste()
    expect(res.tier).toBe('thin') // counts only the 1 embeddable item
    expect(res.liked).toHaveLength(1)
  })

  it('cold start: no embeddable items → empty tier, no centroids', () => {
    const db = openTestDb()
    seedItem(db, { rating: 5 }) // an item, but no embedding row → not embeddable
    const res = buildTaste()
    expect(res.tier).toBe('empty')
    expect(res.centroids).toEqual([])
    expect(res.liked).toEqual([])
  })
})
