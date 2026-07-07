import { describe, it, expect } from 'vitest'
import { encodeVector, decodeVector, embeddingContentHash } from './embeddingCodec'

describe('vector serialization', () => {
  it('round-trips a Float32Array exactly (encode → decode)', () => {
    const v = Float32Array.from([0, 1, -1, 0.5, -0.25, 3.14159, 1e-6, -2.5e3])
    const back = decodeVector(encodeVector(v))
    expect(back).toBeInstanceOf(Float32Array)
    expect(Array.from(back)).toEqual(Array.from(v)) // f32→bytes→f32 is lossless
  })

  it('encodes dim*4 bytes', () => {
    expect(encodeVector(new Float32Array(384))).toHaveLength(384 * 4)
    expect(encodeVector(new Float32Array(0))).toHaveLength(0)
  })

  it('is little-endian (1.0 → 00 00 80 3f)', () => {
    const buf = encodeVector(Float32Array.from([1]))
    expect([...buf]).toEqual([0x00, 0x00, 0x80, 0x3f])
  })

  it('decodes an empty buffer to an empty vector', () => {
    expect(decodeVector(Buffer.alloc(0))).toHaveLength(0)
  })
})

describe('embeddingContentHash', () => {
  it('is deterministic for the same inputs', () => {
    expect(embeddingContentHash('title: X | tags: a', 'len:99')).toBe(
      embeddingContentHash('title: X | tags: a', 'len:99'),
    )
  })

  it('changes when the metadata text changes (Tier A)', () => {
    expect(embeddingContentHash('title: X', 'h')).not.toBe(embeddingContentHash('title: Y', 'h'))
  })

  it('changes when the item content hash changes (Tier B)', () => {
    expect(embeddingContentHash('title: X', 'h1')).not.toBe(embeddingContentHash('title: X', 'h2'))
  })

  it('treats a NULL item content hash the same as empty (immutable imports)', () => {
    expect(embeddingContentHash('title: X', null)).toBe(embeddingContentHash('title: X', ''))
  })
})
