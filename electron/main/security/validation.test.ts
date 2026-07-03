import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type AdmZip from 'adm-zip'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  hasMagic,
  assertPdfBuffer,
  assertEpubBuffer,
  assertEntryInflateOk,
  assertImportFile,
  PDF_MAGIC,
  EPUB_MAGIC,
  ZIP_ENTRY_MAX_BYTES,
} from './validation'

const MiB = 1_048_576

// Minimal structural stand-in for an adm-zip entry — assertEntryInflateOk only
// reads header.size / header.compressedSize / entryName.
function fakeEntry(size: number, compressedSize: number): AdmZip.IZipEntry {
  return { entryName: 'test-entry', header: { size, compressedSize } } as unknown as AdmZip.IZipEntry
}

describe('hasMagic', () => {
  it('is true when the buffer starts with the magic bytes', () => {
    expect(hasMagic(Buffer.concat([PDF_MAGIC, Buffer.from('rest')]), PDF_MAGIC)).toBe(true)
  })
  it('is false when the prefix differs', () => {
    expect(hasMagic(Buffer.from('NOTPDF'), PDF_MAGIC)).toBe(false)
  })
})

describe('assertPdfBuffer / assertEpubBuffer', () => {
  it('accept valid magic', () => {
    expect(() => assertPdfBuffer(Buffer.concat([PDF_MAGIC, Buffer.from('x')]))).not.toThrow()
    expect(() => assertEpubBuffer(Buffer.concat([EPUB_MAGIC, Buffer.from('x')]))).not.toThrow()
  })
  it('reject wrong magic', () => {
    expect(() => assertPdfBuffer(Buffer.from('%NOPE'))).toThrow(/not a valid PDF/)
    expect(() => assertEpubBuffer(Buffer.from('nope'))).toThrow(/not a valid EPUB/)
  })
})

describe('assertEntryInflateOk', () => {
  it('accepts a small, sanely-compressed entry', () => {
    expect(() => assertEntryInflateOk(fakeEntry(1 * MiB, 512 * 1024))).not.toThrow()
  })
  it('accepts a stored (uncompressed) entry with ratio ~1', () => {
    expect(() => assertEntryInflateOk(fakeEntry(1000, 1000))).not.toThrow()
  })
  it('rejects an entry whose decompressed size exceeds the per-entry cap', () => {
    expect(() => assertEntryInflateOk(fakeEntry(ZIP_ENTRY_MAX_BYTES + 1, ZIP_ENTRY_MAX_BYTES + 1)))
      .toThrow(/too large when decompressed/)
  })
  it('rejects a high compression-ratio bomb below the size cap', () => {
    expect(() => assertEntryInflateOk(fakeEntry(10 * MiB, 1))).toThrow(/compression ratio too high/)
  })
})

describe('assertImportFile', () => {
  let dir: string
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'pl-validation-')) })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  it('accepts a file with the correct magic', async () => {
    const f = join(dir, 'ok.pdf')
    writeFileSync(f, Buffer.concat([PDF_MAGIC, Buffer.from('%\n1 0 obj')]))
    await expect(assertImportFile(f, 'pdf')).resolves.toBeUndefined()
  })
  it('rejects a file with wrong magic (masquerading)', async () => {
    const f = join(dir, 'fake.epub')
    writeFileSync(f, Buffer.from('<html>not a zip</html>'))
    await expect(assertImportFile(f, 'epub')).rejects.toThrow(/not a valid EPUB/)
  })
})
