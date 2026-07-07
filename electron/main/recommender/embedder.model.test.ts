import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'

// Opt-in real-model semantic smoke. Every OTHER recommender test mocks
// transformers.js, so nothing verifies that the VENDORED int8 model + our
// dtype/pooling/normalize config actually produce sane embeddings — a wrong
// dtype, a bad fetch:model download, or a transformers.js pooling-default change
// would pass every mocked test while silently breaking recommendations. This is
// the permanent replacement for the throwaway C1.5 nearest-neighbor harness.
//
// Run:   npm run fetch:model            (once, to vendor the ~32 MB model)
//        RUN_MODEL_TESTS=1 npm test     (or: RUN_MODEL_TESTS=1 npx vitest run <this file>)
//
// Skipped by default (fast/hermetic unit runs) and in CI (model not vendored).
// onnxruntime-node is N-API — loads under plain-Node Vitest with no ABI toggle.
const MODEL_DIR = join(process.cwd(), 'resources', 'models')
const modelPresent = existsSync(
  join(MODEL_DIR, 'bge-small-en-v1.5-int8', 'onnx', 'model_quantized.onnx'),
)
const enabled = process.env.RUN_MODEL_TESTS === '1' && modelPresent

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0
  for (let i = 0; i < a.length; i++) d += a[i] * b[i]
  return d
}

describe.runIf(enabled)('embedder — real vendored model semantics', () => {
  type Extractor = (
    texts: string[],
    opts: { pooling: 'mean'; normalize: boolean },
  ) => Promise<{ tolist(): number[][] }>
  let extract: Extractor

  beforeAll(async () => {
    // Dynamic import so the real transformers.js / native binary never loads on
    // the default (skipped) path.
    const { createExtractor } = await import('./embedder')
    extract = (await createExtractor(MODEL_DIR)) as unknown as Extractor
  }, 30000)

  it('produces 384-dim, L2-normalized vectors (matches EMBED_DIM + normalize:true)', async () => {
    const out = await extract(['a slow-burn fantasy romance'], { pooling: 'mean', normalize: true })
    const v = Float32Array.from(out.tolist()[0])
    expect(v).toHaveLength(384)
    let n = 0
    for (const x of v) n += x * x
    expect(Math.sqrt(n)).toBeCloseTo(1, 4)
  })

  it('ranks same-genre closer than cross-genre (the model is actually loaded, not a stub)', async () => {
    const out = await extract(
      [
        'A slow-burn enemies-to-lovers fantasy romance with court intrigue.',
        'Two rivals in a magical royal court fall reluctantly in love.',
        'Hard science fiction about interstellar travel and orbital mechanics.',
      ],
      { pooling: 'mean', normalize: true },
    )
    const [romance, romance2, scifi] = out.tolist().map((r) => Float32Array.from(r))
    expect(cosine(romance, romance2)).toBeGreaterThan(cosine(romance, scifi))
  })
})
