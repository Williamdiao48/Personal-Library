import { captureUrl } from '../capture'
import { beginCaptureWork, endCaptureWork } from './activity'
import { triggerBackfill } from '../recommender/lifecycle'
import { enqueueItemBackup } from '../cloud/uploader'
import { notifyLocalMutation } from '../cloud/sync/syncService'
import { discoverAo3Bookmarks } from './sites/ao3-bookmarks'
import { discoverFfnetFavorites } from './sites/ffnet-favorites'
import { canonicalWorkId, canonicalKey, buildOwnedIndex } from './dedup'
import type { CanonicalId } from './dedup'
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
// Dedup (canonical id + cross-source content key) lives in ./dedup, shared with the
// single-URL capture path so the two can't drift apart. Dedup is load-bearing and NOT
// automatic: captureUrl INSERTs the raw source_url, and the only renderer-side URL
// check (AddItemModal) is bypassed by the bulk path — so this module flags every
// discovered work against the library itself before the preview.

// Re-exported so bulkImport's own tests (and any importer that predates ./dedup) can
// still reach the canonical primitives from here.
export { canonicalWorkId }
export type { CanonicalId }

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

  // (3) Flag works already owned — by canonical id (same site, URL variants) OR by
  // normalized title|author (the same fic cross-posted to the other site). Same index
  // + match the single-URL capture path uses, so the two can't disagree.
  const owned = buildOwnedIndex()
  let alreadyInLibrary = 0
  const works = deduped.map((w) => {
    const isOwned = owned.match(w.url, w.title, w.author) !== null
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
// than hammering a throttling site, and cooperative cancellation. A work that
// fails is moved to the BACK of the queue and retried later (up to MAX_ATTEMPTS),
// so a transient hiccup (a 503, a slow CF challenge) doesn't permanently drop a
// story — it only counts as failed after exhausting its attempts. Re-running after
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

// How many times a single work is attempted before it's counted as permanently
// failed. A failed work goes to the back of the queue, so retries are naturally
// spaced out behind the rest of the batch. Kept below CIRCUIT_BREAKER_THRESHOLD so
// a lone broken URL (deleted work, unparseable page) gives up cleanly instead of
// tripping the breaker.
const MAX_ATTEMPTS = 3

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
  // Count the whole batch as in-flight for the L3 backup:import guard — spanning the
  // polite delays between works too, not just each per-work captureUrl bracket, so an
  // import can't slip in mid-batch and get overwritten by the next work.
  beginCaptureWork()

  // Dedup baseline: everything already in the library, indexed once. Works captured
  // during this run are add()-ed so a duplicate later in the same list (or a re-run)
  // skips. The queue holds URLs (no titles), so matches here are effectively canonical
  // (site+id) — the content-key (cross-source) axis lives at discovery time, where the
  // preview already excludes an owned cross-post from the URLs it sends us.
  const owned = buildOwnedIndex()

  // A mutable FIFO queue of work URLs + their attempt count. A failed work is
  // pushed to the back (retried after everything else), so `queue` shrinks only as
  // works succeed, permanently fail, or are skipped.
  const queue: { url: string; attempts: number }[] = urls.map((url) => ({ url, attempts: 0 }))

  const progress: BulkImportProgress = {
    batchId,
    total: urls.length,
    done: 0,
    failed: 0,
    skipped: 0,
    retrying: 0,
    status: 'running',
  }
  // `retrying` is derived from the queue each emit — the works still waiting that
  // have already failed at least once.
  const emit = (): void =>
    onProgress?.({ ...progress, retrying: queue.filter((q) => q.attempts > 0).length })

  let consecutiveFailures = 0

  try {
    while (queue.length > 0) {
      if (state.cancelled) {
        progress.status = 'cancelled'
        break
      }

      const item = queue.shift()!
      const url = item.url
      const c = canonicalWorkId(url)

      // Skip works already owned (library or earlier in this run) — idempotent.
      if (owned.match(url, null, null)) {
        progress.skipped++
        emit()
        continue
      }

      progress.current = url
      emit()

      let failedThisWork = false
      try {
        const result = await captureUrl(url, () => {}, undefined, cloudBackup)
        consecutiveFailures = 0
        // Now owned → a later duplicate / re-run skips. Index title/author too so a
        // same-run cross-post (different URL) also collapses.
        owned.add(url, result.title, result.author, { id: result.id, title: result.title })
        // captureUrl's own dedup gate can collapse this work onto an existing item
        // (a cross-source content match the URL-only preview couldn't see) — count
        // that as skipped, not imported, and fire no new-item hooks for it.
        if (result.duplicate) {
          progress.skipped++
        } else {
          progress.done++
          // Same post-capture hooks the single-capture IPC path fires. Best-effort:
          // a hook failure must never fail the batch.
          triggerBackfill()
          if (cloudBackup) void enqueueItemBackup(result.id).catch(() => {})
          notifyLocalMutation()
        }
      } catch {
        failedThisWork = true
        item.attempts++
        consecutiveFailures++
        if (item.attempts < MAX_ATTEMPTS) {
          queue.push(item) // transient — retry after the rest of the queue
        } else {
          progress.failed++ // exhausted attempts — permanent failure
        }
      }

      progress.current = undefined

      // Circuit breaker: a run of consecutive failures means the site is likely
      // throttling us — stop rather than churn the whole queue against a wall.
      if (failedThisWork && consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        progress.status = 'throttled'
        emit()
        break
      }

      emit()

      // Polite gap before the next work (not after the last, and not if cancelled).
      if (queue.length > 0 && !state.cancelled) {
        await politeDelay(workDelayMs(c), state)
      }
    }

    if (progress.status === 'running') progress.status = 'done'
  } finally {
    activeBatches.delete(batchId)
    endCaptureWork()
  }

  progress.current = undefined
  emit()
  return progress
}
