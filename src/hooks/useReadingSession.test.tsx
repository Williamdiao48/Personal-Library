import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useReadingSession } from './useReadingSession'

// The hook records active reading segments via statsService. Mock it and drive
// the wall clock with fake timers (the hook reads Date.now() directly — there
// are no setTimeout/interval, so setSystemTime fully controls it). Renderer
// project (jsdom); no window.api, no better-sqlite3, no ABI toggle.
vi.mock('../services/stats', () => ({
  statsService: { recordSession: vi.fn().mockResolvedValue(undefined) },
}))
import { statsService } from '../services/stats'

const rec = vi.mocked(statsService.recordSession)
const at = (ms: number) => vi.setSystemTime(ms)

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  at(0)
})
afterEach(() => {
  setHidden(false) // restore jsdom default before the next mount
  vi.useRealTimers()
})

describe('useReadingSession', () => {
  it('records an active session on unmount', () => {
    const { result, unmount } = renderHook(() => useReadingSession('item1'))
    at(30_000)
    act(() => result.current.recordActivity())
    unmount()
    expect(rec).toHaveBeenCalledTimes(1)
    expect(rec).toHaveBeenCalledWith('item1', 0, 30_000)
  })

  // Headline A: idle time past the 1-minute grace is never counted — the
  // session end is clamped to lastActivity + IDLE_GRACE, not "now".
  it('clamps the session end to lastActivity + grace, excluding idle time', () => {
    const { result, unmount } = renderHook(() => useReadingSession('item1'))
    at(30_000)
    act(() => result.current.recordActivity())
    at(120_000) // user walked away for 90s before navigating off
    unmount()
    expect(rec).toHaveBeenCalledWith('item1', 0, 90_000) // 30s + 60s grace, not 120s
  })

  it('discards a session shorter than the 5s minimum', () => {
    const { result, unmount } = renderHook(() => useReadingSession('item1'))
    at(2_000)
    act(() => result.current.recordActivity())
    unmount()
    expect(rec).not.toHaveBeenCalled()
  })

  it('is a no-op on unmount when there was no activity', () => {
    const { unmount } = renderHook(() => useReadingSession('item1'))
    unmount()
    expect(rec).not.toHaveBeenCalled()
  })

  it('keeps a single segment across activity within the idle window', () => {
    const { result, unmount } = renderHook(() => useReadingSession('item1'))
    at(10_000)
    act(() => result.current.recordActivity())
    at(20_000)
    act(() => result.current.recordActivity())
    unmount()
    expect(rec).toHaveBeenCalledTimes(1)
    expect(rec).toHaveBeenCalledWith('item1', 0, 20_000)
  })

  // Headline B: activity after > IDLE_TIMEOUT flushes the stale segment and
  // begins a fresh one starting at the resume time, so the gap is not counted.
  it('flushes and starts a fresh segment after a long idle gap', () => {
    const { result, unmount } = renderHook(() => useReadingSession('item1'))
    at(10_000)
    act(() => result.current.recordActivity())
    at(670_000) // 11 min later (> 10 min idle timeout)
    act(() => result.current.recordActivity())
    expect(rec).toHaveBeenNthCalledWith(1, 'item1', 0, 70_000) // stale segment: [0, 10s+grace]
    at(690_000)
    act(() => result.current.recordActivity())
    unmount()
    expect(rec).toHaveBeenNthCalledWith(2, 'item1', 670_000, 690_000) // fresh segment
    expect(rec).toHaveBeenCalledTimes(2)
  })

  it('flushes when the tab is hidden and does not double-count on unmount', () => {
    const { result, unmount } = renderHook(() => useReadingSession('item1'))
    at(20_000)
    act(() => result.current.recordActivity())
    act(() => setHidden(true))
    expect(rec).toHaveBeenCalledWith('item1', 0, 20_000)
    unmount() // still hidden → cleanup must not flush again
    expect(rec).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh segment when the tab becomes visible again', () => {
    const { result, unmount } = renderHook(() => useReadingSession('item1'))
    at(10_000)
    act(() => result.current.recordActivity())
    act(() => setHidden(true)) // flush [0, 10s]
    at(70_000)
    act(() => setHidden(false)) // fresh segment anchored at 70s
    at(90_000)
    act(() => result.current.recordActivity())
    unmount()
    expect(rec).toHaveBeenNthCalledWith(1, 'item1', 0, 10_000)
    expect(rec).toHaveBeenNthCalledWith(2, 'item1', 70_000, 90_000) // 60s hidden gap excluded
  })
})
