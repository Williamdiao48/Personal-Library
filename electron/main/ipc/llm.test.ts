import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke, resetIpc, fakeEvent } from '../../../test/stubs/electron'

// The LLM IPC seam's only real dependency is the Ollama client. Mock it so the
// config-sync, probe, and pull handlers can be driven without a running Ollama —
// we assert the defaulting/trimming logic and the progress-forwarding wiring.
vi.mock('../recommender/llm/ollamaClient', () => ({
  OLLAMA: { baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2:3b', timeoutMs: 20_000 },
  probeOllama: vi.fn(() => Promise.resolve({ reachable: true, hasModel: true })),
  pullModel: vi.fn(() => Promise.resolve({ ok: true })),
}))

import {
  registerLlmHandlers,
  getLlmConfig,
  ollamaConfigFrom,
} from './llm'
import { probeOllama, pullModel } from '../recommender/llm/ollamaClient'

const mockProbe = vi.mocked(probeOllama)
const mockPull = vi.mocked(pullModel)

beforeEach(() => {
  resetIpc()
  vi.clearAllMocks()
  registerLlmHandlers()
})

describe('ollamaConfigFrom', () => {
  it('folds the shared timeout into a model/baseUrl pair', () => {
    expect(ollamaConfigFrom({ model: 'm', baseUrl: 'http://h' })).toEqual({
      model: 'm',
      baseUrl: 'http://h',
      timeoutMs: 20_000,
    })
  })
})

describe('llm:setConfig', () => {
  it('stores a fully-specified config', async () => {
    await invoke('llm:setConfig', {
      enabled: true,
      model: 'mistral',
      baseUrl: 'http://box:11434',
    })
    expect(getLlmConfig()).toEqual({
      enabled: true,
      model: 'mistral',
      baseUrl: 'http://box:11434',
    })
  })

  it('coerces enabled to a boolean and falls back to defaults for blank/missing fields', async () => {
    await invoke('llm:setConfig', { enabled: 1 as unknown, model: '   ', baseUrl: undefined })
    expect(getLlmConfig()).toEqual({
      enabled: true, // !!1
      model: 'llama3.2:3b', // blank → default
      baseUrl: 'http://127.0.0.1:11434', // missing → default
    })
  })

  it('treats a falsy enabled as disabled', async () => {
    await invoke('llm:setConfig', { enabled: false, model: 'x', baseUrl: 'http://y' })
    expect(getLlmConfig().enabled).toBe(false)
  })
})

describe('llm:probe', () => {
  it('probes with the form values (trimmed) rather than the saved config', async () => {
    const result = await invoke('llm:probe', { model: '  gemma  ', baseUrl: '  http://z  ' })
    expect(result).toEqual({ reachable: true, hasModel: true })
    expect(mockProbe).toHaveBeenCalledWith({
      model: 'gemma',
      baseUrl: 'http://z',
      timeoutMs: 20_000,
    })
  })

  it('falls back to defaults when the form values are blank or the payload is absent', async () => {
    await invoke('llm:probe', { model: '', baseUrl: '' })
    expect(mockProbe).toHaveBeenCalledWith({
      model: 'llama3.2:3b',
      baseUrl: 'http://127.0.0.1:11434',
      timeoutMs: 20_000,
    })

    mockProbe.mockClear()
    await invoke('llm:probe', undefined) // cfg?.model?.trim() guards a missing payload
    expect(mockProbe).toHaveBeenCalledWith({
      model: 'llama3.2:3b',
      baseUrl: 'http://127.0.0.1:11434',
      timeoutMs: 20_000,
    })
  })
})

describe('llm:pullModel', () => {
  it('drives pullModel with the form config and forwards each progress line to the renderer', async () => {
    const sendSpy = vi.spyOn(fakeEvent.sender, 'send')
    // Have the mock emit a couple of progress lines through the forwarded callback.
    mockPull.mockImplementation((_cfg, onProgress?: (p: unknown) => void) => {
      onProgress?.({ status: 'downloading', percent: 10 })
      onProgress?.({ status: 'downloading', percent: 100 })
      return Promise.resolve({ ok: true })
    })

    const result = await invoke('llm:pullModel', { model: 'phi3', baseUrl: 'http://a' })

    expect(result).toEqual({ ok: true })
    expect(mockPull).toHaveBeenCalledWith(
      { model: 'phi3', baseUrl: 'http://a', timeoutMs: 20_000 },
      expect.any(Function),
    )
    expect(sendSpy).toHaveBeenCalledWith('llm:pullProgress', { status: 'downloading', percent: 10 })
    expect(sendSpy).toHaveBeenCalledWith('llm:pullProgress', {
      status: 'downloading',
      percent: 100,
    })
  })

  it('defaults blank pull config fields', async () => {
    await invoke('llm:pullModel', { model: '  ', baseUrl: '  ' })
    expect(mockPull).toHaveBeenCalledWith(
      { model: 'llama3.2:3b', baseUrl: 'http://127.0.0.1:11434', timeoutMs: 20_000 },
      expect.any(Function),
    )
  })
})
