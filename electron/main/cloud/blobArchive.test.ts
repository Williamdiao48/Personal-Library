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

  // SEC-3: the header is attacker-influenced once blobs sync between devices, so
  // every field is shape/bounds-validated instead of trusted.
  describe('rejects malformed / hostile headers', () => {
    const raw = (header: unknown, body: Buffer = Buffer.alloc(0)): Buffer =>
      Buffer.concat([Buffer.from('PLAR1\n'), Buffer.from(JSON.stringify(header) + '\n'), body])

    it('throws on a header that is not valid JSON', () => {
      const buf = Buffer.concat([Buffer.from('PLAR1\n'), Buffer.from('{not json\n')])
      expect(() => unpackArchive(buf)).toThrow(/valid JSON/)
    })

    it('throws when files is not an array', () => {
      expect(() => unpackArchive(raw({ files: 'nope' }))).toThrow(/files must be an array/)
    })

    it('throws on a non-string entry name', () => {
      expect(() => unpackArchive(raw({ files: [{ name: 42, len: 0 }] }))).toThrow(/name/)
    })

    it('throws on a non-integer / negative entry len', () => {
      expect(() => unpackArchive(raw({ files: [{ name: 'a', len: -1 }] }))).toThrow(/len/)
      expect(() => unpackArchive(raw({ files: [{ name: 'a', len: 1.5 }] }))).toThrow(/len/)
    })

    it('throws when an entry len runs past the buffer (no silent truncation)', () => {
      // Header claims 100 bytes but only 2 follow — old code silently clamped.
      const buf = raw({ files: [{ name: 'a', len: 100 }] }, Buffer.from('hi'))
      expect(() => unpackArchive(buf)).toThrow(/past the buffer/)
    })

    it('throws when the entry count exceeds the cap', () => {
      const files = Array.from({ length: 10_001 }, (_, i) => ({ name: `f${i}`, len: 0 }))
      expect(() => unpackArchive(raw({ files }))).toThrow(/too many entries/)
    })

    it('throws when the summed entry size exceeds maxTotalBytes', () => {
      const buf = packArchive([entry('a', 'AAAA'), entry('b', 'BBBB')]) // 8 bytes total
      expect(() => unpackArchive(buf, 5)).toThrow(/total size/)
      // Well under the cap → still round-trips.
      expect(unpackArchive(buf, 100)).toHaveLength(2)
    })
  })
})
