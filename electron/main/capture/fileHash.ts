import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { safeContentPath } from '../security/paths'

// ── Import de-duplication identity ──────────────────────────────────────────
//
// A stable sha256 of an imported file's RAW bytes (the epub/pdf exactly as the
// user picked it), stored in items.file_hash. Re-importing the identical file
// produces the identical hash, so captureEpub/capturePdf can short-circuit a
// duplicate BEFORE any parse / copy / cloud upload (see capture/index.ts).
//
// This is deliberately the raw file, not the parsed text or the packed R2 blob:
// hashing the input (not the output) means the dedup check happens upstream of
// the expensive work, and byte-identical files collapse with zero false positives
// (two byte-different epubs of the same book stay separate — that fuzzier "same
// book" merge is a future, riskier concern, not this).

/** sha256 (hex) of a file's raw bytes — the items.file_hash dedup key. */
export function computeFileHash(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * One-time backfill: fill items.file_hash for pre-existing epub/pdf items that
 * predate the column (migration 39). Without this, the FIRST re-import of an
 * already-imported book wouldn't dedup — the existing row has a NULL hash to
 * match against. Idempotent (only touches NULLs), so it's safe to run every boot
 * until the library is fully hashed; a book whose file went missing is skipped
 * (stays NULL) rather than aborting the pass. Returns how many rows it filled.
 *
 * Local-only work: file_hash is not synced, so this never marks rows dirty.
 */
export function backfillFileHashes(database: Database.Database): number {
  const rows = database
    .prepare(
      `SELECT id, file_path FROM items
       WHERE content_type IN ('epub', 'pdf') AND file_hash IS NULL AND file_path IS NOT NULL`,
    )
    .all() as { id: string; file_path: string }[]

  const update = database.prepare('UPDATE items SET file_hash = ? WHERE id = ?')
  let filled = 0
  for (const row of rows) {
    try {
      const buf = readFileSync(safeContentPath(row.file_path))
      update.run(computeFileHash(buf), row.id)
      filled++
    } catch {
      // File missing / unreadable / traversal-rejected — leave file_hash NULL and
      // move on. It'll be retried on the next boot, or filled if re-imported.
    }
  }
  return filled
}
