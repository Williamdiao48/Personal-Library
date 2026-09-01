import { describe, it, expect, beforeEach } from 'vitest'
import { beginCaptureWork, endCaptureWork, captureWorkActive } from './activity'

// The counter is module-level singleton state; drain it before each test so a
// prior test's imbalance can't leak in. (endCaptureWork floors at 0, so calling it
// a few extra times is a safe way to reset.)
beforeEach(() => {
  for (let i = 0; i < 5; i++) endCaptureWork()
})

describe('capture activity counter', () => {
  it('is inactive with no work in flight', () => {
    expect(captureWorkActive()).toBe(false)
  })

  it('is active while at least one capture is bracketed', () => {
    beginCaptureWork()
    expect(captureWorkActive()).toBe(true)
    endCaptureWork()
    expect(captureWorkActive()).toBe(false)
  })

  it('stays active until every concurrent capture ends (nested count)', () => {
    beginCaptureWork()
    beginCaptureWork()
    expect(captureWorkActive()).toBe(true)
    endCaptureWork()
    expect(captureWorkActive()).toBe(true) // one still running
    endCaptureWork()
    expect(captureWorkActive()).toBe(false)
  })

  it('floors at zero so an unbalanced end() cannot wedge it active forever', () => {
    endCaptureWork() // extra end with nothing in flight
    expect(captureWorkActive()).toBe(false)
    beginCaptureWork()
    expect(captureWorkActive()).toBe(true) // a real begin still flips it true
    endCaptureWork()
    expect(captureWorkActive()).toBe(false)
  })
})
