import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The Discover blurb prewarm, with its two DB-backed deps mocked so the suite stays
// light + ABI-agnostic (no better-sqlite3, no network). Proves the in-flight guard
// (concurrent callers coalesce), the debounced schedule, the empty-taste short
// circuit, and that a source failure never rejects the caller.
const { buildTaste, prewarmBooks } = vi.hoisted(() => ({
  buildTaste: vi.fn(),
  prewarmBooks: vi.fn(),
}))

vi.mock('./taste', () => ({ buildTaste }))
vi.mock('./sources/openLibrary', () => ({ prewarmBooks }))

import { runPrewarm, schedulePrewarm, cancelPrewarm, _resetPrewarmState } from './prewarm'

const liked = [{ id: 'a', weight: 1 }]

beforeEach(() => {
  _resetPrewarmState()
  buildTaste.mockReset()
  prewarmBooks.mockReset()
  buildTaste.mockReturnValue({ liked, centroids: [new Float32Array([1])] })
  prewarmBooks.mockResolvedValue(3)
})

afterEach(() => {
  _resetPrewarmState()
})

describe('discover blurb prewarm', () => {
  it('runPrewarm warms the book pool via prewarmBooks(taste.liked)', async () => {
    await runPrewarm()
    expect(prewarmBooks).toHaveBeenCalledTimes(1)
    expect(prewarmBooks).toHaveBeenCalledWith(liked)
  })

  it('short-circuits with no liked items (no pool to warm)', async () => {
    buildTaste.mockReturnValue({ liked: [], centroids: [] })
    await runPrewarm()
    expect(prewarmBooks).not.toHaveBeenCalled()
  })

  it('coalesces concurrent calls onto a single in-flight run', async () => {
    let release!: (n: number) => void
    prewarmBooks.mockReturnValue(new Promise<number>((r) => (release = r)))

    const a = runPrewarm()
    const b = runPrewarm()
    expect(a).toBe(b) // same in-flight promise
    release(2)
    await Promise.all([a, b])
    expect(prewarmBooks).toHaveBeenCalledTimes(1)
  })

  it('allows a fresh run after the previous one settles', async () => {
    await runPrewarm()
    await runPrewarm()
    expect(prewarmBooks).toHaveBeenCalledTimes(2)
  })

  it('never rejects when a source fails — degrades to a partial warm', async () => {
    prewarmBooks.mockRejectedValue(new Error('OpenLibrary down'))
    await expect(runPrewarm()).resolves.toBeUndefined()
  })

  it('schedulePrewarm debounces a burst into one run', async () => {
    vi.useFakeTimers()
    try {
      schedulePrewarm(1000)
      schedulePrewarm(1000)
      schedulePrewarm(1000)
      expect(prewarmBooks).not.toHaveBeenCalled() // still waiting out the debounce
      await vi.advanceTimersByTimeAsync(1000)
      expect(prewarmBooks).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // M2: cancelPrewarm (called on Discover-off) drops a pending debounce so the
  // scheduled fetch never fires after the feature was disabled.
  it('cancelPrewarm stops a pending scheduled prewarm from firing', async () => {
    vi.useFakeTimers()
    try {
      schedulePrewarm(1000)
      cancelPrewarm()
      await vi.advanceTimersByTimeAsync(5000)
      expect(prewarmBooks).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
