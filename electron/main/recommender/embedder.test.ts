import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock transformers.js so no real model / native binary loads — the suite stays
// ABI-agnostic (runs under plain-Node Vitest with no rebuild toggle). Defined via
// vi.hoisted so the (hoisted) vi.mock factory can reference them; the mock env
// object captures the offline/localModelPath writes the embedder makes.
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
  embedder,
  resolveModelPaths,
  selectDevice,
  MODEL_ID,
  EMBED_DIM,
  MAX_BATCH,
  __resetEmbedderForTest,
} from './embedder'

// A fake pipeline output: one 384-length row per input text.
function fakeOutput(texts: string[]) {
  return { tolist: () => texts.map((_, i) => new Array(EMBED_DIM).fill(0.01 * (i + 1))) }
}

beforeEach(() => {
  __resetEmbedderForTest()
  pipelineFactory.mockReset()
  pipelineFactory.mockImplementation(async () => mockPipe)
  mockPipe.mockReset()
  mockPipe.mockImplementation((texts: string[]) => Promise.resolve(fakeOutput(texts)))
  mockEnv.allowRemoteModels = true
  mockEnv.localModelPath = ''
})

describe('resolveModelPaths (pure)', () => {
  it('dev → <appPath>/resources/models', () => {
    expect(
      resolveModelPaths({ isPackaged: false, appPath: '/repo', resourcesPath: '/ignored' }),
    ).toEqual({ localModelPath: '/repo/resources/models', modelId: MODEL_ID })
  })

  it('packaged → <resourcesPath>/models', () => {
    expect(
      resolveModelPaths({ isPackaged: true, appPath: '/app.asar', resourcesPath: '/Res' }),
    ).toEqual({ localModelPath: '/Res/models', modelId: MODEL_ID })
  })
})

describe('selectDevice (pure)', () => {
  it('Intel Mac (darwin/x64) → wasm fallback (no native ORT binary)', () => {
    expect(selectDevice('darwin', 'x64')).toBe('wasm')
  })

  it('Apple Silicon / Windows / Linux → native cpu', () => {
    expect(selectDevice('darwin', 'arm64')).toBe('cpu')
    expect(selectDevice('win32', 'x64')).toBe('cpu')
    expect(selectDevice('linux', 'arm64')).toBe('cpu')
  })
})

describe('embedder.embed', () => {
  it('returns one Float32Array(384) per input', async () => {
    const out = await embedder.embed(['a', 'b'])
    expect(out).toHaveLength(2)
    expect(out[0]).toBeInstanceOf(Float32Array)
    expect(out[0]).toHaveLength(EMBED_DIM)
    expect(out[1]).toHaveLength(EMBED_DIM)
  })

  it('passes texts through unchanged (no bge prefix) with mean-pool + normalize', async () => {
    await embedder.embed(['hello world'])
    expect(mockPipe).toHaveBeenCalledWith(['hello world'], { pooling: 'mean', normalize: true })
  })

  it('loads the pipeline once across multiple calls (warm singleton)', async () => {
    await embedder.embed(['a'])
    await embedder.embed(['b'])
    await embedder.embed(['c'])
    expect(pipelineFactory).toHaveBeenCalledTimes(1)
  })

  it('loads offline (allowRemoteModels=false) with the resolved local path', async () => {
    await embedder.embed(['a'])
    expect(mockEnv.allowRemoteModels).toBe(false)
    expect(mockEnv.localModelPath).toMatch(/resources\/models$/)
    // dtype q8 requested at load
    expect(pipelineFactory).toHaveBeenCalledWith(
      'feature-extraction',
      MODEL_ID,
      expect.objectContaining({ dtype: 'q8' }),
    )
  })

  it('short-circuits empty input without loading the model', async () => {
    const out = await embedder.embed([])
    expect(out).toEqual([])
    expect(pipelineFactory).not.toHaveBeenCalled()
  })

  it('serializes overlapping calls (no batch overlap on the ORT session)', async () => {
    // Fire two without awaiting; both must resolve correctly and reuse one load.
    const [a, b] = await Promise.all([embedder.embed(['x']), embedder.embed(['y', 'z'])])
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(2)
    expect(pipelineFactory).toHaveBeenCalledTimes(1)
  })

  it('exposes modelVersion + dim metadata', () => {
    expect(embedder.dim).toBe(EMBED_DIM)
    expect(embedder.modelVersion).toBe(MODEL_ID)
  })

  it('sub-batches inputs larger than MAX_BATCH (bounds peak memory), preserving count', async () => {
    const n = MAX_BATCH * 2 + 1 // 17 → slices of 8, 8, 1
    const out = await embedder.embed(Array.from({ length: n }, (_, i) => `t${i}`))
    expect(out).toHaveLength(n)
    expect(mockPipe).toHaveBeenCalledTimes(3)
    expect((mockPipe.mock.calls[0][0] as string[]).length).toBe(MAX_BATCH)
    expect((mockPipe.mock.calls[2][0] as string[]).length).toBe(1)
  })
})
