import { pipeline, env } from '@huggingface/transformers'

// C2.5 — the worker-safe embedding core. Everything here is needed to *run the
// model* and NOTHING here imports `electron` (or the DB, or the network layer),
// so it can be bundled into the sandboxed embed-worker (a utilityProcess child
// where `require('electron').app` is `undefined` — C2.0 spike). The app-aware
// pieces (path resolution, device selection, the warm main-process singleton)
// stay in `embedder.ts`, which re-exports this module so existing imports are
// unchanged.

/** Local model directory name under resources/models/ (matches the fetch script). */
export const MODEL_ID = 'bge-small-en-v1.5-int8'
/** Stable tag stored alongside vectors to detect a model change (Chunk 2). */
export const MODEL_VERSION = 'bge-small-en-v1.5-int8'
/** Output dimensionality of bge-small. */
export const EMBED_DIM = 384
/**
 * Max texts per onnxruntime inference. Peak memory is O(batch · seq²) (attention),
 * so an unbounded batch of ~512-token chunks spikes RSS by ~700 MB and, across a
 * backfill, aborts the native allocator (SIGTRAP). Sub-batching caps the peak;
 * results are concatenated so the public contract (one vector per input) holds.
 */
export const MAX_BATCH = 8

export interface Embedder {
  /** Identifies the model that produced a vector (for storage staleness). */
  readonly modelVersion: string
  /** Vector dimensionality. */
  readonly dim: number
  /** Embed a batch of texts → one L2-normalized Float32Array per input. */
  embed(texts: string[]): Promise<Float32Array[]>
}

/** Minimal shape of a transformers.js feature-extraction pipeline call. */
export type FeatureExtractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>

/**
 * Build a feature-extraction pipeline for a vendored model directory, using the
 * exact dtype the app ships (int8 'q8'). Offline-only. The worker calls this with
 * a model path passed in from main (it has no `app` to resolve one itself); a
 * real-model test exercises this same construction path.
 */
export async function createExtractor(
  localModelPath: string,
  device: 'cpu' | 'wasm' = 'cpu',
): Promise<FeatureExtractor> {
  env.allowRemoteModels = false // offline: never hit the network
  env.localModelPath = localModelPath
  const pipe = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8', device })
  return pipe as unknown as FeatureExtractor
}

/**
 * Run a batch of texts through an already-built extractor, sub-batched to bound
 * peak native memory (see MAX_BATCH). No bge query/passage prefix — symmetric
 * convention (library items and candidates are embedded identically), pooled +
 * normalized by the model. Pure over the extractor: no singleton, no queue — so
 * both the main-process singleton and the worker use the exact same loop.
 */
export async function embedWith(pipe: FeatureExtractor, texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  const out: Float32Array[] = []
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const output = await pipe(texts.slice(i, i + MAX_BATCH), { pooling: 'mean', normalize: true })
    for (const row of output.tolist()) out.push(Float32Array.from(row))
  }
  return out
}
