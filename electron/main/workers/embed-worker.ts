// Sandboxed embed worker (Electron utilityProcess child) — D-C2-2.
//
// The onnxruntime model load + inference (~800 MB RSS at peak, ~1.5–2.7 s/item)
// run HERE instead of the main process, so a backfill never janks the UI and the
// model's memory lives in a disposable child that main can kill. Main resolves
// the model path (it has `app`; this child does not — C2.0 spike) and passes it
// via argv; the child only turns texts into vectors.
//
// IMPORTANT: this module must never import `electron`, the database, or the
// network/BrowserWindow layer. It imports ONLY the Electron-free embedder-core.

import { createExtractor, embedWith, type FeatureExtractor } from '../recommender/embedder-core'
import type { EmbedRequest, EmbedResponse } from './embed-protocol'

// Log async failures instead of letting them silently exit the process.
process.on('uncaughtException', (err) => console.error('[embed-worker] uncaughtException:', err))
process.on('unhandledRejection', (err) => console.error('[embed-worker] unhandledRejection:', err))

// argv: [execPath, workerScript, localModelPath, device] (fork args start at 2).
const localModelPath = process.argv[2] ?? ''
const device = (process.argv[3] as 'cpu' | 'wasm') || 'cpu'

// Load the model once, lazily on the first request, and reuse it. The promise
// itself guards against a concurrent double-load.
let extractorPromise: Promise<FeatureExtractor> | null = null
function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) extractorPromise = createExtractor(localModelPath, device)
  return extractorPromise
}

async function handle(req: EmbedRequest): Promise<EmbedResponse> {
  try {
    const pipe = await getExtractor()
    const vectors = await embedWith(pipe, req.texts)
    return { id: req.id, ok: true, result: vectors.map((v) => Array.from(v)) }
  } catch (err) {
    return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const parentPort = process.parentPort
if (!parentPort) {
  // Not running as a utilityProcess child — nothing to do.
  throw new Error('embed-worker must be launched via utilityProcess.fork')
}

parentPort.on('message', (e: { data: EmbedRequest }) => {
  void handle(e.data).then((res) => parentPort.postMessage(res))
})
