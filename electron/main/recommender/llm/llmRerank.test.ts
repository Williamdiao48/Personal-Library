import { describe, it, expect, vi } from 'vitest'
import { llmRerankBooks, applyLlmBookRerank, LLM } from './llmRerank'
import type { LlmClient } from './ollamaClient'
import type { ScoredCandidate } from '../rerank'
import type { Candidate } from '../candidates'

// Pure except the injected client → no network, no DB, ABI-agnostic.

const v = (...xs: number[]) => Float32Array.from(xs)

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  title: 'A Book',
  author: 'An Author',
  subjects: ['Fantasy'],
  coverUrl: null,
  sourceId: 's',
  isbn: null,
  description: null,
  source: 'book',
  ...over,
})

const scored = (over: Partial<ScoredCandidate> = {}): ScoredCandidate => ({
  cand: cand(),
  vec: v(1, 0),
  score: 0.5,
  ...over,
})

/** A stub client returning a fixed reply (or null). */
const stub = (reply: unknown): LlmClient => ({ chatJson: vi.fn(async () => reply) })

const book = (id: string, score = 0.5): ScoredCandidate =>
  scored({ cand: cand({ sourceId: id, author: `Author ${id}` }), score })

describe('llmRerankBooks', () => {
  it('returns an empty map (and never calls the model) with no books or no digest', async () => {
    const client = stub({ rankings: [] })
    expect((await llmRerankBooks([], 'digest', client)).size).toBe(0)
    expect((await llmRerankBooks([book('s0')], '  ', client)).size).toBe(0)
    expect(client.chatJson).not.toHaveBeenCalled()
  })

  it('maps validated local ids back to sourceIds, clamping and dropping junk', async () => {
    const books = [book('s0'), book('s1'), book('s2')]
    const client = stub({
      rankings: [
        { id: 'b0', fit: 0.9 }, // → s0
        { id: 'b2', fit: 1.5 }, // → s2, clamped to 1
        { id: 'b9', fit: 0.5 }, // unknown id → dropped
        { id: 'b1', fit: 'x' }, // non-numeric fit → dropped
      ],
    })
    const out = await llmRerankBooks(books, 'digest', client)
    expect([...out.entries()].sort()).toEqual([
      ['s0', 0.9],
      ['s2', 1],
    ])
  })

  it('returns an empty map when the client fails (null reply)', async () => {
    expect((await llmRerankBooks([book('s0')], 'digest', stub(null))).size).toBe(0)
  })

  it('returns an empty map when the reply has no rankings array', async () => {
    expect((await llmRerankBooks([book('s0')], 'digest', stub({ oops: true }))).size).toBe(0)
  })

  it('only scores the top SHORTLIST books (ids past the cut are invalid)', async () => {
    const books = [book('s0'), book('s1'), book('s2')]
    const client = stub({
      rankings: [
        { id: 'b0', fit: 0.5 },
        { id: 'b1', fit: 0.6 },
        { id: 'b2', fit: 0.7 }, // beyond the SHORTLIST:2 cut → invalid → dropped
      ],
    })
    const out = await llmRerankBooks(books, 'digest', client, { ...LLM, SHORTLIST: 2 })
    expect([...out.keys()].sort()).toEqual(['s0', 's1'])
  })
})

describe('applyLlmBookRerank', () => {
  it('returns the input unchanged for an empty fit map', () => {
    const arr = [book('s0')]
    expect(applyLlmBookRerank(arr, new Map())).toBe(arr)
  })

  it('blends fit into book cosine on the cosine scale (exact math)', () => {
    // span = 0.6 − 0.2 = 0.4, min = 0.2; fitScaled = 0.2 + fit·0.4.
    const A = book('A', 0.6)
    const B = book('B', 0.2)
    const out = applyLlmBookRerank(
      [A, B],
      new Map([
        ['A', 0.5], // fitScaled 0.4 → 0.5·0.6 + 0.5·0.4 = 0.5
        ['B', 0.5], // fitScaled 0.4 → 0.5·0.2 + 0.5·0.4 = 0.3
      ]),
    )
    const byId = new Map(out.map((s) => [s.cand.sourceId, s.score]))
    expect(byId.get('A')).toBeCloseTo(0.5, 6)
    expect(byId.get('B')).toBeCloseTo(0.3, 6)
  })

  it('can promote a low-cosine book the model loves above a high-cosine one it dislikes', () => {
    const hi = book('hi', 0.6)
    const lo = book('lo', 0.2)
    const out = applyLlmBookRerank(
      [hi, lo],
      new Map([
        ['hi', 0],
        ['lo', 1],
      ]),
    )
    const byId = new Map(out.map((s) => [s.cand.sourceId, s.score]))
    // hi: 0.5·0.6 + 0.5·0.2 = 0.4 ; lo: 0.5·0.2 + 0.5·0.6 = 0.4 — the LLM pulled them level.
    expect(byId.get('lo')).toBeCloseTo(byId.get('hi')!, 6)
    expect(byId.get('lo')).toBeGreaterThan(0.2) // lo was lifted from its cosine of 0.2
  })

  it('leaves fics and un-scored books untouched', () => {
    const fic = scored({ cand: cand({ sourceId: 'f', source: 'ao3' }), score: 0.55 })
    const scoredBook = book('b', 0.4)
    const unscored = book('u', 0.45)
    const out = applyLlmBookRerank(
      [fic, scoredBook, unscored],
      new Map([
        ['b', 1],
        ['f', 1],
      ]),
    )
    const byId = new Map(out.map((s) => [s.cand.sourceId, s.score]))
    expect(byId.get('f')).toBe(0.55) // fic ignored even though 'f' is in the map
    expect(byId.get('u')).toBe(0.45) // book absent from the map
    expect(byId.get('b')).not.toBe(0.4) // scored book blended
  })

  it('orders a degenerate (all-equal-cosine) bucket by fit alone', () => {
    const A = book('A', 0.5)
    const B = book('B', 0.5)
    const out = applyLlmBookRerank(
      [A, B],
      new Map([
        ['A', 1],
        ['B', 0],
      ]),
    )
    const byId = new Map(out.map((s) => [s.cand.sourceId, s.score]))
    expect(byId.get('A')).toBeCloseTo(0.75, 6) // 0.5·0.5 + 0.5·1
    expect(byId.get('B')).toBeCloseTo(0.25, 6) // 0.5·0.5 + 0.5·0
  })
})
