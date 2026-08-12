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
 * Ambient **backup** status — a small display-only pill in the bottom-right corner.
 *
 * Deliberately a *backup* indicator, NOT a metadata-sync indicator: ordinary edits
 * (reading progress, ratings, scroll position) all trigger sync rounds, so surfacing
 * "Syncing…" for them is pure noise. The meaningful, expensive cloud operation is
 * uploading book **files** (`blob_sync`), so the pill keys on that:
 *   • Backing up N…  — book files uploading (capture-with-backup / "Back up to cloud")
 *   • Backup failed  — a real blob upload error (retry on the item's card)
 *   • ✓ Backed up    — flashes only when an upload actually finishes, then auto-hides
 *   • Sync issue     — a genuine sync-round failure (rare; real signal, kept)
 *   • otherwise hidden
 *
 * Counts come from the authoritative `cloud:getBackupCounts`, refetched on every
 * `cloud:blobState` AND `sync:status` event so a missed event self-corrects. Hidden
 * unless sync is enabled AND signed in. Display-only: the fix for a failed backup
 * lives on the item's card, so the pill points there via its tooltip, not a click.
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

/** Pure state-precedence, backup-first. Returns null when there's nothing worth
 *  showing (the common case — ordinary metadata sync is intentionally silent).
 *  Exported for tests. */
export function derivePill(
  status: SyncStatus,
  counts: { pending: number; error: number },
  flashBackedUp: boolean,
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
  if (status.lastError) {
    return { tone: 'error', label: 'Sync issue', tooltip: `Last sync failed: ${status.lastError}` }
  }
  if (flashBackedUp) {
    return { tone: 'idle', label: 'Backed up', tooltip: 'Your books are backed up' }
  }
  return null
}
