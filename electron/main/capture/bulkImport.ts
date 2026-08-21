import { all } from '../db'
import { captureUrl } from '../capture'
import { triggerBackfill } from '../recommender/lifecycle'
import { enqueueItemBackup } from '../cloud/uploader'
import { notifyLocalMutation } from '../cloud/sync/syncService'
import { discoverAo3Bookmarks } from './sites/ao3-bookmarks'
import { discoverFfnetFavorites } from './sites/ffnet-favorites'
import type {
  BulkSource,
  DiscoveredWork,
  FavoritesDiscovery,
  BulkImportProgress,
} from '../../../src/types'

// ── Bulk favorites import — discovery dispatch, validation, dedup (Phase 2) ────
// Turns a validated account reference into a de-duplicated, library-annotated
// preview (FavoritesDiscovery) the UI shows before committing to N downloads. The
// serialized import queue (runBulkImport) follows in the Phase 3 section below.
//
// Dedup is load-bearing and NOT automatic: captureUrl blindly INSERTs the raw
// source_url with no dedup, and the only existing URL check is renderer-side in
// AddItemModal (which the bulk path bypasses). So this module dedups every work
// itself — by CANONICAL id, not exact source_url, since /works/123,
// /works/123?view_full_work=true and /works/123/chapters/456 are the same work.

/** A work identified by its site + canonical numeric id — the dedup key. */
export interface CanonicalId {
  kind: BulkSource
  id: string
}

/**
 * Reduce any AO3 work URL or FFN story URL to its canonical {kind,id}, ignoring
 * query strings, chapter/slug tails, and www/scheme variants. Returns null for
 * anything that isn't a recognizable work/story URL.
 */
export function canonicalWorkId(url: string): CanonicalId | null {
  const ao3 = /\/works\/(\d+)/.exec(url)
  if (ao3 && /archiveofourown\.org/i.test(url)) return { kind: 'ao3', id: ao3[1] }
  const ffn = /\/s\/(\d+)/.exec(url)
  if (ffn && /fanfiction\.net/i.test(url)) return { kind: 'ffn', id: ffn[1] }
  return null
}

/** Stable string key for a canonical id (Set/Map membership). */
function canonicalKey(c: CanonicalId): string {
  return `${c.kind}:${c.id}`
}

/**
 * Build the set of canonical ids already in the library, so a discovered work can
 * be flagged `alreadyInLibrary` in O(1). One pass over owned source_urls (a
 * personal library is small) — correct where a `source_url LIKE '%/works/{id}%'`
 * query would false-match (`/works/12` vs `/works/123`) and cheaper than N queries.
 */
export function ownedCanonicalIds(): Set<string> {
  const rows = all<{ source_url: string | null }>(
    "SELECT source_url FROM items WHERE source_url IS NOT NULL AND source_url <> ''",
  )
  const set = new Set<string>()
  for (const { source_url } of rows) {
    if (!source_url) continue
    const c = canonicalWorkId(source_url)
    if (c) set.add(canonicalKey(c))
  }
  return set
}

/**
 * Normalize + validate an account reference for a source. Accepts either a bare
 * value or a pasted profile URL, and enforces a strict character class so the
 * validated ref can be interpolated into a fixed URL template with no path
 * injection. Throws a user-facing error on anything that doesn't match.
 *
 * - AO3 → a username (URL slug): letters, digits, underscores. From `/users/{name}`.
 * - FFN → a numeric user id. From `/u/{id}`.
 */
