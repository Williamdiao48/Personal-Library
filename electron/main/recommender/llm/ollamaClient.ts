// Local LLM provider client (Ollama). The book reranker uses this to score
// candidate fit. It is deliberately FAIL-SOFT: every network / non-2xx / timeout /
// parse error resolves to `null` ("no opinion") rather than throwing, so the
// recommender falls back to pure cosine ordering instead of surfacing an error. A
// plain `fetch` to Ollama's local HTTP API — no SDK, no dependency, fully offline.

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/**
 * The provider seam — a cloud client (Anthropic, etc.) can implement this later
 * without touching the reranker. `chatJson` returns the assistant's reply parsed as
 * JSON, or null on any failure.
 */
export interface LlmClient {
  chatJson(messages: ChatMessage[]): Promise<unknown | null>
}

export interface OllamaConfig {
  baseUrl: string
  model: string
  timeoutMs: number
}

export const OLLAMA: OllamaConfig = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'llama3.2:3b', // light default (~2–3GB) — comfortable under memory pressure
  timeoutMs: 20_000,
}

/** Trim trailing slashes so `${baseUrl}/api/...` never doubles up. */
function base(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * An Ollama-backed LlmClient. Requests constrained JSON output (`format: 'json'`,
 * Ollama's grammar-guided mode) with streaming off and a hard timeout. Any non-2xx,
 * timeout, thrown fetch, non-string content, or unparseable body resolves to null
 * so the reranker degrades to cosine ordering. Touches the local network only.
 */
export function ollamaClient(cfg: OllamaConfig = OLLAMA): LlmClient {
  return {
    async chatJson(messages: ChatMessage[]): Promise<unknown | null> {
      try {
        const res = await fetch(`${base(cfg.baseUrl)}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, messages, format: 'json', stream: false }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        })
        if (!res.ok) return null
        const body = (await res.json()) as { message?: { content?: unknown } }
        const content = body?.message?.content
        if (typeof content !== 'string') return null
        return JSON.parse(content) as unknown
      } catch {
        return null
      }
    },
  }
}

/**
 * Reachability + model-presence probe for the Settings "Test connection" button.
 * GETs `/api/tags` (Ollama's installed-models list). Matches the configured model
 * with or without its `:tag` suffix (Ollama lists e.g. `llama3.1:8b`). Never throws.
 */
export async function probeOllama(
  cfg: OllamaConfig = OLLAMA,
): Promise<{ reachable: boolean; hasModel: boolean }> {
  try {
    const res = await fetch(`${base(cfg.baseUrl)}/api/tags`, {
      signal: AbortSignal.timeout(cfg.timeoutMs),
    })
    if (!res.ok) return { reachable: false, hasModel: false }
    const body = (await res.json()) as { models?: { name?: string }[] }
    const installed = (body.models ?? []).map((m) => m.name ?? '')
    const wantedBase = cfg.model.split(':')[0]
    const hasModel = installed.some((n) => n === cfg.model || n.split(':')[0] === wantedBase)
    return { reachable: true, hasModel }
  } catch {
    return { reachable: false, hasModel: false }
  }
}

/** One streamed pull status line, normalized with a 0–100 percent for the UI. */
export interface PullProgress {
  status: string
  completed?: number
  total?: number
  percent: number
}

/**
 * Download (pull) a model via Ollama's streaming `/api/pull`, invoking `onProgress`
 * for each NDJSON status line so the renderer can show a live bar. No timeout — a
 * multi-GB pull runs for minutes. Resolves { ok:true } on the terminal success line,
 * { ok:false, error } on a stream error / non-2xx / thrown fetch. Never throws.
 */
export async function pullModel(
  cfg: OllamaConfig,
  onProgress: (p: PullProgress) => void,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${base(cfg.baseUrl)}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, stream: true }),
    })
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let streamError: string | undefined
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? '' // keep any trailing partial line for the next chunk
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let obj: { status?: string; completed?: number; total?: number; error?: string }
        try {
          obj = JSON.parse(trimmed)
        } catch {
          continue // ignore a non-JSON line rather than fail the whole pull
        }
        if (obj.error) streamError = obj.error
        const percent =
          typeof obj.completed === 'number' && typeof obj.total === 'number' && obj.total > 0
            ? Math.round((obj.completed / obj.total) * 100)
            : 0
        onProgress({
          status: obj.status ?? 'downloading',
          completed: obj.completed,
          total: obj.total,
          percent,
        })
      }
    }
    return streamError ? { ok: false, error: streamError } : { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
