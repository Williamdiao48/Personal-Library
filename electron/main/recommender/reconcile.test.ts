import { describe, it, expect } from 'vitest'
import { computeStale, type ReconcileItem, type ExistingEmbedding } from './reconcile'
import { itemMetadataText } from './embeddingText'
import { embeddingContentHash } from './embeddingCodec'

const MODEL = 'bge-1'

function item(over: Partial<ReconcileItem> = {}): ReconcileItem {
  return {
    id: over.id ?? 'i1',
    title: over.title ?? 'The Long Road',
    author: over.author ?? 'A. Writer',
    description: over.description ?? null,
    review: over.review ?? null,
    content_hash: over.content_hash ?? 'len:100',
  }
}

/** The hash computeStale expects for a fresh embedding of this item+tags. */
function freshHash(it: ReconcileItem, tags: string[] = []): string {
  return embeddingContentHash(itemMetadataText(it, tags), it.content_hash)
}

function existingMap(entries: [string, ExistingEmbedding][]): Map<string, ExistingEmbedding> {
  return new Map(entries)
}

describe('computeStale', () => {
  it('marks an item with no embedding row as stale', () => {
    const it = item()
    expect(computeStale([it], new Map(), new Map(), MODEL)).toEqual(['i1'])
  })

  it('skips an item whose stored hash + model match', () => {
    const it = item()
    const existing = existingMap([['i1', { content_hash: freshHash(it), model_version: MODEL }]])
    expect(computeStale([it], new Map(), existing, MODEL)).toEqual([])
  })

  it('re-embeds when the title changes (Tier-A metadata)', () => {
    const old = item({ title: 'Old Title' })
    const existing = existingMap([['i1', { content_hash: freshHash(old), model_version: MODEL }]])
    const renamed = item({ title: 'New Title' })
    expect(computeStale([renamed], new Map(), existing, MODEL)).toEqual(['i1'])
  })

  it('re-embeds when tags change (Tier-A)', () => {
    const it = item()
    // stored hash was computed with no tags
    const existing = existingMap([
      ['i1', { content_hash: freshHash(it, []), model_version: MODEL }],
    ])
    const tags = new Map([['i1', ['fantasy', 'slow-burn']]])
    expect(computeStale([it], tags, existing, MODEL)).toEqual(['i1'])
  })

  it('re-embeds when items.content_hash changes (Tier-B full text)', () => {
    const before = item({ content_hash: 'len:100' })
    const existing = existingMap([
      ['i1', { content_hash: freshHash(before), model_version: MODEL }],
    ])
    const after = item({ content_hash: 'len:250' }) // appended chapters, etc.
    expect(computeStale([after], new Map(), existing, MODEL)).toEqual(['i1'])
  })

  it('re-embeds everything when the model_version differs (model swap)', () => {
    const it = item()
    const existing = existingMap([
      ['i1', { content_hash: freshHash(it), model_version: 'bge-OLD' }],
    ])
    expect(computeStale([it], new Map(), existing, MODEL)).toEqual(['i1'])
  })

  it('returns only the stale subset across a mixed set', () => {
    const a = item({ id: 'a', title: 'A' })
    const b = item({ id: 'b', title: 'B' })
    const c = item({ id: 'c', title: 'C' })
    const existing = existingMap([
      ['a', { content_hash: freshHash(a), model_version: MODEL }], // fresh → skip
      ['b', { content_hash: 'stale', model_version: MODEL }], // changed → stale
      // c missing → stale
    ])
    expect(computeStale([a, b, c], new Map(), existing, MODEL).sort()).toEqual(['b', 'c'])
  })

  it('a NULL items.content_hash (import) is handled', () => {
    const it = item({ content_hash: null })
    const existing = existingMap([['i1', { content_hash: freshHash(it), model_version: MODEL }]])
    expect(computeStale([it], new Map(), existing, MODEL)).toEqual([])
  })
})
