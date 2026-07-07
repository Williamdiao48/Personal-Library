import { describe, it, expect, vi, beforeEach } from 'vitest'

// The worker-safe core, tested with transformers.js mocked so no real model /
// native binary loads (ABI-agnostic — no rebuild toggle). This is the exact code
// path the sandboxed embed-worker runs.
const { mockPipe, mockEnv, pipelineFactory } = vi.hoisted(() => ({
  mockPipe: vi.fn(),
  mockEnv: { allowRemoteModels: true, localModelPath: '' },
  pipelineFactory: vi.fn(),
}))

vi.mock('@huggingface/transformers', () => ({
  pipeline: pipelineFactory,
  env: mockEnv,
}))

import {
  embedWith,
  createExtractor,
  MODEL_ID,
  EMBED_DIM,
  MAX_BATCH,
  type FeatureExtractor,
} from './embedder-core'

function fakeOutput(texts: string[]) {
  return { tolist: () => texts.map((_, i) => new Array(EMBED_DIM).fill(0.01 * (i + 1))) }
}

beforeEach(() => {
  pipelineFactory.mockReset()
  pipelineFactory.mockImplementation(async () => mockPipe)
  mockPipe.mockReset()
  mockPipe.mockImplementation((texts: string[]) => Promise.resolve(fakeOutput(texts)))
  mockEnv.allowRemoteModels = true
  mockEnv.localModelPath = ''
})

describe('embedWith', () => {
  const pipe = ((texts: string[], opts: unknown) =>
    mockPipe(texts, opts)) as unknown as FeatureExtractor

  it('returns one Float32Array(384) per input', async () => {
    const out = await embedWith(pipe, ['a', 'b'])
    expect(out).toHaveLength(2)
    expect(out[0]).toBeInstanceOf(Float32Array)
    expect(out[0]).toHaveLength(EMBED_DIM)
  })

  it('passes texts through unchanged (no bge prefix) with mean-pool + normalize', async () => {
    await embedWith(pipe, ['hello world'])
    expect(mockPipe).toHaveBeenCalledWith(['hello world'], { pooling: 'mean', normalize: true })
  })

  it('empty input returns [] without calling the model', async () => {
    const out = await embedWith(pipe, [])
    expect(out).toEqual([])
    expect(mockPipe).not.toHaveBeenCalled()
  })

  it('sub-batches inputs larger than MAX_BATCH, preserving count and order', async () => {
    const n = MAX_BATCH * 2 + 1 // 17 → slices of 8, 8, 1
    const out = await embedWith(
      pipe,
      Array.from({ length: n }, (_, i) => `t${i}`),
    )
    expect(out).toHaveLength(n)
    expect(mockPipe).toHaveBeenCalledTimes(3)
    expect((mockPipe.mock.calls[0][0] as string[]).length).toBe(MAX_BATCH)
    expect((mockPipe.mock.calls[2][0] as string[]).length).toBe(1)
  })
})

describe('createExtractor', () => {
  it('loads offline (allowRemoteModels=false) from the given path, dtype q8', async () => {
    await createExtractor('/models', 'cpu')
    expect(mockEnv.allowRemoteModels).toBe(false)
    expect(mockEnv.localModelPath).toBe('/models')
    expect(pipelineFactory).toHaveBeenCalledWith(
      'feature-extraction',
      MODEL_ID,
      expect.objectContaining({ dtype: 'q8', device: 'cpu' }),
    )
  })

  it('honors the wasm device (Intel-Mac fallback path)', async () => {
    await createExtractor('/models', 'wasm')
    expect(pipelineFactory).toHaveBeenCalledWith(
      'feature-extraction',
      MODEL_ID,
      expect.objectContaining({ device: 'wasm' }),
    )
  })
})
