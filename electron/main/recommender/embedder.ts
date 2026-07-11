import { app } from 'electron'
import { join } from 'path'
import {
  MODEL_ID,
  MODEL_VERSION,
  EMBED_DIM,
  MAX_BATCH,
  createExtractor,
  embedWith,
  type Embedder,
  type FeatureExtractor,
} from './embedder-core'

// C1.2 / C2.5 — the main-process Embedder singleton. The model-running code
// (createExtractor, the sub-batch loop, the constants + types) lives in the
// Electron-free `embedder-core.ts` so it can also run inside the sandboxed
// embed-worker (C2.5). This module adds the app-aware bits: model-path
// resolution, device selection, and a warm, serialized singleton for the main
// process. It re-exports the core so existing `./embedder` imports are unchanged.

export {
  MODEL_ID,
  MODEL_VERSION,
  EMBED_DIM,
  MAX_BATCH,
  createExtractor,
  embedWith,
  type Embedder,
  type FeatureExtractor,
}

// ── pure resolution helpers (unit-tested directly, no Electron/model needed) ──

/**
 * Where transformers.js should look for the vendored model. It loads
 * `<localModelPath>/<modelId>/onnx/model_quantized.onnx` for dtype 'q8'.
 * - packaged: `<resourcesPath>/models` (electron-builder extraResources)
 * - dev:      `<appPath>/resources/models` (repo working tree)
 */
export function resolveModelPaths(envInfo: {
  isPackaged: boolean
  appPath: string
  resourcesPath: string | undefined
}): { localModelPath: string; modelId: string } {
  const base = envInfo.isPackaged
    ? join(envInfo.resourcesPath ?? '', 'models')
    : join(envInfo.appPath, 'resources', 'models')
  return { localModelPath: base, modelId: MODEL_ID }
}

/**
 * Execution backend. onnxruntime-node ships no darwin-x64 (Intel Mac) prebuilt
 * binary, so fall back to the transformers.js WASM backend there; native
 * (onnxruntime-node) everywhere else.
 */
export function selectDevice(platform: string, arch: string): 'cpu' | 'wasm' {
  if (platform === 'darwin' && arch === 'x64') return 'wasm'
  return 'cpu'
}

// ── warm singleton + serialized execution ────────────────────────────────────

// Loaded once (~1.8s cold) and reused. The promise itself is the guard against
// a concurrent double-load.
let pipelinePromise: Promise<FeatureExtractor> | null = null
// Serialize embed() calls so batches never overlap on the single ORT session.
let tail: Promise<unknown> = Promise.resolve()

async function loadPipeline(): Promise<FeatureExtractor> {
  const { localModelPath } = resolveModelPaths({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  })
  const device = selectDevice(process.platform, process.arch)
  console.log(`[embedder] loading ${MODEL_ID} from ${localModelPath} (device=${device})`)
  return createExtractor(localModelPath, device)
}

function getPipeline(): Promise<FeatureExtractor> {
  if (!pipelinePromise) pipelinePromise = loadPipeline()
  return pipelinePromise
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn)
  // Keep the chain alive even if a call rejects.
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  return enqueue(async () => {
    const pipe = await getPipeline()
    return embedWith(pipe, texts)
  })
}

/** The process-wide embedder singleton. */
export const embedder: Embedder = {
  modelVersion: MODEL_VERSION,
  dim: EMBED_DIM,
  embed,
}

/** Test-only: drop the cached pipeline + queue so each test loads fresh. */
export function __resetEmbedderForTest(): void {
  pipelinePromise = null
  tail = Promise.resolve()
}
