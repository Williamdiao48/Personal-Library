import { describe, it, expect } from 'vitest'
import { packArchive, unpackArchive, type ArchiveEntry } from './blobArchive'

const entry = (name: string, s: string): ArchiveEntry => ({ name, data: Buffer.from(s, 'utf8') })

describe('blobArchive', () => {
  it('round-trips names + bytes', () => {
    const entries = [entry('a-ch0.html', '<h1>one</h1>'), entry('a-ch1.html', '<h1>two</h1>')]
    const out = unpackArchive(packArchive(entries))
    expect(out.map((e) => e.name)).toEqual(['a-ch0.html', 'a-ch1.html'])
    expect(out.map((e) => e.data.toString('utf8'))).toEqual(['<h1>one</h1>', '<h1>two</h1>'])
  })

  it('is deterministic regardless of input order (stable R2 key)', () => {
    const a = packArchive([entry('x', 'X'), entry('y', 'Y'), entry('z', 'Z')])
    const b = packArchive([entry('z', 'Z'), entry('x', 'X'), entry('y', 'Y')])
    expect(a.equals(b)).toBe(true)
  })

  it('sorts entries by name in the packed output', () => {
    const out = unpackArchive(packArchive([entry('b', 'B'), entry('a', 'A')]))
    expect(out.map((e) => e.name)).toEqual(['a', 'b'])
  })

  it('handles a single-entry archive (single-file items)', () => {
    const out = unpackArchive(packArchive([entry('book.epub', 'EPUBBYTES')]))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ name: 'book.epub' })
    expect(out[0].data.toString('utf8')).toBe('EPUBBYTES')
  })

  it('preserves arbitrary binary bytes (not just utf8)', () => {
    const bin = Buffer.from([0x00, 0xff, 0x50, 0x4b, 0x03, 0x04, 0x0a, 0x7f])
    const out = unpackArchive(packArchive([{ name: 'f.bin', data: bin }]))
    expect(out[0].data.equals(bin)).toBe(true)
  })

  it('handles a zero-length file', () => {
    const out = unpackArchive(packArchive([entry('empty', ''), entry('nonempty', 'x')]))
    expect(out[0].data.length).toBe(0)
    expect(out[1].data.toString('utf8')).toBe('x')
  })

  it('rejects a buffer with bad magic', () => {
    expect(() => unpackArchive(Buffer.from('not an archive'))).toThrow(/magic/)
  })
})
