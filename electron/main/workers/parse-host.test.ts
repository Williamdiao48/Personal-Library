import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

// T1-1 (phase2 correctness sweep) — the parse worker's lifecycle is the same
// module-singleton around a real utilityProcess as embed-host, and originally
// shipped WITHOUT embed-host's H2 identity guards. Mock `electron` so we can
// drive the fork/exit/timeout races deterministically without spawning a child.
// Simpler than embed-host: no idle timer, and parse-host touches no `app`.

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
  utilityProcess: { fork: (...a: unknown[]) => forkFn(...a) },
}))

type HostMod = typeof import('./parse-host')
let host: HostMod

/** Kick a parse request; swallow rejection so fake-timer rejects don't leak. */
function parse(host: HostMod, file = '/tmp/x.epub'): Promise<unknown> {
  const p = host.parseEpub(file)
  p.catch(() => {})
  return p
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  forked.length = 0
  forkFn.mockClear()
  host = await import('./parse-host')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('parse-host worker lifecycle (T1-1 race guards)', () => {
  it('forks lazily on first request and reuses the same worker', () => {
    parse(host)
    parse(host)
    expect(forkFn).toHaveBeenCalledTimes(1)
  })

  it('a superseded worker’s late exit does not clobber the respawned worker', async () => {
    // Request 1 forks worker A.
    const p1 = parse(host, '/a.epub')
    const a = forked[0]
    expect(forkFn).toHaveBeenCalledTimes(1)

    // A wedges: its request times out (120 s), which kills A and nulls the ref.
    await vi.advanceTimersByTimeAsync(120_000)
    await expect(p1).rejects.toThrow(/timed out/)
    expect(a.kill).toHaveBeenCalled()

    // Request 2 forks a fresh worker B.
    const p2 = parse(host, '/b.epub')
    const b = forked[1]
    expect(forkFn).toHaveBeenCalledTimes(2)

    // A finally emits its (now stale) exit. It must NOT null B or reject p2.
    a.emit('exit', 0)

    // B is still the live worker: another request reuses it (no 3rd fork)…
    parse(host, '/c.epub')
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
    b.emit('message', { id: 2, ok: true, result: { title: 'Parsed', chapters: [] } })
    await expect(p2).resolves.toMatchObject({ title: 'Parsed' })
  })

  it('a stale request timeout does not kill the current worker', async () => {
    // Two concurrent requests on worker A, staggered so their timeouts differ.
    const p1 = parse(host, '/a.epub') // T1 fires at t=120_000
    const a = forked[0]
    await vi.advanceTimersByTimeAsync(20_000)
    const p2 = parse(host, '/b.epub') // T2 fires at t=140_000
    expect(forkFn).toHaveBeenCalledTimes(1)

    // t=120_000: req1 times out → recycles A (kill + null ref).
    await vi.advanceTimersByTimeAsync(100_000)
    await expect(p1).rejects.toThrow(/timed out/)
    expect(a.kill).toHaveBeenCalledTimes(1)

    // A new request forks worker B before req2's timer fires.
    parse(host, '/c.epub')
    const b = forked[1]
    expect(forkFn).toHaveBeenCalledTimes(2)

    // t=140_000: req2's stale timeout fires. Its worker (A) is no longer current,
    // so the guard must leave B untouched (the second clobber path).
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(p2).rejects.toThrow(/timed out/)
    expect(b.kill).not.toHaveBeenCalled()
    // B is still live: reused, not re-forked.
    parse(host, '/d.epub')
    expect(forkFn).toHaveBeenCalledTimes(2)
  })

  it('a current worker’s crash still rejects everything in flight', async () => {
    const p1 = parse(host, '/a.epub')
    const a = forked[0]
    a.emit('exit', 1) // A is the current worker → normal crash cleanup
    await expect(p1).rejects.toThrow(/exited \(code 1\)/)
    // Next request recovers by forking a fresh worker.
    parse(host, '/b.epub')
    expect(forkFn).toHaveBeenCalledTimes(2)
  })
})
