import { describe, it, expect } from 'vitest'
import { sha256Hex } from './blobHash'

describe('sha256Hex', () => {
  it('matches known sha256 vectors', () => {
    expect(sha256Hex(Buffer.from(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('is stable for identical bytes and differs for different bytes (dedupe key)', () => {
    expect(sha256Hex(Buffer.from('same'))).toBe(sha256Hex(Buffer.from('same')))
    expect(sha256Hex(Buffer.from('a'))).not.toBe(sha256Hex(Buffer.from('b')))
  })
})
