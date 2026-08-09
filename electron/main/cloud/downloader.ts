import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getDb } from '../db'
import { getSupabase, isConfigured } from '../auth/client'
import { safeContentPath, contentDir } from '../security/paths'
import { ZIP_TOTAL_MAX_BYTES, COVER_MAX_BYTES } from '../security/validation'
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
 * cloud-backed (no blob_hash) it returns quietly and the caller's read surfaces
 * the normal missing-file error. When the item IS cloud-backed but we can't pull
 * (cloud unavailable / signed out / offline / corrupt), it throws a
 * reader-friendly message rather than falling through to a cryptic fs ENOENT.
 */
export async function ensureLocalContent(relativePath: string): Promise<void> {
  // safeContentPath throws on traversal — keep it first so the guard still fires.
  if (existsSync(safeContentPath(relativePath))) return

  const item = getDb()
    .prepare(`SELECT id, blob_hash FROM items WHERE file_path = ? AND deleted_at IS NULL LIMIT 1`)
    .get(relativePath) as { id: string; blob_hash: string | null } | undefined

  // Not cloud-backed (or hash unknown) → nothing to pull; let the read ENOENT.
  if (!item?.blob_hash) return

  // From here the item IS cloud-backed, so a failure to materialize its bytes is a
  // real, user-visible error — NOT a silent return that surfaces later as a cryptic
  // "ENOENT open <file>" when the caller reads the still-missing file.
  const supabase = isConfigured() ? getSupabase() : null
  if (!supabase) {
    throw new Error(
      'This book is stored in your cloud backup, but cloud is not available on this device.',
    )
  }
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
  // The content dir may not exist on a device that received this item purely via
  // metadata sync — it never captured/imported locally, so nothing ever created
  // <userData>/content. Create it before writing; otherwise writeFileSync throws a
  // parent-missing ENOENT that is indistinguishable from the reader's own
  // missing-file error (the bug this whole path exists to prevent).
  mkdirSync(contentDir(), { recursive: true })
  for (const entry of entries) {
    writeFileSync(safeContentPath(entry.name), entry.data)
  }

  // Post-condition: the archive must have actually restored the file the caller is
  // about to open. An empty or mismatched backup archive would otherwise leave the
  // target missing and the reader would die on a cryptic fs ENOENT with no clue why.
  if (!existsSync(safeContentPath(relativePath))) {
    const names = entries.map((e) => e.name).join(', ') || '(none)'
    throw new Error(
      `Cloud backup for this book did not contain its file (${relativePath}). Archive entries: ${names}.`,
    )
  }
}

/**
 * Ensure the local cover image backing `coverRelative` (a `library://` request
 * path — an item's `cover_path`, e.g. `content/<id>-cover.jpg`) exists, pulling
 * it from R2 if this device received the item's metadata but not its bytes.
 *
 * Unlike {@link ensureLocalContent} this NEVER throws. A cover is non-critical
 * chrome, so every failure path (not cloud-backed, cloud unavailable, signed
 * out, offline, oversized, corrupt) degrades quietly to the renderer's cover
 * placeholder rather than surfacing an error in the protocol handler. The cover
 * is a single raw image (no archive), keyed in R2 by its sha256 = cover_hash.
 */
export async function ensureLocalCover(coverRelative: string): Promise<void> {
  let localPath: string
  try {
    // cover_path carries the `content/` prefix; strip it to resolve inside content/.
    localPath = safeContentPath(coverRelative.replace(/^content\//, ''))
  } catch {
    return // traversal — the protocol handler's own guard 403s the request
  }
  if (existsSync(localPath)) return

  const item = getDb()
    .prepare(`SELECT cover_hash FROM items WHERE cover_path = ? AND deleted_at IS NULL LIMIT 1`)
    .get(coverRelative) as { cover_hash: string | null } | undefined
  // No backed-up cover → nothing to pull; let the fetch 404 to the placeholder.
  if (!item?.cover_hash) return

  const supabase = isConfigured() ? getSupabase() : null
  if (!supabase) return
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return

  let buf: Buffer
  try {
    const url = await presignBlobUrl('get', 'cover', item.cover_hash)
    const res = await fetch(url)
    if (!res.ok) return
    // Bound the download the same way the cover PUT was capped server-side.
    const declared = Number(res.headers?.get?.('content-length') ?? '')
    if (Number.isFinite(declared) && declared > COVER_MAX_BYTES) return
    buf = Buffer.from(await res.arrayBuffer())
  } catch {
    return // offline / presign failure — non-critical, fall back to placeholder
  }
  if (buf.length > COVER_MAX_BYTES) return
  // Integrity: the bytes must match the content address we asked for.
  if (sha256Hex(buf) !== item.cover_hash) return

  // The content dir may not exist on a metadata-only device (same reason as the
  // content pull above); create it before writing.
  mkdirSync(dirname(localPath), { recursive: true })
  writeFileSync(localPath, buf)
}
