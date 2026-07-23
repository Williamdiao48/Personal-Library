import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

// H2 (bug overhaul 2026-07-23) — the embed worker's lifecycle is a module
// singleton around a real utilityProcess. Mock `electron` so we can drive the
// fork/exit/timeout races deterministically without spawning a child. The heavy
// model imports (`embeddingText`, `embedder`) are pure path/vector helpers; only
// `utilityProcess.fork` and a little of `app` are touched by the code under test.

class FakeProc extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn()
  stderr = { on: vi.fn() }
}

const forked: FakeProc[] = []
const forkFn = vi.fn(() => {
  const p = new FakeProc()
  forked.push(p)
  return p
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp/pl-test-app',
    getPath: (n: string) => `/tmp/pl-test-${n}`,
  },
  utilityProcess: { fork: (...a: unknown[]) => forkFn(...a) },
}))

type HostMod = typeof import('./embed-host')
let host: HostMod

/** Kick an embed request; swallow rejection so fake-timer rejects don't leak. */
function embed(host: HostMod, texts = ['x']): Promise<unknown> {
  const p = host.workerEmbedder.embed(texts)
  p.catch(() => {})
  return p
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  forked.length = 0
  forkFn.mockClear()
  host = await import('./embed-host')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('embed-host worker lifecycle (H2 race guards)', () => {
  it('forks lazily on first request and reuses the same worker', () => {
    embed(host)
    embed(host)
    expect(forkFn).toHaveBeenCalledTimes(1)
  })

  it('a superseded worker’s late exit does not clobber the respawned worker', async () => {
    // Request 1 forks worker A.
    const p1 = embed(host, ['a'])
    const a = forked[0]
    expect(forkFn).toHaveBeenCalledTimes(1)

    // A wedges: its request times out, which kills A and nulls the ref.
    await vi.advanceTimersByTimeAsync(180_000)
    await expect(p1).rejects.toThrow(/timed out/)
    expect(a.kill).toHaveBeenCalled()

    // Request 2 forks a fresh worker B.
    const p2 = embed(host, ['b'])
    const b = forked[1]
    expect(forkFn).toHaveBeenCalledTimes(2)

    // A finally emits its (now stale) exit. It must NOT null B or reject p2.
    a.emit('exit', 0)

    // B is still the live worker: another request reuses it (no 3rd fork)…
    embed(host, ['c'])
    expect(forkFn).toHaveBeenCalledTimes(2)
    // …and p2 is still in flight (not rejected by the stale exit).
    let settled = false
    void p2.then(
      () => (settled = true),
      () => (settled = true),
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    // Sanity: B can still resolve normally once it spawns and answers.
    b.emit('spawn')
    b.emit('message', { id: 2, ok: true, result: [[1, 2, 3]] })
    await expect(p2).resolves.toEqual([Float32Array.from([1, 2, 3])])
  })

  it('a stale request timeout does not kill the current worker', async () => {
    // Two concurrent requests on worker A, staggered so their timeouts differ.
    const p1 = embed(host, ['a']) // T1 fires at t=180_000
    const a = forked[0]
    await vi.advanceTimersByTimeAsync(20_000)
    const p2 = embed(host, ['b']) // T2 fires at t=200_000
    expect(forkFn).toHaveBeenCalledTimes(1)

    // t=180_000: req1 times out → recycles A (kill + null ref).
    await vi.advanceTimersByTimeAsync(160_000)
    await expect(p1).rejects.toThrow(/timed out/)
    expect(a.kill).toHaveBeenCalledTimes(1)

    // A new request forks worker B before req2's timer fires.
    embed(host, ['c'])
    const b = forked[1]
    expect(forkFn).toHaveBeenCalledTimes(2)

    // t=200_000: req2's stale timeout fires. Its worker (A) is no longer current,
    // so the guard must leave B untouched (the second clobber path).
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(p2).rejects.toThrow(/timed out/)
    expect(b.kill).not.toHaveBeenCalled()
    // B is still live: reused, not re-forked.
    embed(host, ['d'])
    expect(forkFn).toHaveBeenCalledTimes(2)
  })

  it('a current worker’s crash still rejects everything in flight', async () => {
    const p1 = embed(host, ['a'])
    const a = forked[0]
    a.emit('exit', 1) // A is the current worker → normal crash cleanup
    await expect(p1).rejects.toThrow(/exited \(code 1\)/)
    // Next request recovers by forking a fresh worker.
    embed(host, ['b'])
    expect(forkFn).toHaveBeenCalledTimes(2)
  })
})
