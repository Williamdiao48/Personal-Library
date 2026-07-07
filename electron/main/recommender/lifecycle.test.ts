import { describe, it, expect, vi, beforeEach } from 'vitest'

// The backfill lifecycle trigger, with its two heavy lazy deps mocked so the
// suite stays light + ABI-agnostic (no DB, no transformers). Proves the `armed`
// guard, the delegation to scheduleBackfill(workerEmbedHost), and worker
// shutdown — without spawning anything.
const { scheduleBackfill, shutdownEmbedWorker, workerEmbedHost } = vi.hoisted(() => ({
  scheduleBackfill: vi.fn(),
  shutdownEmbedWorker: vi.fn(),
  workerEmbedHost: { modelVersion: 'test-model', embed: vi.fn() },
}))

vi.mock('./backfill', () => ({ scheduleBackfill }))
vi.mock('../workers/embed-host', () => ({ workerEmbedHost, shutdownEmbedWorker }))

import { armBackfill, triggerBackfill, shutdownBackfill, _resetLifecycle } from './lifecycle'

beforeEach(() => {
  _resetLifecycle()
  scheduleBackfill.mockReset()
  shutdownEmbedWorker.mockReset()
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
})
