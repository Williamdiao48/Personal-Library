import type AdmZip from 'adm-zip'
import { stat, open } from 'fs/promises'

// ── Untrusted-file validation (security.md F2 / F3) ─────────────────────────
//
// Single source of truth for the checks that bound an untrusted import (EPUB,
// PDF, or the entries of a backup zip) BEFORE it reaches a parser. Two concerns:
//
//   1. Whole-file gate  — magic bytes + size cap, applied at *import* time as
//      well as read time (previously only reader.ts guarded the read path).
//   2. Per-entry inflate — cap the DECLARED uncompressed size of each zip entry
//      before decompressing it, to defeat zip/decompression bombs (F2), reused
//      by the backup safe-extractor (F5, security/zip.ts).
//
// The magic/size constants live here (not reader.ts) so the read path and the
// import path share one definition.

const MiB = 1_048_576

// Whole-file magic bytes.
// PDF must begin with %PDF- (0x25 0x50 0x44 0x46 0x2D).
export const PDF_MAGIC  = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d])
// EPUB is a ZIP archive and must begin with PK\x03\x04.
export const EPUB_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

// Whole-file size caps (checked via stat before any buffer is allocated).
export const PDF_MAX_BYTES  = 200 * MiB
export const EPUB_MAX_BYTES = 150 * MiB

// Per-entry / aggregate inflate caps for zip decompression (F2 + F5).
export const ZIP_ENTRY_MAX_BYTES = 25  * MiB  // max decompressed size of one entry
export const ZIP_TOTAL_MAX_BYTES = 250 * MiB  // max total decompressed per archive
export const ZIP_MAX_RATIO       = 100        // max size:compressedSize (bomb guard)

export type ImportKind = 'pdf' | 'epub'

const MAGIC:     Record<ImportKind, Buffer> = { pdf: PDF_MAGIC,     epub: EPUB_MAGIC }
const MAX_BYTES: Record<ImportKind, number> = { pdf: PDF_MAX_BYTES, epub: EPUB_MAX_BYTES }

function magicError(kind: ImportKind): Error {
  return new Error(
    kind === 'pdf'
      ? 'File is not a valid PDF (missing %PDF- header).'
      : 'File is not a valid EPUB (missing ZIP header).'
  )
}

/** Pure — does `buf` begin with `magic`? */
export function hasMagic(buf: Buffer, magic: Buffer): boolean {
  return magic.equals(buf.subarray(0, magic.length))
}

/** Throw unless `buf` starts with the PDF magic bytes. */
export function assertPdfBuffer(buf: Buffer): void {
  if (!hasMagic(buf, PDF_MAGIC)) throw magicError('pdf')
}

/** Throw unless `buf` starts with the EPUB (ZIP) magic bytes. */
export function assertEpubBuffer(buf: Buffer): void {
  if (!hasMagic(buf, EPUB_MAGIC)) throw magicError('epub')
}

/**
 * Import-time gate for an untrusted file on disk: stat for size (before reading
 * anything), then read only the header bytes and check magic. Runs BEFORE any
 * parse or copy of the file.
 */
export async function assertImportFile(path: string, kind: ImportKind): Promise<void> {
  const max = MAX_BYTES[kind]
  const { size } = await stat(path)
  if (size > max) {
    throw new Error(
      `File too large (${(size / MiB).toFixed(0)} MB). Maximum allowed size is ${max / MiB} MB.`
    )
  }

  const magic = MAGIC[kind]
  const head  = Buffer.alloc(magic.length)
  const fh    = await open(path, 'r')
  try {
    await fh.read(head, 0, magic.length, 0)
  } finally {
    await fh.close()
  }
  if (!hasMagic(head, magic)) throw magicError(kind)
}

/**
 * Guard a single zip entry's DECLARED uncompressed size before decompressing.
 * Reads adm-zip's central-directory header (`header.size` / `header.compressedSize`),
 * which is available without decompressing the payload, so a bomb is rejected
 * before it is materialized in memory.
 */
export function assertEntryInflateOk(entry: AdmZip.IZipEntry): void {
  const size       = entry.header.size
  const compressed = entry.header.compressedSize
  if (size > ZIP_ENTRY_MAX_BYTES) {
    throw new Error(
      `Zip entry too large when decompressed (${(size / MiB).toFixed(0)} MB): ${entry.entryName}`
    )
  }
  // Ratio bomb: a tiny compressed payload that inflates enormously.
  if (compressed > 0 && size / compressed > ZIP_MAX_RATIO) {
    throw new Error(
      `Zip entry compression ratio too high (${Math.round(size / compressed)}:1): ${entry.entryName}`
    )
  }
}

/**
 * Look up an entry by name, enforce the inflate cap, then decompress to a UTF-8
 * string. Returns `null` if the entry does not exist (callers treat that as
 * "missing", matching adm-zip's prior behavior); throws if the entry is a bomb.
 */
export function readEntryTextCapped(zip: AdmZip, name: string): string | null {
  const entry = zip.getEntry(name)
  if (!entry) return null
  assertEntryInflateOk(entry)
  return entry.getData().toString('utf8')
}
