// Thin wrapper over window.api.llm — the renderer never touches window.api directly.
// `setConfig` syncs the local-LLM reranker setting to main; `probe` backs the
// Settings "Test connection" button.
export const llmService = {
  setConfig: (cfg: { enabled: boolean; model: string; baseUrl: string }) =>
    window.api.llm.setConfig(cfg),
  probe: (cfg: { model: string; baseUrl: string }) => window.api.llm.probe(cfg),
  pullModel: (cfg: { model: string; baseUrl: string }) => window.api.llm.pullModel(cfg),
  onPullProgress: (
    callback: (p: { status: string; completed?: number; total?: number; percent: number }) => void,
  ) => window.api.llm.onPullProgress(callback),
}
