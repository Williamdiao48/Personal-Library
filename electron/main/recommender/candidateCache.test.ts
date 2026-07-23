import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openTestDb, closeTestDb, type TestDb } from '../../../test/db/harness'
import {
  readCandidateCache,
  writeCandidateCache,
  evictStaleCandidates,
  CANDIDATE_RETENTION_MS,
} from './candidateCache'
import { saveCandidateVectors } from './candidateEmbeddings'

// The candidate_cache TTL cache is a thin get/write pair over the candidate_cache
// table (migration 20). Impure edge is the DB only (Node ABI).

const TTL = 60_000

describe('candidateCache', () => {
  let db: TestDb
  beforeEach(() => {
    db = openTestDb()
  })
  afterEach(() => closeTestDb())

  it('returns null on a miss', () => {
    expect(readCandidateCache('ao3:v1:none', TTL, 1000)).toBeNull()
  })

  it('round-trips a written payload within the TTL', () => {
    const payload = [{ title: 'A' }, { title: 'B' }]
    writeCandidateCache('ao3:v1:k', payload, 1000)
    expect(readCandidateCache('ao3:v1:k', TTL, 1000 + TTL)).toEqual(payload)
  })

  it('treats an entry older than the TTL as a miss', () => {
    writeCandidateCache('ao3:v1:k', [{ title: 'A' }], 1000)
    expect(readCandidateCache('ao3:v1:k', TTL, 1000 + TTL + 1)).toBeNull()
  })

  it('overwrites an existing key on conflict (upsert), refreshing fetched_at', () => {
    writeCandidateCache('ao3:v1:k', [{ title: 'old' }], 1000)
    writeCandidateCache('ao3:v1:k', [{ title: 'new' }], 5000)
    const row = db.prepare(`SELECT COUNT(*) AS n FROM candidate_cache`).get() as { n: number }
    expect(row.n).toBe(1) // upsert, not a second row
    // served fresh from the new fetched_at (5000), stale relative to the old (1000)
    expect(readCandidateCache('ao3:v1:k', TTL, 5000 + TTL)).toEqual([{ title: 'new' }])
  })

  it('returns null when the stored payload is not valid JSON', () => {
    db.prepare(
      `INSERT INTO candidate_cache (query_key, payload_json, fetched_at) VALUES (?, ?, ?)`,
    ).run('ao3:v1:corrupt', '{not json', 1000)
    expect(readCandidateCache('ao3:v1:corrupt', TTL, 1000)).toBeNull()
  })

  // ── evictStaleCandidates (L5 — bound unbounded cache growth) ────────────────
  describe('evictStaleCandidates', () => {
    const now = 10 * CANDIDATE_RETENTION_MS

    it('deletes cache + embedding rows past the retention window, keeps fresh ones', () => {
      writeCandidateCache('fresh', [{ t: 1 }], now - 1000) // recent
      writeCandidateCache('stale', [{ t: 2 }], now - CANDIDATE_RETENTION_MS - 1) // aged out
      saveCandidateVectors([{ sourceId: '/works/fresh', vec: new Float32Array([1]) }], 'm', now - 1000)
      saveCandidateVectors(
        [{ sourceId: '/works/stale', vec: new Float32Array([2]) }],
        'm',
        now - CANDIDATE_RETENTION_MS - 1,
      )

      const removed = evictStaleCandidates(now)
      expect(removed).toBe(2) // one cache row + one embedding row

      expect(db.prepare(`SELECT query_key FROM candidate_cache`).all()).toEqual([
        { query_key: 'fresh' },
      ])
      expect(db.prepare(`SELECT source_id FROM candidate_embeddings`).all()).toEqual([
        { source_id: '/works/fresh' },
      ])
    })

    it('sweeps pre-migration embeddings that have a NULL cached_at', () => {
      // Simulate a row written before migration 33 (no cached_at stamp).
      db.prepare(
        `INSERT INTO candidate_embeddings (source_id, embedding, model_version) VALUES (?, ?, ?)`,
      ).run('/works/legacy', Buffer.from([0]), 'm')

      evictStaleCandidates(now)
      expect(db.prepare(`SELECT COUNT(*) n FROM candidate_embeddings`).get()).toEqual({ n: 0 })
    })
  })
})
