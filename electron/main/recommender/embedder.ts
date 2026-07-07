import { app } from 'electron'
import { join } from 'path'
import { pipeline, env } from '@huggingface/transformers'

// C1.2 — the Embedder: turns text into 384-dim vectors via a local int8
// bge-small-en-v1.5 ONNX model (transformers.js / onnxruntime), offline, in the
// Electron main process. This module only *runs the model*; the D8 content
// representation (chunking/pooling/blend) lives in embeddingText.ts (C1.4).
//
// The model is vendored by `npm run fetch:model` into resources/models/ and
// shipped via electron-builder extraResources (see C1.1 / chunk1 plan).

/** Local model directory name under resources/models/ (matches the fetch script). */
export const MODEL_ID = 'bge-small-en-v1.5-int8'
/** Stable tag stored alongside vectors in Chunk 2 to detect a model change. */
export const MODEL_VERSION = 'bge-small-en-v1.5-int8'
/** Output dimensionality of bge-small. */
export const EMBED_DIM = 384

export interface Embedder {
  /** Identifies the model that produced a vector (for storage staleness). */
  readonly modelVersion: string
  /** Vector dimensionality. */
  readonly dim: number
  /** Embed a batch of texts → one L2-normalized Float32Array per input. */
  embed(texts: string[]): Promise<Float32Array[]>
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

// Minimal shape of a transformers.js feature-extraction pipeline call.
type FeatureExtractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>

// Loaded once (~1.8s cold) and reused. The promise itself is the guard against
// a concurrent double-load.
let pipelinePromise: Promise<FeatureExtractor> | null = null
// Serialize embed() calls so batches never overlap on the single ORT session.
let tail: Promise<unknown> = Promise.resolve()

async function loadPipeline(): Promise<FeatureExtractor> {
  env.allowRemoteModels = false // offline: never hit the network
  const { localModelPath, modelId } = resolveModelPaths({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  })
  env.localModelPath = localModelPath
  const device = selectDevice(process.platform, process.arch)
  console.log(`[embedder] loading ${modelId} from ${localModelPath} (device=${device})`)
  const pipe = await pipeline('feature-extraction', modelId, { dtype: 'q8', device })
  return pipe as unknown as FeatureExtractor
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
    // No bge query/passage prefix — symmetric convention (library items and
    // candidates are embedded identically), pooled+normalized by the model.
    const output = await pipe(texts, { pooling: 'mean', normalize: true })
    return output.tolist().map((row) => Float32Array.from(row))
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
