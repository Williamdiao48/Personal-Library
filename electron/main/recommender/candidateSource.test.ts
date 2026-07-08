import { describe, it, expect } from 'vitest'
import { unionCandidates } from './candidateSource'
import type { Candidate } from './candidates'

// unionCandidates is pure — ABI-agnostic.

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  title: 'A Book',
  author: 'An Author',
  subjects: [],
  coverUrl: null,
  sourceId: '/x',
  isbn: null,
  source: 'book',
  ...over,
})

describe('unionCandidates', () => {
  it('concatenates pools while keeping the first occurrence of each candidate', () => {
    const a = cand({ title: 'A', author: 'x', sourceId: '1' })
    const b = cand({ title: 'B', author: 'y', sourceId: '2' })
    expect(unionCandidates([[a], [b]]).map((c) => c.sourceId)).toEqual(['1', '2'])
  })

  it('drops a later candidate sharing a sourceId', () => {
    const a = cand({ title: 'A', author: 'x', sourceId: 'dup' })
    const a2 = cand({ title: 'Different', author: 'z', sourceId: 'dup' })
    expect(unionCandidates([[a], [a2]]).map((c) => c.title)).toEqual(['A'])
  })

  it('drops a later candidate sharing a normalized title|author (cross-source collision)', () => {
    const fic = cand({ title: 'The Hobbit!', author: 'Tolkien', sourceId: 'ao3', source: 'ao3' })
    const book = cand({ title: 'the hobbit', author: 'tolkien', sourceId: 'ol', source: 'book' })
    // Same key → the first pool's candidate wins.
    expect(unionCandidates([[fic], [book]]).map((c) => c.source)).toEqual(['ao3'])
  })
})
