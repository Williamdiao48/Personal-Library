// Tracks in-flight worker requests by id and correlates responses back to their
// promises. Pure and Electron-free on purpose so it can be unit-tested without
// spawning a real utilityProcess (the *-host.ts modules own the process). Shared
// by every utilityProcess host (parse-worker, embed-worker): a response just
// needs an `id` and an ok/result-or-error shape.

/** The minimal response shape any worker host settles a request with. */
export type WorkerResponse =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class PendingRegistry {
  private pending = new Map<number, Pending>()
  private seq = 0

  /**
   * Register a new request. Returns its id and a promise that settles when a
   * matching response arrives, or rejects after `timeoutMs`. `onTimeout` fires
   * on expiry so the caller can recycle a wedged worker.
   */
  create<T>(
    timeoutMs: number,
    onTimeout: (id: number) => void,
  ): { id: number; promise: Promise<T> } {
    const id = ++this.seq
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Worker request timed out after ${timeoutMs}ms`))
        onTimeout(id)
      }, timeoutMs)
      // Don't let a pending parse timer keep the process alive on shutdown.
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        ;(timer as { unref: () => void }).unref()
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    })
    return { id, promise }
  }

  /** Settle the request matching a worker response. Unknown ids are ignored. */
  settle(res: WorkerResponse): void {
    const p = this.pending.get(res.id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(res.id)
    if (res.ok) p.resolve(res.result)
    else p.reject(new Error(res.error))
  }

  /** Reject every in-flight request — used when the worker crashes or quits. */
  rejectAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  get size(): number {
    return this.pending.size
  }
}
