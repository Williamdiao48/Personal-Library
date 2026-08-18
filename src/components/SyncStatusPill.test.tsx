import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import SyncStatusPill, { derivePill } from './SyncStatusPill'
import { syncService } from '../services/sync'
import { cloudService } from '../services/cloud'
import type { SyncStatus } from '../types'

// The pill leads with blob-backup counts, then surfaces metadata-sync state (a retry
// backoff, or queued "Syncing N…"), and stays silent when idle. Unit-test the pure
// `derivePill` precedence, then render tests for the visibility gate + the "silent on a
// plain, caught-up sync round" guarantee + the completion flash.

vi.mock('../services/sync', () => ({
  syncService: { getStatus: vi.fn(), onStatus: vi.fn(() => () => {}) },
}))
vi.mock('../services/cloud', () => ({
  cloudService: { getBackupCounts: vi.fn(), onBlobState: vi.fn(() => () => {}) },
}))

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  enabled: true,
  configured: true,
  signedIn: true,
  running: false,
  lastSyncedAt: null,
  lastError: null,
  pendingDirty: 0,
  consecutiveFailures: 0,
  nextRetryAt: null,
  ...over,
})

describe('derivePill precedence', () => {
  it('active backup outranks everything (pending > 0)', () => {
    const p = derivePill(status({ running: true, lastError: 'x' }), { pending: 2, error: 3 }, true)
    expect(p).toMatchObject({ tone: 'busy', label: 'Backing up 2…' })
  })

  it('failed backups surface with a retry hint (pluralized)', () => {
    expect(derivePill(status(), { pending: 0, error: 1 }, false)).toMatchObject({
      tone: 'error',
      label: 'Backup failed',
      tooltip: '1 backup failed — open the item to retry',
    })
    expect(derivePill(status(), { pending: 0, error: 2 }, false)?.tooltip).toBe(
      '2 backups failed — open the item to retry',
    )
  })

  it('a retry-backoff state shows a live countdown + failure streak', () => {
    const p = derivePill(
      status({ consecutiveFailures: 4, nextRetryAt: 360_000, lastError: 'PostgREST down' }),
      { pending: 0, error: 0 },
      false,
      0, // fixed now → deterministic countdown
    )
    expect(p).toMatchObject({
      tone: 'error',
      label: 'Retrying in 6 min (4 failed)',
      tooltip: 'Last sync failed: PostgREST down — retrying automatically',
    })
  })

  it('retry outranks pending, and pending shows "Syncing N…" on its own', () => {
    // A failure streak wins over queued changes…
    expect(
      derivePill(
        status({ consecutiveFailures: 1, pendingDirty: 3 }),
        { pending: 0, error: 0 },
        false,
      )?.label,
    ).toMatch(/^Retrying/)
    // …but with no error, queued changes surface as the lowest active state.
    expect(derivePill(status({ pendingDirty: 3 }), { pending: 0, error: 0 }, false)).toMatchObject({
      tone: 'busy',
      label: 'Syncing 3…',
    })
  })

  it('backup states still outrank the metadata-sync states', () => {
    // A blob upload in flight wins even while sync is also failing/pending.
    expect(
      derivePill(
        status({ consecutiveFailures: 2, pendingDirty: 5 }),
        { pending: 1, error: 0 },
        false,
      )?.label,
    ).toBe('Backing up 1…')
  })

  it('flashes "Backed up" only when signalled (upload just finished)', () => {
    expect(derivePill(status(), { pending: 0, error: 0 }, true)).toMatchObject({
      tone: 'idle',
      label: 'Backed up',
    })
  })

  it('is SILENT (null) for an ordinary sync round — running alone shows nothing', () => {
    // The anti-noise guarantee: reading progress / ratings trigger rounds, and none
    // of that should surface. No blobs, no error, no flash → nothing to show.
    expect(
      derivePill(
        status({ running: true, lastSyncedAt: Date.now() }),
        { pending: 0, error: 0 },
        false,
      ),
    ).toBeNull()
  })
})

describe('SyncStatusPill rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(syncService.onStatus).mockReturnValue(() => {})
    vi.mocked(cloudService.onBlobState).mockReturnValue(() => {})
    vi.mocked(cloudService.getBackupCounts).mockResolvedValue({ pending: 0, error: 0 })
  })

  it('renders nothing when sync is disabled', async () => {
    vi.mocked(syncService.getStatus).mockResolvedValue(status({ enabled: false }))
    render(<SyncStatusPill />)
    await waitFor(() => expect(cloudService.getBackupCounts).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders nothing when signed out', async () => {
    vi.mocked(syncService.getStatus).mockResolvedValue(status({ signedIn: false }))
    render(<SyncStatusPill />)
    await waitFor(() => expect(cloudService.getBackupCounts).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('stays hidden during a plain metadata sync round (no blob activity)', async () => {
    vi.mocked(syncService.getStatus).mockResolvedValue(status({ running: true }))
    render(<SyncStatusPill />)
    await waitFor(() => expect(cloudService.getBackupCounts).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows the backup label when book files are uploading', async () => {
    vi.mocked(syncService.getStatus).mockResolvedValue(status())
    vi.mocked(cloudService.getBackupCounts).mockResolvedValue({ pending: 3, error: 0 })
    render(<SyncStatusPill />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Backing up 3…'))
  })

  it('flashes "Backed up" when the last upload finishes, then auto-hides', async () => {
    let blobCb: (() => void) | undefined
    vi.mocked(cloudService.onBlobState).mockImplementation((cb) => {
      blobCb = cb as unknown as () => void
      return () => {}
    })
    let backupCounts = { pending: 1, error: 0 }
    vi.mocked(cloudService.getBackupCounts).mockImplementation(async () => backupCounts)
    vi.mocked(syncService.getStatus).mockResolvedValue(status())

    vi.useFakeTimers()
    try {
      render(<SyncStatusPill />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByRole('status')).toHaveTextContent('Backing up 1…')

      // Upload completes → a blob event refetches counts → pending clears → flash.
      backupCounts = { pending: 0, error: 0 }
      await act(async () => {
        blobCb?.()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByRole('status')).toHaveTextContent('Backed up')

      // …then the confirmation fades after its TTL.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4001)
      })
      expect(screen.queryByRole('status')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
