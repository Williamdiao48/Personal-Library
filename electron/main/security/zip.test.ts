import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import AdmZip from 'adm-zip'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { safeExtractAll } from './zip'

const MiB = 1_048_576

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
})