export function normalizeAccountRef(source: BulkSource, rawRef: string): string {
  const ref = (rawRef ?? '').trim()
  if (!ref) throw new Error('Enter an account reference.')

  if (source === 'ao3') {
    // A pasted profile URL like https://archiveofourown.org/users/Name/bookmarks
    const fromUrl = /\/users\/([A-Za-z0-9_]+)/.exec(ref)?.[1]
    const username = fromUrl ?? ref
    if (!/^[A-Za-z0-9_]+$/.test(username)) {
      throw new Error('Enter a valid AO3 username (letters, numbers, underscores).')
    }
    return username
  }

  // FFN: a pasted profile URL like https://www.fanfiction.net/u/12345/Name
  const fromUrl = /\/u\/(\d+)/.exec(ref)?.[1]
  const id = fromUrl ?? ref
  if (!/^\d+$/.test(id)) {
    throw new Error('Enter a valid FanFiction.net user id (the number in /u/…).')
  }
  return id
}

/** Progress callback for the discovery phase (AO3 multi-page walk). */
export type DiscoverProgress = (page: number, totalPages: number, found: number) => void

/**
 * Discover an account's favorites/bookmarks, then annotate + de-duplicate:
 *   1. validate the ref and dispatch to the right site discoverer;
 *   2. drop within-batch duplicates by canonical id (same story listed twice);
 *   3. flag each remaining work `alreadyInLibrary` against the owned-id set.
 * Returns the preview object the modal renders. Never captures anything.
 */
