import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import AdmZip from 'adm-zip'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { safeExtractAll } from './zip'

const MiB = 1_048_576

// A lightweight IZipEntry-shaped stub. safeExtractAll only reads entryName,
// isDirectory, header.size/compressedSize, and getData() — so we can drive the
// directory-creation and aggregate-size-cap branches without materializing the
// hundreds of MB of real payload those paths would otherwise require.
function fakeEntry(
  entryName: string,
  opts: { isDirectory?: boolean; size?: number; compressed?: number; data?: Buffer } = {},
): AdmZip.IZipEntry {
  const size = opts.size ?? 0
  return {
    entryName,
    isDirectory: opts.isDirectory ?? false,
    header: { size, compressedSize: opts.compressed ?? size },
    getData: () => opts.data ?? Buffer.alloc(0),
  } as unknown as AdmZip.IZipEntry
}
function fakeZip(entries: AdmZip.IZipEntry[]): AdmZip {
  return { getEntries: () => entries } as unknown as AdmZip
}

describe('safeExtractAll', () => {
  let dest: string
  beforeEach(() => {
    dest = mkdtempSync(join(tmpdir(), 'pl-zip-'))
  })
  afterEach(() => {
    rmSync(dest, { recursive: true, force: true })
  })

  it('extracts a well-formed backup archive shape', () => {
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from('{}'))
    zip.addFile('library.db', Buffer.from('SQLite'))
    zip.addFile('content/a.html', Buffer.from('<p>hi</p>'))

    safeExtractAll(zip, dest)

    expect(readFileSync(join(dest, 'library.db'), 'utf8')).toBe('SQLite')
    expect(readFileSync(join(dest, 'content', 'a.html'), 'utf8')).toBe('<p>hi</p>')
  })

  it('rejects a Zip Slip entry and writes nothing outside the dest', () => {
    const zip = new AdmZip()
    zip.addFile('placeholder.txt', Buffer.from('pwned'))
    // adm-zip's addFile normalizes away `../`, so inject the traversal name
    // directly onto the entry to simulate a hand-crafted malicious archive.
    zip.getEntries()[0].entryName = '../evil.txt'

    expect(() => safeExtractAll(zip, dest)).toThrow(/Invalid content path/)
    expect(existsSync(resolve(dest, '..', 'evil.txt'))).toBe(false)
  })

  it('rejects an absolute entry name', () => {
    const zip = new AdmZip()
    zip.addFile('placeholder.txt', Buffer.from('x'))
    zip.getEntries()[0].entryName = '/etc/evil.txt'
    expect(() => safeExtractAll(zip, dest)).toThrow(/Unsafe zip entry name/)
  })

  it('rejects a decompression-bomb entry (over the per-entry inflate cap)', () => {
    const zip = new AdmZip()
    // 26 MB of zeros: declared uncompressed size exceeds the 25 MB per-entry cap.
    zip.addFile('content/bomb.bin', Buffer.alloc(26 * MiB))
    expect(() => safeExtractAll(zip, dest)).toThrow(/too large when decompressed|ratio too high/)
    expect(existsSync(join(dest, 'content', 'bomb.bin'))).toBe(false)
  })

  it('creates a directory for an explicit directory entry', () => {
    safeExtractAll(fakeZip([fakeEntry('subdir/', { isDirectory: true })]), dest)
    expect(existsSync(join(dest, 'subdir'))).toBe(true)
    expect(statSync(join(dest, 'subdir')).isDirectory()).toBe(true)
  })

  it('aborts once the aggregate decompressed size exceeds the archive total cap', () => {
    // Each entry is 24 MB (under the 25 MB per-entry cap) with a 1:1 ratio (under
    // the 100:1 bomb guard), so only the 250 MB *aggregate* cap can trip. Eleven
    // such entries (264 MB) cross it — the 11th throws before it is written.
    const chunk = 24 * MiB
    const entries = Array.from({ length: 11 }, (_, i) =>
      fakeEntry(`content/part${i}.bin`, { size: chunk, compressed: chunk }),
    )
    expect(() => safeExtractAll(fakeZip(entries), dest)).toThrow(/maximum total decompressed size/i)
    // The final entry (the one that crossed the cap) was never written.
    expect(existsSync(join(dest, 'content', 'part10.bin'))).toBe(false)
  })
})
