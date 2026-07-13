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

let onProgress: ProgressCb | null
let onComplete: CompleteCb | null
let onError: ErrorCb | null

beforeEach(() => {
  onProgress = onComplete = onError = null
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
