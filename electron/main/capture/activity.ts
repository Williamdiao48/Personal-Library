// ── Capture-activity counter (L3) ───────────────────────────────────────────
//
// A minimal in-flight counter for capture work (single capture, append, and bulk
// import). Its sole consumer is `backup:import`, which must NOT swap the DB file
// out from under a capture that's mid-write (`closeDb()` → overwrite → relaunch
// would strand or discard the write). Every capture entry point brackets its run
// with begin/end (try/finally), and import refuses while the count is non-zero.
//
// It is deliberately just an integer — not a job registry. It answers exactly one
// question ("is any capture running right now?") and nothing more; the reaper and
// sync engine keep their own independent guards.

let active = 0

/** Mark a capture as started. Pair with {@link endCaptureWork} in a `finally`. */
export function beginCaptureWork(): void {
  active++
}

/** Mark a capture as finished. Floors at 0 so an unbalanced extra call can't drive
 *  the count negative and wedge {@link captureWorkActive} true forever. */
export function endCaptureWork(): void {
  active = Math.max(0, active - 1)
}

/** True while any capture (single / append / bulk) is running. */
export function captureWorkActive(): boolean {
  return active > 0
}
