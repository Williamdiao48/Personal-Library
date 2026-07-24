import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { PendingRegistry } from './pending-registry'
import type { ParseRequest, ParseResponse, EpubParseResult } from './parse-protocol'

// Main-process front door to the sandboxed parse worker (F7). Owns the child's
// lifecycle: lazy fork on first use, request/response correlation, per-request
// timeout, and crash-restart. A parser crash/OOM/hang takes down the worker;
// pending requests reject and the next call transparently respawns it.
//
// Scope: EPUB import parsing only. PDF text extraction stays in main because
// pdf.js needs DOM globals a utilityProcess does not provide.

const WORKER_SCRIPT = join(__dirname, 'parse-worker.js')
const REQUEST_TIMEOUT_MS = 120_000 // EPUB parsing of large files can be slow

let child: UtilityProcess | null = null
let ready = false
// Requests enqueued before the worker has emitted 'spawn'. Electron's
// utilityProcess does NOT buffer messages posted before the child is ready, so
// we hold them here and flush on 'spawn' (otherwise the first parse is lost).
const outbox: ParseRequest[] = []
const registry = new PendingRegistry()

function flush(): void {
  if (!child || !ready) return
  for (const msg of outbox) child.postMessage(msg)
  outbox.length = 0
}

function ensureWorker(): UtilityProcess {
  if (child) return child

  ready = false
  const c = utilityProcess.fork(WORKER_SCRIPT, [], {
    serviceName: 'parse-worker',
    // Cap worker heap: a zip bomb OOMs this child, not the machine
    // (defense-in-depth atop the F2 inflate/size caps).
    execArgv: ['--max-old-space-size=512'],
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  // Surface worker crash traces in the main terminal.
  c.stderr?.on('data', (d) => console.error('[parse-worker]', d.toString().trimEnd()))

  c.on('spawn', () => {
    ready = true
    flush()
  })
  c.on('message', (msg: ParseResponse) => registry.settle(msg))

  // Crash or clean exit: fail everything in flight and drop the ref so the next
  // request forks a fresh worker.
  //
  // `kill()` is async — a worker we intentionally recycled (request timeout or
  // quit) emits `exit` LATER, by which point a new request may already have
  // forked a replacement. Guard on identity so this stale exit can't null the
  // live worker or reject its in-flight parse (mirrors embed-host's H2 fix). A
  // current worker's real crash still runs the full cleanup below.
  c.on('exit', (code) => {
    if (child !== c) return // superseded by a newer worker — this exit is stale
    child = null
    ready = false
    registry.rejectAll(new Error(`Parse worker exited (code ${code})`))
  })

  child = c
  return c
}

export function parseEpub(filePath: string): Promise<EpubParseResult> {
  const c = ensureWorker()
  const { id, promise } = registry.create<EpubParseResult>(REQUEST_TIMEOUT_MS, () => {
    // Wedged worker — kill it so the next call respawns. The timeout fires up to
    // REQUEST_TIMEOUT_MS later, so re-check identity: if this request's worker was
    // already recycled and replaced, we must not kill the live successor.
    if (child !== c) return
    child?.kill()
    child = null
    ready = false
  })
  outbox.push({ id, kind: 'epub', filePath })
  flush()
  return promise
}

/** Tear down the worker on app quit so it doesn't linger. */
export function shutdownParseWorker(): void {
  registry.rejectAll(new Error('App is quitting'))
  child?.kill()
  child = null
  ready = false
}