export async function discoverFavorites(
  source: BulkSource,
  rawRef: string,
  onProgress?: DiscoverProgress,
): Promise<FavoritesDiscovery> {
  const ref = normalizeAccountRef(source, rawRef)

  let rawWorks: DiscoveredWork[]
  let skippedSeries = 0
  let skippedExternal = 0
  if (source === 'ao3') {
    const res = await discoverAo3Bookmarks(ref, onProgress)
    rawWorks = res.works
    skippedSeries = res.skippedSeries
    skippedExternal = res.skippedExternal
  } else {
    rawWorks = await discoverFfnetFavorites(ref)
    onProgress?.(1, 1, rawWorks.length)
  }

  // (2) Within-batch dedup by canonical id — the same story appearing twice in one
  // list must not double-import. A work with no parseable canonical id is kept
  // (deduped by url instead) rather than silently dropped.
  const seen = new Set<string>()
  const deduped: DiscoveredWork[] = []
  for (const w of rawWorks) {
    const c = canonicalWorkId(w.url)
    const key = c ? canonicalKey(c) : `url:${w.url}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(w)
  }

  // (3) Flag works already owned (canonical-id match against the library).
  const owned = ownedCanonicalIds()
  let alreadyInLibrary = 0
  const works = deduped.map((w) => {
    const c = canonicalWorkId(w.url)
    const isOwned = c ? owned.has(canonicalKey(c)) : false
    if (isOwned) alreadyInLibrary++
    return { ...w, alreadyInLibrary: isOwned }
  })

  return {
    source,
    ref,
    works,
    total: works.length,
    alreadyInLibrary,
    skippedSeries,
    skippedExternal,
  }
}

// ── Serialized import queue (Phase 3) ─────────────────────────────────────────
// Runs the discovered URLs through captureUrl one at a time, politely: a jittered
// delay between works (longer for FFN, which rides the slow CF BrowserWindow
// path), a circuit breaker that halts after a run of consecutive failures rather
// than hammering a throttling site, and cooperative cancellation. Re-running after
// a cancel/crash is idempotent — already-imported works skip via the same
// canonical-id dedup used at discovery time.

// Base inter-work delay by site + shared jitter. Justified by the spike's repeated
// 503s: serialized + delayed is not optional. FFN is slower because each capture
// spins the real-browser CF solver. Tunable.
const AO3_WORK_DELAY_MS = 2500
const FFN_WORK_DELAY_MS = 5000
const BULK_JITTER_MS = 1500

// Stop the batch after this many *consecutive* capture failures — a strong signal
// the site is rate-limiting/blocking us. No auto-resume; the user re-runs (dedup
// makes that a safe resume).
const CIRCUIT_BREAKER_THRESHOLD = 5

// How finely a between-works delay is sliced so cancellation is responsive mid-wait
// instead of blocking for the full (up to ~6.5s) gap.
const DELAY_SLICE_MS = 250

interface BatchState {
  cancelled: boolean
}
// Live batches, so capture:cancelBulk can flip a run's cancelled flag by id.
const activeBatches = new Map<string, BatchState>()

/** Request cancellation of a running batch (no-op if unknown/finished). */
export function cancelBulkImport(batchId: string): void {
  const state = activeBatches.get(batchId)
  if (state) state.cancelled = true
}

/** Base delay for the next work, by site, plus jitter. */
function workDelayMs(c: CanonicalId | null): number {
  const base = c?.kind === 'ffn' ? FFN_WORK_DELAY_MS : AO3_WORK_DELAY_MS
  return base + Math.floor(Math.random() * BULK_JITTER_MS)
}

/** Sleep `ms`, but wake early (in ≤ DELAY_SLICE_MS) once the batch is cancelled. */
async function politeDelay(ms: number, state: BatchState): Promise<void> {
  let elapsed = 0
  while (elapsed < ms && !state.cancelled) {
    const slice = Math.min(DELAY_SLICE_MS, ms - elapsed)
    await new Promise<void>((r) => setTimeout(r, slice))
    elapsed += slice
  }
}

export interface RunBulkImportOptions {
  batchId: string
  urls: string[] // already host-validated by the IPC boundary
  cloudBackup: boolean
  onProgress?: (progress: BulkImportProgress) => void
}

/**
 * Import a list of work URLs serially. Emits a BulkImportProgress after every work
 * (and once at the end), returns the terminal snapshot. Never throws for a
 * per-work failure — those are counted; only an unexpected fault (e.g. the owned-id
 * query) would propagate, which the IPC layer maps to a status:'error' complete.
 */
export async function runBulkImport(opts: RunBulkImportOptions): Promise<BulkImportProgress> {
  const { batchId, urls, cloudBackup, onProgress } = opts
  const state: BatchState = { cancelled: false }
  activeBatches.set(batchId, state)

  // Dedup baseline: everything already in the library. Works captured during this
  // run are added so a duplicate later in the same list (or a re-run) skips.
  const owned = ownedCanonicalIds()

  const progress: BulkImportProgress = {
    batchId,
    total: urls.length,
    done: 0,
    failed: 0,
    skipped: 0,
    status: 'running',
  }
  const emit = (): void => onProgress?.({ ...progress })

  let consecutiveFailures = 0

  try {
    for (let i = 0; i < urls.length; i++) {
      if (state.cancelled) {
        progress.status = 'cancelled'
        break
      }

      const url = urls[i]
      const c = canonicalWorkId(url)
      const key = c ? canonicalKey(c) : `url:${url}`

      // Skip works already owned (library or earlier in this run) — idempotent.
      if (owned.has(key)) {
        progress.skipped++
        emit()
        continue
      }

      progress.current = url
      emit()

      try {
        const result = await captureUrl(url, () => {}, undefined, cloudBackup)
        progress.done++
        consecutiveFailures = 0
        owned.add(key) // now owned → a later duplicate / re-run skips
        // Same post-capture hooks the single-capture IPC path fires. Best-effort:
        // a hook failure must never fail the batch.
        triggerBackfill()
        if (cloudBackup) void enqueueItemBackup(result.id).catch(() => {})
        notifyLocalMutation()
      } catch {
        progress.failed++
        consecutiveFailures++
        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          progress.status = 'throttled'
          progress.current = undefined
          emit()
          break
        }
      }

      progress.current = undefined
      emit()

      // Polite gap before the next work (not after the last, and not if cancelled).
      if (i < urls.length - 1 && !state.cancelled) {
        await politeDelay(workDelayMs(c), state)
      }
    }

    if (progress.status === 'running') progress.status = 'done'
  } finally {
    activeBatches.delete(batchId)
  }

  progress.current = undefined
  emit()
  return progress
}
