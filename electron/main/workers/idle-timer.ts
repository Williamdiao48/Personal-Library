// A one-shot idle countdown for a lazily-forked worker. Electron-free and pure
// (like pending-registry.ts) so it can be unit-tested without spawning a real
// utilityProcess. The owning *-host module calls `cancel()` when a request
// starts (and on worker exit / app quit) and `schedule()` after a request
// settles; when the countdown elapses with the host still idle (`isIdle()`), it
// fires `onIdle()` — typically to kill the child and release the model's memory.

export interface IdleTimer {
  /** Arm (or re-arm) the countdown. Fires `onIdle()` after `delayMs` iff `isIdle()` still holds. */
  schedule(): void
  /** Stop a pending countdown (a request started, or the worker is already gone). */
  cancel(): void
}

export function createIdleTimer(
  delayMs: number,
  isIdle: () => boolean,
  onIdle: () => void,
): IdleTimer {
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const schedule = (): void => {
    cancel()
    timer = setTimeout(() => {
      timer = null
      // Guard against a request that arrived between arming and firing.
      if (isIdle()) onIdle()
    }, delayMs)
    // Don't let an idle countdown keep the process alive at quit.
    ;(timer as { unref?: () => void }).unref?.()
  }

  return { schedule, cancel }
}
