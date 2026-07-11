import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openTestDb, closeTestDb } from '../../../test/db/harness'
import { loadCandidateVectors, saveCandidateVectors } from './candidateEmbeddings'

// candidateEmbeddings imports the db singleton → Node ABI (openTestDb).

describe('candidateEmbeddings cache', () => {
  beforeEach(() => openTestDb())
  afterEach(() => closeTestDb())

  it('round-trips vectors keyed by sourceId; missing ids are absent', () => {
    saveCandidateVectors(
      [
        { sourceId: '/works/A', vec: new Float32Array([0.1, 0.2, 0.3]) },
        { sourceId: 'https://ao3.org/works/1', vec: new Float32Array([1, 0, -1]) },
      ],
      'm1',
    )
    const got = loadCandidateVectors(
      ['/works/A', 'https://ao3.org/works/1', '/works/missing'],
      'm1',
    )
    expect(got.size).toBe(2)
    expect(got.get('/works/A')![0]).toBeCloseTo(0.1)
    expect(got.get('/works/A')![2]).toBeCloseTo(0.3)
    expect(Array.from(got.get('https://ao3.org/works/1')!)).toEqual([1, 0, -1])
    expect(got.has('/works/missing')).toBe(false)
  })

  it('scopes by model_version — a different model is a miss', () => {
    saveCandidateVectors([{ sourceId: '/works/A', vec: new Float32Array([1, 2]) }], 'm1')
    expect(loadCandidateVectors(['/works/A'], 'm2').size).toBe(0)
    expect(loadCandidateVectors(['/works/A'], 'm1').size).toBe(1)
  })

  it('upserts — re-saving a sourceId overwrites its vector', () => {
    saveCandidateVectors([{ sourceId: '/works/A', vec: new Float32Array([1, 1]) }], 'm1')
    saveCandidateVectors([{ sourceId: '/works/A', vec: new Float32Array([9, 9]) }], 'm1')
    expect(Array.from(loadCandidateVectors(['/works/A'], 'm1').get('/works/A')!)).toEqual([9, 9])
  })

  it('returns an empty map for no ids', () => {
    expect(loadCandidateVectors([], 'm1').size).toBe(0)
  })
})
