import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { PendingRegistry } from './pending-registry'
import { createIdleTimer } from './idle-timer'
import type { EmbedRequest, EmbedResponse } from './embed-protocol'
import {
  MODEL_VERSION,
  EMBED_DIM,
  resolveModelPaths,
  selectDevice,
  type Embedder,
} from '../recommender/embedder'
import { embedItemVector, type EmbedItemInput } from '../recommender/embeddingText'
import type { EmbedHost } from '../recommender/embedHost'

// C2.5 — main-process front door to the sandboxed embed worker (D-C2-2). Owns
// the child's lifecycle: lazy fork on first use, request/response correlation
// (shared PendingRegistry), per-request timeout, and crash-restart. An OOM/hang
// takes down the worker; pending requests reject and the next call respawns it.
//
// Split of responsibility: MAIN builds the D8 representation (extract text,
// chunk, sample, pool, blend — in embedItemVector) and owns the DB; the WORKER
// only runs the raw model on the batch of strings. So the ~800 MB model memory
// lives in the disposable child while main stays responsive.

const WORKER_SCRIPT = join(__dirname, 'embed-worker.js')
// Cold model load (~2 s) + a large item's sampled-chunk batch, sub-batched
// serially; generous so a slow first embed doesn't spuriously time out.
const REQUEST_TIMEOUT_MS = 180_000
// Release the worker (and its ~800 MB model) after this long with no requests.
// Reload is ~2 s, so 5 idle minutes cleanly implies the user has stopped; the
// next embed lazily re-forks the child (backfill tolerates respawn).
const IDLE_TIMEOUT_MS = 5 * 60_000

let child: UtilityProcess | null = null
let ready = false
// Requests enqueued before the worker has emitted 'spawn'. Electron's
// utilityProcess does NOT buffer messages posted before the child is ready, so
// we hold them here and flush on 'spawn' (otherwise the first embed is lost).
const outbox: EmbedRequest[] = []
const registry = new PendingRegistry()

// Idle countdown: armed after a request settles with nothing else in flight,
// cancelled the moment a request starts (or the worker is already gone). On
// expiry with the host still idle it kills the child so the model's memory is
// freed; `registry.size === 0` means there's nothing pending to reject.
const idle = createIdleTimer(
  IDLE_TIMEOUT_MS,
  () => registry.size === 0,
  () => {
    child?.kill()
    child = null
    ready = false
  },
)

function flush(): void {
  if (!child || !ready) return
  for (const msg of outbox) child.postMessage(msg)
  outbox.length = 0
}

function ensureWorker(): UtilityProcess {
  if (child) return child

  // Main has `app`; the child does not (C2.0 spike), so resolve the model path
  // + device here and hand them to the worker via argv.
  const { localModelPath } = resolveModelPaths({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  })
  const device = selectDevice(process.platform, process.arch)

  ready = false
  const c = utilityProcess.fork(WORKER_SCRIPT, [localModelPath, device], {
    serviceName: 'embed-worker',
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  // Surface worker crash traces in the main terminal.
  c.stderr?.on('data', (d) => console.error('[embed-worker]', d.toString().trimEnd()))

  c.on('spawn', () => {
    ready = true
    flush()
  })
  c.on('message', (msg: EmbedResponse) => registry.settle(msg))

  // Crash or clean exit: fail everything in flight and drop the ref so the next
  // request forks a fresh worker.
  //
  // `kill()` is async — a worker we intentionally recycled (idle/timeout/quit)
  // emits `exit` LATER, by which point a new request may already have forked a
  // replacement. Guard on identity so this stale exit can't null the live worker
  // or reject its in-flight requests (the bug that orphaned an ~800 MB child and
  // blanked a Discover refresh). If `c` is no longer current we do nothing: any
  // requests still owned by `c` fall back to their own per-request timeout.
  c.on('exit', (code) => {
    if (child !== c) return // superseded by a newer worker — this exit is stale
    child = null
    ready = false
    idle.cancel() // no worker left to time out
    registry.rejectAll(new Error(`Embed worker exited (code ${code})`))
  })

  child = c
  return c
}

/** Send a batch of texts to the worker and reconstitute Float32Array vectors. */
function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return Promise.resolve([])
  idle.cancel() // a request is starting — hold off the idle shutdown
  const c = ensureWorker()
  const { id, promise } = registry.create<number[][]>(REQUEST_TIMEOUT_MS, () => {
    // Wedged worker — kill it so the next call respawns. The timeout fires up to
    // REQUEST_TIMEOUT_MS later, so re-check identity: if this request's worker was
    // already recycled and replaced, we must not kill the live successor.
    if (child !== c) return
    child?.kill()
    child = null
    ready = false
  })
  outbox.push({ id, texts })
  flush()
  // Re-arm the idle countdown once this settles and nothing else is in flight.
  // This is a separate subscription from the caller-facing chain below, so it must
  // swallow rejections itself — otherwise a request that rejects (worker crash or
  // timeout) surfaces as an unhandled rejection here even though the caller handles
  // its own copy of the error.
  void promise
    .catch(() => {})
    .finally(() => {
      if (registry.size === 0) idle.schedule()
    })
  return promise.then((rows) => rows.map((r) => Float32Array.from(r)))
}

// A worker-backed Embedder: same interface as the in-process one (embedItemVector
// doesn't care where the raw batch embed runs), but the inference is off-thread.
// Exported so the recommend path (candidate embedding) can run off the UI thread
// too, not just backfill — same singleton worker, requests serialize via the registry.
export const workerEmbedder: Embedder = {
  modelVersion: MODEL_VERSION,
  dim: EMBED_DIM,
  embed: embedTexts,
}

/**
 * The worker-backed EmbedHost the backfill runner consumes. `embed` builds the
 * D8 vector in main (text extraction + pool + blend) and delegates only the raw
 * model inference to the child.
 */
export const workerEmbedHost: EmbedHost = {
  modelVersion: MODEL_VERSION,
  embed: (item: EmbedItemInput, tags: string[]) => embedItemVector(item, tags, workerEmbedder),
}

/** Tear down the worker on app quit so it doesn't linger. */
export function shutdownEmbedWorker(): void {
  idle.cancel()
  registry.rejectAll(new Error('App is quitting'))
  child?.kill()
  child = null
  ready = false
}
