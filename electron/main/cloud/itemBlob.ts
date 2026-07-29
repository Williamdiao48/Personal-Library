import { readFileSync, readdirSync } from 'node:fs'
import { contentDir, safeContentPath, safeUserDataPath } from '../security/paths'
import { packArchive, type ArchiveEntry } from './blobArchive'
import { sha256Hex } from './blobHash'

// Resolves an item's on-disk bytes into the blobs that get backed up to R2:
//   • content — the item's file(s), packed into one archive (Decision 8). A
//     multi-chapter HTML item's sibling `<id>-chK.html` files pack together; a
//     single-file item (epub/pdf/single HTML) is a 1-entry archive.
//   • cover   — the raw cover image (single file; no archive).
// Each returns the bytes + their sha256 (the R2 object key / items.blob_hash /
// items.cover_hash).

export interface ItemBlobRow {
  id: string
  file_path: string
  cover_path: string | null
}

// A multi-chapter HTML item's file_path looks like `<id>-ch0.html`; its other
// chapters are `<id>-ch1.html`, … in the same dir.
const MULTI_CHAPTER_RE = /-ch(\d+)\.html$/

/** The content filenames (relative to `content/`) that make up an item's bytes. */
export function contentFileNames(item: ItemBlobRow): string[] {
  if (!MULTI_CHAPTER_RE.test(item.file_path)) return [item.file_path]
  const names = readdirSync(contentDir())
    .filter((n) => n.startsWith(`${item.id}-ch`) && MULTI_CHAPTER_RE.test(n))
    .sort((a, b) => chapterIndex(a) - chapterIndex(b))
  // Defensive: if enumeration finds nothing, fall back to the recorded file_path.
  return names.length ? names : [item.file_path]
}

function chapterIndex(name: string): number {
  const m = name.match(MULTI_CHAPTER_RE)
  return m ? Number(m[1]) : 0
}

/** Pack an item's content files into one archive and hash it (the R2 content key). */
export function buildContentBlob(item: ItemBlobRow): { data: Buffer; hash: string } {
  const entries: ArchiveEntry[] = contentFileNames(item).map((name) => ({
    name,
    data: readFileSync(safeContentPath(name)),
  }))
  const data = packArchive(entries)
  return { data, hash: sha256Hex(data) }
}

/** The item's cover as a raw blob (a single image; no archive), or null if none. */
export function buildCoverBlob(item: ItemBlobRow): { data: Buffer; hash: string } | null {
  if (!item.cover_path) return null
  const data = readFileSync(safeUserDataPath(item.cover_path))
  return { data, hash: sha256Hex(data) }
}
