import { useEffect, useRef, useCallback } from 'react'
import { statsService } from '../services/stats'

// If a user hasn't scrolled / flipped a page for this long, treat
// the gap as idle time and start a fresh session segment when they
// resume reading.
const IDLE_TIMEOUT_MS = 10 * 60 * 1_000  // 10 minutes

// Short grace period added after the last recorded activity.
// Accounts for the few seconds between the final scroll and when
// the user actually stops — without inflating stats with idle time.
const IDLE_GRACE_MS   = 60 * 1_000       // 1 minute

const SESSION_MIN_MS  = 5_000             // discard sessions shorter than this

/**
 * Tracks active reading time for an item.
 *
 * Returns `recordActivity` — call it on every scroll event, page turn,
 * or chapter change to signal that the user is actively reading.
 *
 * Behaviour:
 * - Session ends at `lastActivity + IDLE_GRACE` — idle time is never counted.
 * - If activity resumes after > IDLE_TIMEOUT, the stale segment is flushed
 *   and a fresh one begins automatically (no manual timer needed).
 * - Also flushes on unmount (navigate away) and on `visibilitychange` hidden
 *   (app minimised / window hidden).
 */
export function useReadingSession(itemId: string): { recordActivity: () => void } {
  const sessionStartRef = useRef(Date.now())
  const lastActivityRef = useRef<number | null>(null)

  // flush: record the current segment and reset state.
  // Safe to call multiple times — a null lastActivity is a no-op.
  const flush = useCallback(() => {
    const lastActivity = lastActivityRef.current
    if (lastActivity === null) return

    const sessionStart = sessionStartRef.current
    const endTime      = Math.min(lastActivity + IDLE_GRACE_MS, Date.now())
    const duration     = endTime - sessionStart

    if (duration >= SESSION_MIN_MS) {
      statsService.recordSession(itemId, sessionStart, endTime).catch(() => {})
    }

    lastActivityRef.current  = null
    sessionStartRef.current  = Date.now()
  }, [itemId])

  // recordActivity: called by the reader on each meaningful interaction.
  // If the user was idle for > IDLE_TIMEOUT, the old segment is flushed
  // before the new one starts.
  const recordActivity = useCallback(() => {
    const now          = Date.now()
    const lastActivity = lastActivityRef.current

    if (lastActivity !== null && now - lastActivity > IDLE_TIMEOUT_MS) {
      // User returned after a long idle gap — close the old segment first.
      flush()
      sessionStartRef.current = now
    }

    lastActivityRef.current = now
  }, [flush])

  useEffect(() => {
    sessionStartRef.current = Date.now()
    lastActivityRef.current = null

    function handleVisibilityChange() {
      if (document.hidden) {
        flush()
      } else {
        // Fresh segment when the user returns to the app.
        sessionStartRef.current = Date.now()
        lastActivityRef.current = null
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (!document.hidden) flush()
    }
  }, [flush])

  return { recordActivity }
}
