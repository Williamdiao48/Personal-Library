import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { CaptureJobsProvider, useCaptureJobs } from './CaptureJobsContext'

// The provider registers the capture:* IPC listeners at app scope. We capture the
// callbacks it hands to window.api so tests can fire progress/complete/error events
// and assert the shared job list the sidebar renders from.

type ProgressCb = (p: { jobId: string; msg: string }) => void
type CompleteCb = (p: { jobId: string; result: { id: string; title: string } }) => void
type ErrorCb = (p: { jobId: string; error: string }) => void
type BatchCb = (p: import('../types').BulkImportProgress) => void

let onProgress: ProgressCb | null
let onComplete: CompleteCb | null
let onError: ErrorCb | null
let onBatchProgress: BatchCb | null
let onBatchComplete: BatchCb | null
const cancelBulk = vi.fn()

beforeEach(() => {
  onProgress = onComplete = onError = null
  onBatchProgress = onBatchComplete = null
  cancelBulk.mockClear()
  ;(window as unknown as { api: unknown }).api = {
    onCaptureProgress: (cb: ProgressCb) => {
      onProgress = cb
      return () => {}
    },
    onCaptureComplete: (cb: CompleteCb) => {
      onComplete = cb
      return () => {}
    },
    onCaptureError: (cb: ErrorCb) => {
      onError = cb
      return () => {}
    },
    onBatchProgress: (cb: BatchCb) => {
      onBatchProgress = cb
      return () => {}
    },
    onBatchComplete: (cb: BatchCb) => {
      onBatchComplete = cb
      return () => {}
    },
    capture: { cancelBulk },
  }
})

const wrapper = ({ children }: { children: ReactNode }) => (
  <CaptureJobsProvider>{children}</CaptureJobsProvider>
)

describe('CaptureJobsContext', () => {
  it('startJob adds a running job to the shared list', () => {
    const { result } = renderHook(() => useCaptureJobs(), { wrapper })
    act(() => result.current.startJob('j1', 'https://x/1'))
    expect(result.current.captureJobs).toHaveLength(1)
    expect(result.current.captureJobs[0]).toMatchObject({
      id: 'j1',
      url: 'https://x/1',
      status: 'running',
    })
  })

  it('a progress event updates the message and parses "chapter N of M"', () => {
    const { result } = renderHook(() => useCaptureJobs(), { wrapper })
    act(() => result.current.startJob('j1', 'u'))
    act(() => onProgress!({ jobId: 'j1', msg: 'Fetching chapter 3 of 10…' }))
    expect(result.current.captureJobs[0]).toMatchObject({
      msg: 'Fetching chapter 3 of 10…',
      chapter: 3,
      total: 10,
    })
  })

  it('a complete event marks the job done, then auto-dismisses after 4 s', () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useCaptureJobs(), { wrapper })
      act(() => result.current.startJob('j1', 'u'))
      act(() => onComplete!({ jobId: 'j1', result: { id: 'i1', title: 'Done Title' } }))
      expect(result.current.captureJobs[0]).toMatchObject({ status: 'done', title: 'Done Title' })
      act(() => vi.advanceTimersByTime(4000))
      expect(result.current.captureJobs).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an error event marks the job error and keeps it visible (no auto-dismiss)', () => {
    const { result } = renderHook(() => useCaptureJobs(), { wrapper })
    act(() => result.current.startJob('j1', 'u'))
    act(() => onError!({ jobId: 'j1', error: 'boom' }))
    expect(result.current.captureJobs[0]).toMatchObject({ status: 'error', error: 'boom' })
  })

  it('useCaptureJobs throws outside the provider', () => {
    expect(() => renderHook(() => useCaptureJobs())).toThrow(/CaptureJobsProvider/)
  })
})

describe('CaptureJobsContext — bulk imports', () => {
  const start = (
    result: ReturnType<typeof renderHook<ReturnType<typeof useCaptureJobs>, unknown>>,
  ) => act(() => result.result.current.startBatch('b1', 'ao3', 'AO3 · reader', 5))

  it('startBatch adds a running aggregate row', () => {
    const result = renderHook(() => useCaptureJobs(), { wrapper })
    start(result)
    expect(result.result.current.batchJobs).toHaveLength(1)
    expect(result.result.current.batchJobs[0]).toMatchObject({
      id: 'b1',
      source: 'ao3',
      label: 'AO3 · reader',
      total: 5,
      status: 'running',
    })
  })

  it('a progress event folds counts into the matching batch', () => {
    const result = renderHook(() => useCaptureJobs(), { wrapper })
    start(result)
    act(() =>
      onBatchProgress!({
        batchId: 'b1',
        total: 5,
        done: 2,
        failed: 1,
        skipped: 1,
        current: 'https://x/works/9',
        status: 'running',
      }),
    )
    expect(result.result.current.batchJobs[0]).toMatchObject({ done: 2, failed: 1, skipped: 1 })
  })

  it('a done completion auto-dismisses after 6 s', () => {
    vi.useFakeTimers()
    try {
      const result = renderHook(() => useCaptureJobs(), { wrapper })
      start(result)
      act(() =>
        onBatchComplete!({
          batchId: 'b1',
          total: 5,
          done: 5,
          failed: 0,
          skipped: 0,
          status: 'done',
        }),
      )
      expect(result.result.current.batchJobs[0]).toMatchObject({ status: 'done' })
      act(() => vi.advanceTimersByTime(6000))
      expect(result.result.current.batchJobs).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a throttled completion stays visible (no auto-dismiss)', () => {
    vi.useFakeTimers()
    try {
      const result = renderHook(() => useCaptureJobs(), { wrapper })
      start(result)
      act(() =>
        onBatchComplete!({
          batchId: 'b1',
          total: 5,
          done: 2,
          failed: 3,
          skipped: 0,
          status: 'throttled',
        }),
      )
      act(() => vi.advanceTimersByTime(10000))
      expect(result.result.current.batchJobs[0]).toMatchObject({ status: 'throttled' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancelBatch asks main to cancel and clears the current work', () => {
    const result = renderHook(() => useCaptureJobs(), { wrapper })
    start(result)
    act(() => result.result.current.cancelBatch('b1'))
    expect(cancelBulk).toHaveBeenCalledWith('b1')
  })

  it('dismissBatch removes the row', () => {
    const result = renderHook(() => useCaptureJobs(), { wrapper })
    start(result)
    act(() => result.result.current.dismissBatch('b1'))
    expect(result.result.current.batchJobs).toHaveLength(0)
  })
})
