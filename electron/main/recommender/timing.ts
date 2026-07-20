// Opt-in stage-timing instrumentation for the Discover recommender. Logs
// `[discover-timing] <label>: <ms>ms [k=v …]` to the MAIN-process console (the terminal
// running `npm run dev`) so recommender-perf work (prewarm, the description N+1, future
// fit-cache) can be measured without a profiler. A lasting dev tool, not a shipped
// feature: it is OFF by default and does zero work unless explicitly enabled, so a
// normal build never logs and never pays for it.

// Off by default; set DISCOVER_TIMING=1 to enable. Always silent under Vitest so it
// can't spam test output or trip console spies.
const ENABLED = process.env.DISCOVER_TIMING === '1' && !process.env.VITEST

/** High-resolution millisecond clock. */
export function now(): number {
  return performance.now()
}

/** Log a labeled duration (ms since `startMs`) with optional key=value context. */
export function logTiming(label: string, startMs: number, extra?: Record<string, unknown>): void {
  if (!ENABLED) return
  const ms = Math.round(performance.now() - startMs)
  const suffix = extra
    ? ' ' +
      Object.entries(extra)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
    : ''
  console.log(`[discover-timing] ${label}: ${ms}ms${suffix}`)
}

/** Time an async stage: runs `fn`, logs its duration (even on throw), returns its result. */
export async function timed<T>(
  label: string,
  fn: () => Promise<T>,
  extra?: Record<string, unknown>,
): Promise<T> {
  const start = now()
  try {
    return await fn()
  } finally {
    logTiming(label, start, extra)
  }
}
