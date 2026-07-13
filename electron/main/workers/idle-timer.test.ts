import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createIdleTimer } from './idle-timer'

// Exercises the pure idle-countdown used by embed-host to release the worker's
// model after a spell of inactivity. Fake timers drive the delay; the fork/kill
// wiring lives in embed-host.ts and is covered by manual verification.

describe('createIdleTimer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires onIdle after the delay when still idle', () => {
    const onIdle = vi.fn()
    const t = createIdleTimer(1000, () => true, onIdle)
    t.schedule()
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(999)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('does not fire when a request is in flight at expiry (isIdle false)', () => {
    const onIdle = vi.fn()
    const t = createIdleTimer(1000, () => false, onIdle)
    t.schedule()
    vi.advanceTimersByTime(1000)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('cancel before expiry suppresses onIdle', () => {
    const onIdle = vi.fn()
    const t = createIdleTimer(1000, () => true, onIdle)
    t.schedule()
    vi.advanceTimersByTime(500)
    t.cancel()
    vi.advanceTimersByTime(1000)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('re-scheduling resets the countdown (single fire)', () => {
    const onIdle = vi.fn()
    const t = createIdleTimer(1000, () => true, onIdle)
    t.schedule()
    vi.advanceTimersByTime(800)
    t.schedule() // reset — the first 800ms should not count toward the new countdown
    vi.advanceTimersByTime(800)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('re-evaluates isIdle at fire time, not schedule time', () => {
    let idle = true
    const onIdle = vi.fn()
    const t = createIdleTimer(1000, () => idle, onIdle)
    t.schedule()
    idle = false // a request arrived after arming
    vi.advanceTimersByTime(1000)
    expect(onIdle).not.toHaveBeenCalled()
  })
})
