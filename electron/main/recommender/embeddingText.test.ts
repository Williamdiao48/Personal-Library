import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock only the file-I/O edge (extractPlainText); keep the real hasUsableContent
// + MIN_CONTENT_CHARS so the Tier-A/Tier-B gating is exercised for real.
vi.mock('./contentText', async (importActual) => {
  const actual = await importActual<typeof import('./contentText')>()
  return { ...actual, extractPlainText: vi.fn() }
})

import {
  itemMetadataText,
  chunkText,
  sampleChunks,
  poolVectors,
  blend,
  embedItemVector,
  WORDS_PER_CHUNK,
  SAMPLE_COUNT,
} from './embeddingText'
import { extractPlainText } from './contentText'
import type { Embedder } from './embedder'

const mockExtract = vi.mocked(extractPlainText)

function norm(v: Float32Array): number {
  let s = 0
  for (const x of v) s += x * x
  return Math.sqrt(s)
}

describe('itemMetadataText (Tier A)', () => {
  it('joins all present fields in order', () => {
    const text = itemMetadataText(
      {
        title: 'The Long Road',
        author: 'A. Writer',
        description: 'A journey.',
        review: 'Loved it.',
      },
      ['fantasy', 'slow-burn'],
    )
    expect(text).toBe(
      'title: The Long Road | author: A. Writer | tags: fantasy, slow-burn | description: A journey. | review: Loved it.',
    )
  })

  it('drops absent optional fields (title-only)', () => {
    expect(itemMetadataText({ title: 'Solo', author: null }, [])).toBe('title: Solo')
  })

  it('omits the tags segment when there are no tags', () => {
    expect(itemMetadataText({ title: 'X', author: 'Y' }, [])).toBe('title: X | author: Y')
  })

  it('truncates description/review to 400 chars', () => {
    const long = 'z'.repeat(500)
    const text = itemMetadataText({ title: 'T', description: long }, [])
    const desc = text.split('description: ')[1]
    expect(desc.length).toBe(400)
  })
})

describe('chunkText', () => {
  it('splits into ~WORDS_PER_CHUNK-word chunks', () => {
    const words = Array.from({ length: WORDS_PER_CHUNK * 2 + 50 }, (_, i) => `w${i}`).join(' ')
    const chunks = chunkText(words)
    expect(chunks).toHaveLength(3)
    expect(chunks[0].split(' ')).toHaveLength(WORDS_PER_CHUNK)
    expect(chunks[2].split(' ')).toHaveLength(50)
  })

  it('returns [] for empty/whitespace-only text', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n  ')).toEqual([])
  })
})

describe('sampleChunks', () => {
  it('returns all chunks (in order) when n <= k', () => {
    const chunks = ['a', 'b', 'c']
    expect(sampleChunks(chunks, 20)).toEqual(['a', 'b', 'c'])
  })

  it('picks exactly k, monotonic and spread across the whole range', () => {
    const chunks = Array.from({ length: 100 }, (_, i) => String(i))
    const picked = sampleChunks(chunks, SAMPLE_COUNT).map(Number)
    expect(picked).toHaveLength(SAMPLE_COUNT)
    // strictly increasing (spread, no dupes)
    for (let i = 1; i < picked.length; i++) expect(picked[i]).toBeGreaterThan(picked[i - 1])
    // covers early AND late document (not just the front)
    expect(picked[0]).toBeLessThan(10)
    expect(picked[picked.length - 1]).toBeGreaterThan(89)
  })
})

describe('poolVectors', () => {
  it('means then L2-normalizes', () => {
    const pooled = poolVectors([Float32Array.from([1, 0]), Float32Array.from([0, 1])])
    expect(norm(pooled)).toBeCloseTo(1, 5)
    expect(pooled[0]).toBeCloseTo(pooled[1], 5) // symmetric
    expect(pooled[0]).toBeCloseTo(Math.SQRT1_2, 5)
  })

  it('a single vector pools to its normalized self', () => {
    const pooled = poolVectors([Float32Array.from([3, 4])])
    expect(pooled[0]).toBeCloseTo(0.6, 5)
    expect(pooled[1]).toBeCloseTo(0.8, 5)
  })
})

describe('blend', () => {
  it('returns eMeta unchanged when there is no content fingerprint (Tier-A only)', () => {
    const eMeta = Float32Array.from([0.6, 0.8])
    expect(blend(eMeta, null)).toBe(eMeta)
  })

  it('normalizes the weighted sum of the two tiers', () => {
    const out = blend(Float32Array.from([1, 0]), Float32Array.from([0, 1]), 0.5, 0.5)
    expect(norm(out)).toBeCloseTo(1, 5)
    expect(out[0]).toBeCloseTo(Math.SQRT1_2, 5)
    expect(out[1]).toBeCloseTo(Math.SQRT1_2, 5)
  })

  it('respects asymmetric weights (meta-dominant)', () => {
    const out = blend(Float32Array.from([1, 0]), Float32Array.from([0, 1]), 0.9, 0.1)
    expect(out[0]).toBeGreaterThan(out[1])
  })
})

describe('embedItemVector (orchestrator)', () => {
  const item = {
    content_type: 'article' as const,
    file_path: 'x.html',
    title: 'Book',
    author: 'Auth',
  }

  function stubEmbedder(): Embedder {
    return {
      modelVersion: 'test',
      dim: 2,
      // Return a distinct unit vector per input so we can trace them.
      embed: vi.fn(async (texts: string[]) =>
        texts.map((_, i) => (i === 0 ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]))),
      ),
    }
  }

  beforeEach(() => mockExtract.mockReset())

  it('batches [metaText, ...chunks] in one embed call and returns a unit vector', async () => {
    mockExtract.mockResolvedValue('word '.repeat(900)) // > MIN, ~3 chunks
    const embedder = stubEmbedder()
    const out = await embedItemVector(item, ['sci-fi'], embedder)

    expect(embedder.embed).toHaveBeenCalledTimes(1)
    const batch = (embedder.embed as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
    expect(batch[0]).toContain('title: Book')
    expect(batch[0]).toContain('tags: sci-fi')
    expect(batch.length).toBeGreaterThan(1) // meta + chunk(s)
    expect(norm(out)).toBeCloseTo(1, 5)
  })

  it('falls back to Tier A alone (meta vector) when content is unusable', async () => {
    mockExtract.mockResolvedValue('') // scanned PDF / no content
    const embedder = stubEmbedder()
    const out = await embedItemVector(item, [], embedder)

    const batch = (embedder.embed as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
    expect(batch).toHaveLength(1) // meta only, no chunks
    expect(Array.from(out)).toEqual([1, 0]) // exactly the meta vector, unblended
  })
})
