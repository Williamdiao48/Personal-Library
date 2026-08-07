import { existsSync, writeFileSync } from 'node:fs'
import { getDb } from '../db'
import { getSupabase, isConfigured } from '../auth/client'
import { safeContentPath } from '../security/paths'
import { ZIP_TOTAL_MAX_BYTES } from '../security/validation'
import { unpackArchive } from './blobArchive'
import { isItemContentName } from './itemBlob'
import { sha256Hex } from './blobHash'
import { presignBlobUrl } from './presign'

// A content blob is an archive of one item's raw files. Bound its size the same
// way the local import path bounds a decompressed archive, so a tampered/oversized
// blob planted in the shared user prefix can't exhaust memory on open (SEC-2/3).
const MAX_CONTENT_BLOB_BYTES = ZIP_TOTAL_MAX_BYTES

// Pull-on-open (Phase 2 Decision 3): a device that has an item's metadata row
// (via Phase 3 sync) but not its bytes fetches them lazily when the reader opens
// the book. One content blob per item (an archive), so a single GET + unpack
// restores every file — for a multi-chapter fic that's all its `<id>-chK.html`
// files at once. Archive entry names are id-based, so they land back in the
// content dir with no dependence on any device-local path.

/**
 * Ensure the local content file(s) backing `relativePath` (an item's file_path)
 * exist, pulling + unpacking from R2 if this device doesn't have them yet.
 *
 * No-op fast path when the file is already local. When the item isn't
 * cloud-backed (no blob_hash) or the build has no cloud, it returns quietly and
 * the caller's read surfaces the normal missing-file error. When the item IS
 * cloud-backed but we can't pull (signed out / offline / corrupt), it throws a
 * reader-friendly message.
 */
export async function ensureLocalContent(relativePath: string): Promise<void> {
  // safeContentPath throws on traversal — keep it first so the guard still fires.
  if (existsSync(safeContentPath(relativePath))) return

  const item = getDb()
    .prepare(`SELECT id, blob_hash FROM items WHERE file_path = ? AND deleted_at IS NULL LIMIT 1`)
    .get(relativePath) as { id: string; blob_hash: string | null } | undefined

  // Not cloud-backed (or hash unknown) → nothing to pull; let the read ENOENT.
  if (!item?.blob_hash) return
  if (!isConfigured()) return
  const supabase = getSupabase()
  if (!supabase) return
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('Sign in to download this book from your cloud backup.')

  const url = await presignBlobUrl('get', 'content', item.blob_hash)
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    throw new Error("Couldn't download this book — check your connection.")
  }
  if (!res.ok) throw new Error(`Couldn't download this book (R2 ${res.status}).`)

  // Bound the download (SEC-2). R2 always reports Content-Length and the presigned
  // PUT that created the object was itself size-capped server-side, so the header
  // check is the effective guard; the post-read length check backstops a
  // missing/lying header.
  const declared = Number(res.headers?.get?.('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_CONTENT_BLOB_BYTES) {
    throw new Error('This book is too large to download safely.')
  }

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_CONTENT_BLOB_BYTES) {
    throw new Error('This book is too large to download safely.')
  }
  // Integrity: the bytes must match the content address we asked for.
  if (sha256Hex(buf) !== item.blob_hash) {
    throw new Error('Downloaded book failed its integrity check.')
  }

  // Bind every entry name to THIS item before any write (SEC-1): the integrity
  // check proves the bytes match the requested hash, but NOT that a rogue device
  // (same account, shared R2 prefix) didn't name its entries after another item to
  // overwrite its files. Validate all names first — fail closed, no partial writes.
  // safeContentPath stays as defence-in-depth on the write itself.
  const entries = unpackArchive(buf, MAX_CONTENT_BLOB_BYTES)
  for (const entry of entries) {
    if (!isItemContentName({ id: item.id, file_path: relativePath }, entry.name)) {
      throw new Error('Downloaded book contained an unexpected file and was rejected.')
    }
  }
  for (const entry of entries) {
    writeFileSync(safeContentPath(entry.name), entry.data)
  }
}
