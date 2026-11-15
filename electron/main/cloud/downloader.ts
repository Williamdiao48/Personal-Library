import { existsSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { getDb } from '../db'
import { getSupabase, isConfigured } from '../auth/client'
import { safeContentPath, contentDir } from '../security/paths'
import { ZIP_TOTAL_MAX_BYTES, COVER_MAX_BYTES } from '../security/validation'
import { unpackArchive } from './blobArchive'
import { isItemContentName, itemChapterFiles } from './itemBlob'
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
//
// Freshness (CLO-14): a file existing locally isn't enough — another device may
// have since re-addressed the item (appended chapters, a new cover). Each item
// records which hash its on-disk bytes came from (`local_blob_hash` /
// `local_cover_hash`, device-local, never synced); when the synced pointer moves
// away from it, the next open re-fetches. The marker is written only where disk
// and pointer are known to agree: after a successful pull here, and in
// recordItemBlobs (this device hashed its own bytes into the pointer).

const MULTI_CHAPTER_RE = /-ch\d+\.html$/

// One pull per item at a time. The reader asks for the chapter count and the
// chapter itself back to back; both must wait on the same download, and a read
// must not race the stale-chapter cleanup of a refresh.
const inFlight = new Map<string, Promise<void>>()

function singleFlight(id: string, run: () => Promise<void>): Promise<void> {
  const running = inFlight.get(id)
  if (running) return running
  const p = run().finally(() => inFlight.delete(id))
  inFlight.set(id, p)
  return p
}

interface ContentRow {
  id: string
  blob_hash: string | null
  local_blob_hash: string | null
}

/**
 * Ensure the local content file(s) backing `relativePath` (an item's file_path)
 * exist AND are the current backed-up version, pulling + unpacking from R2 when
 * they're missing or stale.
 *
 * - Not cloud-backed (no blob_hash): returns quietly; a missing file surfaces as
 *   the caller's normal read error.
 * - Missing locally: pulls, and on failure (cloud unavailable / signed out /
 *   offline / corrupt) throws a reader-friendly message rather than falling
 *   through to a cryptic fs ENOENT.
 * - Present but stale (marker ≠ blob_hash): pulls the new version; on failure it
 *   keeps serving the local copy (an older book beats an unopenable one — e.g. the
 *   peer pushed its new pointer before its upload drained) and retries next open.
 * - Present with no marker: bytes that predate tracking or arrived outside the
 *   cloud path (cross-device dedup adoption) — adopted as current, no download.
 *
 * `requireCurrent` is for callers that WRITE on top of the local copy (appending
 * chapters): an older copy is fine to read but not to build on — the append would
 * number its chapters after the stale files and publish the gap to every device —
 * so a failed refresh throws for them instead of falling back.
 */
export async function ensureLocalContent(
  relativePath: string,
  { requireCurrent = false }: { requireCurrent?: boolean } = {},
): Promise<void> {
  // safeContentPath throws on traversal — keep it first so the guard still fires.
  const present = existsSync(safeContentPath(relativePath))

  const item = getDb()
    .prepare(
      `SELECT id, blob_hash, local_blob_hash FROM items
       WHERE file_path = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(relativePath) as ContentRow | undefined

  // Not cloud-backed (or hash unknown) → nothing to pull; let the read ENOENT.
  if (!item?.blob_hash) return
  const hash = item.blob_hash

  if (present) {
    if (item.local_blob_hash === hash) return
    if (item.local_blob_hash == null) {
      setContentMarker(item.id, hash)
      return
    }
    await singleFlight(item.id, async () => {
      try {
        await pullContent(item.id, hash, relativePath)
      } catch (err) {
        console.warn(
          `[downloader] kept the local copy of ${item.id}; couldn't fetch its newer version:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    })
    // Checked after the pull, not inside it: a writer may have joined a reader's
    // in-flight refresh, which swallows its own failure.
    if (requireCurrent && readContentMarker(item.id) !== hash) {
      throw new Error(
        "This book was updated on another device and the new version couldn't be downloaded yet. Check your connection and try again.",
      )
    }
    return
  }
  return singleFlight(item.id, () => pullContent(item.id, hash, relativePath))
}

function readContentMarker(id: string): string | null {
  const row = getDb().prepare(`SELECT local_blob_hash FROM items WHERE id = ?`).get(id) as
    { local_blob_hash: string | null } | undefined
  return row?.local_blob_hash ?? null
}

function setContentMarker(id: string, hash: string): void {
  getDb().prepare(`UPDATE items SET local_blob_hash = ? WHERE id = ?`).run(hash, id)
}

/** GET, verify, and unpack blob `hash` over item `id`'s content files, then mark
 *  them as materialized from `hash`. Throws on any failure, before any write. */
async function pullContent(id: string, hash: string, relativePath: string): Promise<void> {
  // A failure to materialize a cloud-backed item's bytes is a real, user-visible
  // error — NOT a silent return that surfaces later as a cryptic "ENOENT open
  // <file>" when the caller reads the still-missing file.
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

  const url = await presignBlobUrl('get', 'content', hash)
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
  if (sha256Hex(buf) !== hash) {
    throw new Error('Downloaded book failed its integrity check.')
  }

  // Bind every entry name to THIS item before any write (SEC-1): the integrity
  // check proves the bytes match the requested hash, but NOT that a rogue device
  // (same account, shared R2 prefix) didn't name its entries after another item to
  // overwrite its files. Validate all names first — fail closed, no partial writes.
  // safeContentPath stays as defence-in-depth on the write itself.
  const entries = unpackArchive(buf, MAX_CONTENT_BLOB_BYTES)
  for (const entry of entries) {
    if (!isItemContentName({ id, file_path: relativePath }, entry.name)) {
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

  // A refresh can SHRINK a serial (a re-scrape with fewer chapters). Chapter files
  // the new archive doesn't contain are leftovers from the old version; the reader
  // counts contiguous `-chK` files, so they'd resurface as phantom chapters.
  if (MULTI_CHAPTER_RE.test(relativePath)) {
    const keep = new Set(entries.map((e) => e.name))
    for (const name of itemChapterFiles(id)) {
      if (!keep.has(name)) unlinkSync(safeContentPath(name))
    }
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

  // Last, so a crash mid-write leaves the marker stale and the next open retries.
  setContentMarker(id, hash)
}

/**
 * Ensure the local cover image backing `coverRelative` (a `library://` request
 * path — an item's `cover_path`, e.g. `content/<id>-cover.jpg`) exists and is
 * the current backed-up cover, pulling it from R2 if this device received the
 * item's metadata but not its bytes, or holds an older cover (CLO-14).
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
  const item = getDb()
    .prepare(
      `SELECT cover_hash, local_cover_hash FROM items
       WHERE cover_path = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(coverRelative) as
    { cover_hash: string | null; local_cover_hash: string | null } | undefined
  // No backed-up cover → nothing to pull; serve whatever is local (or 404 to the
  // placeholder).
  if (!item?.cover_hash) return
  const hash = item.cover_hash

  // Same freshness rule as content (CLO-14). A failed refresh below simply returns,
  // leaving the existing (older) cover in place.
  if (existsSync(localPath)) {
    if (item.local_cover_hash === hash) return
    if (item.local_cover_hash == null) {
      setCoverMarker(coverRelative, hash)
      return
    }
  }

  const supabase = isConfigured() ? getSupabase() : null
  if (!supabase) return
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return

  let buf: Buffer
  try {
    const url = await presignBlobUrl('get', 'cover', hash)
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
  if (sha256Hex(buf) !== hash) return

  // The content dir may not exist on a metadata-only device (same reason as the
  // content pull above); create it before writing.
  mkdirSync(dirname(localPath), { recursive: true })
  writeFileSync(localPath, buf)
  setCoverMarker(coverRelative, hash)
}

// Keyed by path + hash, not id: every live item showing this cover file now has
// these bytes on disk.
function setCoverMarker(coverRelative: string, hash: string): void {
  getDb()
    .prepare(`UPDATE items SET local_cover_hash = ? WHERE cover_path = ? AND cover_hash = ?`)
    .run(hash, coverRelative, hash)
}
