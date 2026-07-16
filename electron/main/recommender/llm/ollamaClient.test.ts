import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { okJson, notOk } from '../../../../test/stubs/httpResponse'
import { ollamaClient, probeOllama, pullModel, OLLAMA, type PullProgress } from './ollamaClient'

/** A fetch Response whose body streams the given NDJSON lines (Ollama /api/pull shape). */
function streamingOk(lines: string[]) {
  const enc = new TextEncoder()
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const l of lines) controller.enqueue(enc.encode(l))
        controller.close()
      },
    }),
  }
}

// The client is fail-soft: every failure resolves to null / { reachable:false } so
// the reranker degrades to cosine ordering. Stubs the global fetch (no ABI).

describe('ollamaClient.chatJson', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('parses the assistant JSON content', async () => {
    fetchMock.mockResolvedValue(
      okJson({ message: { content: '{"rankings":[{"id":"b0","fit":0.5}]}' } }),
    )
    const out = await ollamaClient().chatJson([{ role: 'user', content: 'hi' }])
    expect(out).toEqual({ rankings: [{ id: 'b0', fit: 0.5 }] })
  })

  it('requests constrained JSON, no streaming, at the /api/chat endpoint', async () => {
    fetchMock.mockResolvedValue(okJson({ message: { content: '{}' } }))
    await ollamaClient({ ...OLLAMA, baseUrl: 'http://host:1/' }).chatJson([])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://host:1/api/chat') // trailing slash trimmed
    const body = JSON.parse((init as { body: string }).body)
    expect(body).toMatchObject({ model: OLLAMA.model, format: 'json', stream: false })
  })

  it('returns null on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(notOk(500))
    expect(await ollamaClient().chatJson([])).toBeNull()
  })

  it('returns null when the fetch throws (Ollama not running / timeout)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await ollamaClient().chatJson([])).toBeNull()
  })

  it('returns null when content is missing or non-string', async () => {
    fetchMock.mockResolvedValue(okJson({ message: { content: 42 } }))
    expect(await ollamaClient().chatJson([])).toBeNull()
  })

  it('returns null when content is not valid JSON', async () => {
    fetchMock.mockResolvedValue(okJson({ message: { content: 'not json' } }))
    expect(await ollamaClient().chatJson([])).toBeNull()
  })
})

describe('probeOllama', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reports reachable + hasModel when the exact model is installed', async () => {
    fetchMock.mockResolvedValue(okJson({ models: [{ name: 'llama3.1:8b' }] }))
    expect(await probeOllama({ ...OLLAMA, model: 'llama3.1:8b' })).toEqual({
      reachable: true,
      hasModel: true,
    })
  })

  it('matches the model by base name ignoring the :tag suffix', async () => {
    fetchMock.mockResolvedValue(okJson({ models: [{ name: 'llama3.1:latest' }] }))
    expect(await probeOllama({ ...OLLAMA, model: 'llama3.1:8b' })).toEqual({
      reachable: true,
      hasModel: true,
    })
  })

  it('reports reachable but hasModel:false when the model is absent', async () => {
    fetchMock.mockResolvedValue(okJson({ models: [{ name: 'mistral' }] }))
    expect(await probeOllama({ ...OLLAMA, model: 'llama3.1:8b' })).toEqual({
      reachable: true,
      hasModel: false,
    })
  })

  it('reports unreachable on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(notOk(404))
    expect(await probeOllama()).toEqual({ reachable: false, hasModel: false })
  })

  it('reports unreachable when the fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('down'))
    expect(await probeOllama()).toEqual({ reachable: false, hasModel: false })
  })
})

describe('pullModel', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('streams progress lines (with derived percent) and resolves ok on completion', async () => {
    // Two lines split across the buffer boundary + a partial-then-completed line.
    fetchMock.mockResolvedValue(
      streamingOk([
        '{"status":"pulling manifest"}\n',
        '{"status":"downloading","completed":50,"total":200}\n{"status":"success"}\n',
      ]),
    )
    const seen: PullProgress[] = []
    const res = await pullModel(OLLAMA, (p) => seen.push(p))
    expect(res).toEqual({ ok: true })
    expect(seen.map((p) => p.status)).toEqual(['pulling manifest', 'downloading', 'success'])
    expect(seen[1].percent).toBe(25) // 50/200
  })

  it('reassembles a status line split across two chunks', async () => {
    fetchMock.mockResolvedValue(
      streamingOk(['{"status":"down', 'loading","completed":1,"total":4}\n']),
    )
    const seen: PullProgress[] = []
    const res = await pullModel(OLLAMA, (p) => seen.push(p))
    expect(res.ok).toBe(true)
    expect(seen).toEqual([{ status: 'downloading', completed: 1, total: 4, percent: 25 }])
  })

  it('returns { ok:false, error } when the stream carries an error line', async () => {
    fetchMock.mockResolvedValue(streamingOk(['{"error":"model not found"}\n']))
    expect(await pullModel(OLLAMA, () => {})).toEqual({ ok: false, error: 'model not found' })
  })

  it('returns { ok:false } on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(notOk(500))
    expect((await pullModel(OLLAMA, () => {})).ok).toBe(false)
  })

  it('returns { ok:false } when the fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect((await pullModel(OLLAMA, () => {})).ok).toBe(false)
  })
})
