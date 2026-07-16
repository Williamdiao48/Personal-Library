import { ipcMain } from 'electron'
import { OLLAMA, probeOllama, pullModel, type OllamaConfig } from '../recommender/llm/ollamaClient'

// The local-LLM (Ollama) IPC seam for the book reranker. Two responsibilities:
//   - `llm:setConfig` — the renderer owns the setting (localStorage), so it syncs the
//     current { enabled, model, baseUrl } here on boot + on change, exactly how
//     `enableDiscover` is synced via `discover:setEnabled`. We cache it main-side so
//     the Discover handler can decide whether to build a client per refresh. No DB.
//   - `llm:probe` — the Settings "Test connection" button; reports whether Ollama is
//     reachable and the chosen model is installed, using the FORM's current values so
//     the user can test before saving.

/** The reranker config the Discover handler reads each refresh. */
export interface LlmRerankConfig {
  enabled: boolean
  model: string
  baseUrl: string
}

let config: LlmRerankConfig = {
  enabled: false, // opt-in: off until the renderer syncs an enabled setting
  model: OLLAMA.model,
  baseUrl: OLLAMA.baseUrl,
}

/** The current synced reranker config (read by the Discover IPC). */
export function getLlmConfig(): LlmRerankConfig {
  return config
}

/** Full OllamaConfig for the current setting (folds in the shared timeout). */
export function ollamaConfigFrom(cfg: Pick<LlmRerankConfig, 'model' | 'baseUrl'>): OllamaConfig {
  return { baseUrl: cfg.baseUrl, model: cfg.model, timeoutMs: OLLAMA.timeoutMs }
}

export function registerLlmHandlers(): void {
  // Renderer → main setting sync. Missing/blank fields fall back to defaults so a
  // partial payload can never leave the config in a broken state.
  ipcMain.handle('llm:setConfig', (_e, next: Partial<LlmRerankConfig>): void => {
    config = {
      enabled: !!next.enabled,
      model: next.model?.trim() || OLLAMA.model,
      baseUrl: next.baseUrl?.trim() || OLLAMA.baseUrl,
    }
  })

  // "Test connection": probe with the form's current values (not the saved config).
  ipcMain.handle(
    'llm:probe',
    (
      _e,
      cfg: Pick<LlmRerankConfig, 'model' | 'baseUrl'>,
    ): Promise<{
      reachable: boolean
      hasModel: boolean
    }> =>
      probeOllama(
        ollamaConfigFrom({
          model: cfg?.model?.trim() || OLLAMA.model,
          baseUrl: cfg?.baseUrl?.trim() || OLLAMA.baseUrl,
        }),
      ),
  )

  // "Download model": drive Ollama's streaming /api/pull, forwarding each progress
  // line to the renderer over `llm:pullProgress` so it can show a live bar. Resolves
  // when the pull finishes (or fails) — a pull runs for minutes, so there's no timeout.
  ipcMain.handle(
    'llm:pullModel',
    (
      event,
      cfg: Pick<LlmRerankConfig, 'model' | 'baseUrl'>,
    ): Promise<{ ok: boolean; error?: string }> =>
      pullModel(
        ollamaConfigFrom({
          model: cfg?.model?.trim() || OLLAMA.model,
          baseUrl: cfg?.baseUrl?.trim() || OLLAMA.baseUrl,
        }),
        (p) => event.sender.send('llm:pullProgress', p),
      ),
  )
}
