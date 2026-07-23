import { describe, it, expect, vi, beforeEach } from 'vitest'

// The backfill lifecycle trigger, with its two heavy lazy deps mocked so the
// suite stays light + ABI-agnostic (no DB, no transformers). Proves the `armed`
// guard, the delegation to scheduleBackfill(workerEmbedHost), and worker
// shutdown — without spawning anything.
const {
  scheduleBackfill,
  cancelBackfill,
  shutdownEmbedWorker,
  workerEmbedHost,
  schedulePrewarm,
  cancelPrewarm,
} = vi.hoisted(() => ({
  scheduleBackfill: vi.fn(),
  cancelBackfill: vi.fn(),
  shutdownEmbedWorker: vi.fn(),
  workerEmbedHost: { modelVersion: 'test-model', embed: vi.fn() },
  schedulePrewarm: vi.fn(),
  cancelPrewarm: vi.fn(),
}))

vi.mock('./backfill', () => ({ scheduleBackfill, cancelBackfill }))
vi.mock('../workers/embed-host', () => ({ workerEmbedHost, shutdownEmbedWorker }))
vi.mock('./prewarm', () => ({ schedulePrewarm, cancelPrewarm }))

import {
  armBackfill,
  disarmBackfill,
  triggerBackfill,
  shutdownBackfill,
  _resetLifecycle,
} from './lifecycle'

beforeEach(() => {
  _resetLifecycle()
  scheduleBackfill.mockReset()
  cancelBackfill.mockReset()
  shutdownEmbedWorker.mockReset()
  schedulePrewarm.mockReset()
  cancelPrewarm.mockReset()
})

describe('backfill lifecycle', () => {
  it('triggerBackfill is a no-op until armed', async () => {
    triggerBackfill()
    // let any (erroneous) dynamic import + microtasks resolve
    await Promise.resolve()
    await Promise.resolve()
    expect(scheduleBackfill).not.toHaveBeenCalled()
  })

  it('armBackfill arms and kicks the initial pass with the worker host', async () => {
    armBackfill()
    await vi.waitFor(() => expect(scheduleBackfill).toHaveBeenCalledWith(workerEmbedHost))
  })

  it('armBackfill also schedules a Discover blurb prewarm', async () => {
    armBackfill()
    await vi.waitFor(() => expect(schedulePrewarm).toHaveBeenCalledTimes(1))
  })

  it('prewarm stays a no-op until armed (same gate as backfill)', async () => {
    triggerBackfill()
    await Promise.resolve()
    await Promise.resolve()
    expect(schedulePrewarm).not.toHaveBeenCalled()
  })

  it('triggers again after arming (content-change events)', async () => {
    armBackfill()
    await vi.waitFor(() => expect(scheduleBackfill).toHaveBeenCalledTimes(1))
    triggerBackfill()
    await vi.waitFor(() => expect(scheduleBackfill).toHaveBeenCalledTimes(2))
  })

  it('shutdownBackfill tears down the worker after a backfill has fired', async () => {
    armBackfill()
    await vi.waitFor(() => expect(scheduleBackfill).toHaveBeenCalled())
    shutdownBackfill()
    expect(shutdownEmbedWorker).toHaveBeenCalledTimes(1)
  })

  it('shutdownBackfill is a no-op if no backfill ever fired', () => {
    shutdownBackfill()
    expect(shutdownEmbedWorker).not.toHaveBeenCalled()
  })

  it('disarmBackfill tears down the worker and stops further triggers', async () => {
    armBackfill()
    await vi.waitFor(() => expect(scheduleBackfill).toHaveBeenCalledTimes(1))

    disarmBackfill()
    expect(shutdownEmbedWorker).toHaveBeenCalledTimes(1)

    // Disarmed: a subsequent content-change trigger must NOT re-fire a backfill.
    triggerBackfill()
    await Promise.resolve()
    await Promise.resolve()
    expect(scheduleBackfill).toHaveBeenCalledTimes(1)
  })

  // M2: turning Discover off must cancel debounce timers scheduled just before
  // the toggle — otherwise a pending backfill re-forks the ~800 MB worker and a
  // pending prewarm hits OpenLibrary after "off".
  it('disarmBackfill cancels pending backfill + prewarm debounce timers (window 1)', async () => {
    armBackfill()
    await vi.waitFor(() => expect(scheduleBackfill).toHaveBeenCalledTimes(1))

    disarmBackfill()
    expect(cancelBackfill).toHaveBeenCalledTimes(1)
    expect(cancelPrewarm).toHaveBeenCalledTimes(1)
  })

  // M2 window 2: disarm lands while fire()'s dynamic imports are still in flight,
  // so there's no timer to cancel yet — the post-await `armed` re-check in fire()
  // must prevent it from scheduling once the imports resolve.
  it('a trigger whose import resolves after disarm does not schedule anything', async () => {
    armBackfill() // arms + kicks fire(); its async body is pending on dynamic import
    disarmBackfill() // disarm before fire()'s imports resolve

    // Drain the fire() microtask chain (dynamic import + Promise.all).
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // fire() saw !armed after the await and bailed → nothing scheduled.
    expect(scheduleBackfill).not.toHaveBeenCalled()
    expect(schedulePrewarm).not.toHaveBeenCalled()
  })
})
