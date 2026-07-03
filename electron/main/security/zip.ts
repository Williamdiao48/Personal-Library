import type AdmZip from 'adm-zip'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { resolveWithin } from './paths'
import { assertEntryInflateOk, ZIP_TOTAL_MAX_BYTES } from './validation'

// ── Safe zip extraction (security.md F5) ────────────────────────────────────
//
// Replaces adm-zip's `extractAllTo`, which trusts entry names and has a
// recurring Zip-Slip history (an entry named `../../../foo` escapes the target
// dir). Combined with F1 (attacker-controlled DB paths), a malicious backup is
// the single most dangerous input to this app.
//
// Every entry is routed through `resolveWithin` (the same F1 traversal guard
// used everywhere else), so a traversal throws and ABORTS the whole extraction.
// Callers must invoke this before any irreversible step (in backup import, that
// means before `closeDb()` + the DB swap) so the original state stays intact.

/**
 * Extract every entry of an already-opened archive into `destDir`, defending
 * against Zip Slip (path traversal) and decompression bombs.
 *
 * - Rejects absolute names and backslash separators outright (cross-platform).
 * - `resolveWithin(destDir, name)` throws on any `..` escape → aborts.
 * - Enforces the per-entry inflate cap and an aggregate total before writing.
 * - Writes plain files only; adm-zip does not create symlinks on extract.
 */
export function safeExtractAll(zip: AdmZip, destDir: string): void {
  let totalInflated = 0

  for (const entry of zip.getEntries()) {
    const name = entry.entryName

    // Reject absolute paths, Windows drive letters, and backslash separators
    // before path resolution. On POSIX a backslash is a legal filename char, so
    // `resolveWithin` would treat `..\..\evil` as one contained segment rather
    // than a traversal — reject it explicitly so behavior is the same on Windows.
    if (name.startsWith('/') || name.includes('\\') || /^[a-zA-Z]:/.test(name)) {
      throw new Error(`Unsafe zip entry name: ${name}`)
    }

    // Throws on traversal outside destDir.
    const target = resolveWithin(destDir, name)

    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true })
      continue
    }

    assertEntryInflateOk(entry)
    totalInflated += entry.header.size
    if (totalInflated > ZIP_TOTAL_MAX_BYTES) {
      throw new Error('Backup archive exceeds maximum total decompressed size.')
    }

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.getData())
  }
}
