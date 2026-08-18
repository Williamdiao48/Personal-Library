import { useCallback, useEffect, useRef, useState } from 'react'
import { syncService } from '../services/sync'
import { cloudService } from '../services/cloud'
import type { SyncStatus } from '../types'
import '../styles/sync-status-pill.css'

type Tone = 'busy' | 'error' | 'idle'
interface Pill {
  tone: Tone
  label: string
  tooltip: string
}

// How long the "✓ Backed up" confirmation flashes after an upload finishes.
const BACKED_UP_FLASH_MS = 4000

/**
 * Ambient sync/backup status — a small display-only pill in the bottom-right corner.
 *
 * Backup states lead (the expensive, user-initiated book-file uploads), then
 * metadata-sync states. Precedence, highest first:
 *   • Backing up N…       — book files uploading (capture-with-backup / "Back up to cloud")
 *   • Backup failed       — a real blob upload error (retry on the item's card)
 *   • Retrying in … (N)   — the metadata sync round is in a backoff retry loop (a live
 *                           countdown to the next attempt + the failure streak)
 *   • Syncing N…          — N local changes are queued to push to the other devices
 *   • ✓ Backed up         — flashes only when an upload actually finishes, then auto-hides
 *   • otherwise hidden
 *
 * The metadata states were once deliberately suppressed (ordinary edits sync
 * constantly, so a permanent "Syncing…" was noise). They're surfaced now for
 * observability, kept quiet by precedence: pending "Syncing N…" is the LOWEST active
 * state and its window is short (a debounced round clears dirty in seconds), and the
 * retry state only appears once a round has actually failed — the idle case is still
 * silent (null).
 *
 * Backup counts come from the authoritative `cloud:getBackupCounts`, refetched on every
 * `cloud:blobState` AND `sync:status` event so a missed event self-corrects; the
 * pending/retry fields ride the `SyncStatus` stream. Hidden unless sync is enabled AND
 * signed in. Display-only: the fix for a failed backup lives on the item's card, so the
 * pill points there via its tooltip, not a click.
 */
export default function SyncStatusPill(): React.ReactElement | null {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [counts, setCounts] = useState<{ pending: number; error: number }>({ pending: 0, error: 0 })
  const [flashBackedUp, setFlashBackedUp] = useState(false)
  const prevPending = useRef(0)

  const refetchCounts = useCallback(() => {
    cloudService.getBackupCounts().then(setCounts, () => {})
  }, [])

  // Hydrate on mount + stream live status. Refetch counts on each status change too:
  // a round (or the poll) is a reliable heartbeat that re-syncs the tally even if a
  // blob-state event was missed, so a stale count self-corrects.
  useEffect(() => {
    syncService.getStatus().then(setStatus, () => {})
    const off = syncService.onStatus((s) => {
      setStatus(s)
      refetchCounts()
    })
    return off
  }, [refetchCounts])

  // Hydrate counts + refetch on every blob-state change (start/finish/fail).
  useEffect(() => {
    refetchCounts()
    const off = cloudService.onBlobState(refetchCounts)
    return off
  }, [refetchCounts])

  // Flash "✓ Backed up" only when the LAST pending upload clears (a real completion),
  // never for the constant background metadata rounds.
  useEffect(() => {
    const wasBackingUp = prevPending.current > 0
    prevPending.current = counts.pending
    if (wasBackingUp && counts.pending === 0 && counts.error === 0) {
      setFlashBackedUp(true)
      const t = setTimeout(() => setFlashBackedUp(false), BACKED_UP_FLASH_MS)
      return () => clearTimeout(t)
    }
    return undefined
  }, [counts.pending, counts.error])

  // While in the retry-backoff state, tick every second so the "Retrying in …"
  // countdown stays live between the (minutes-apart) status broadcasts.
  const failing = (status?.consecutiveFailures ?? 0) > 0
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!failing) return
    const t = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [failing])

  if (!status || !status.enabled || !status.signedIn) return null

  const pill = derivePill(status, counts, flashBackedUp)
  if (!pill) return null

  return (
    <div
      className={`sync-status-pill sync-status-pill--${pill.tone}`}
      title={pill.tooltip}
      role="status"
    >
      <span className="sync-status-pill__dot" aria-hidden="true" />
      <span className="sync-status-pill__label">{pill.label}</span>
    </div>
  )
}

/** Compact forward countdown for the retry label: "in 45s" / "in 6 min" / "soon". */
function untilLabel(ms: number, now: number): string {
  const secs = Math.round((ms - now) / 1000)
  if (secs <= 0) return 'soon'
  if (secs < 60) return `in ${secs}s`
  return `in ${Math.round(secs / 60)} min`
}

/** Pure state-precedence, backup-first then metadata-sync. Returns null when there's
 *  nothing worth showing (the common idle case). `now` is injectable for tests.
 *  Exported for tests. */
export function derivePill(
  status: SyncStatus,
  counts: { pending: number; error: number },
  flashBackedUp: boolean,
  now: number = Date.now(),
): Pill | null {
  if (counts.pending > 0) {
    return {
      tone: 'busy',
      label: `Backing up ${counts.pending}…`,
      tooltip: 'Uploading book files to cloud backup',
    }
  }
  if (counts.error > 0) {
    const n = counts.error
    return {
      tone: 'error',
      label: 'Backup failed',
      tooltip: `${n} backup${n > 1 ? 's' : ''} failed — open the item to retry`,
    }
  }
  if (status.consecutiveFailures > 0) {
    const n = status.consecutiveFailures
    const when = status.nextRetryAt != null ? ` ${untilLabel(status.nextRetryAt, now)}` : ''
    return {
      tone: 'error',
      label: `Retrying${when} (${n} failed)`,
      tooltip: status.lastError
        ? `Last sync failed: ${status.lastError} — retrying automatically`
        : 'Sync is retrying automatically',
    }
  }
  if (status.pendingDirty > 0) {
    return {
      tone: 'busy',
      label: `Syncing ${status.pendingDirty}…`,
      tooltip: 'Syncing your changes to your other devices',
    }
  }
  if (flashBackedUp) {
    return { tone: 'idle', label: 'Backed up', tooltip: 'Your books are backed up' }
  }
  return null
}
