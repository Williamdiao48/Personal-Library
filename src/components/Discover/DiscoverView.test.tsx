import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import DiscoverView, { formatRelativeTime } from './DiscoverView'
import { discoverService } from '../../services/discover'
import { fireIntersection } from '../../../test/renderer/setup'
import type { Recommendation } from '../../types'

// The service layer + the toast context + the (heavy) capture modal are stubbed,
// so these tests exercise DiscoverView's own state machine: cached load, refresh
// flow (incl. cold start), dismiss, and opening the pre-filled Add modal.

vi.mock('../../services/discover', () => ({
  discoverService: {
    get: vi.fn(),
    refresh: vi.fn(),
    more: vi.fn(() => Promise.resolve({ cards: [] })),
    dismiss: vi.fn(() => Promise.resolve()),
    openExternal: vi.fn(() => Promise.resolve()),
  },
}))

const addToast = vi.fn(() => 'toast-1')
const updateToast = vi.fn()
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ addToast, updateToast, removeToast: vi.fn() }),
}))

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ settings: { enableDiscover: true } }),
}))

const startJob = vi.fn()
vi.mock('../../contexts/CaptureJobsContext', () => ({
  useCaptureJobs: () => ({ startJob, dismissJob: vi.fn(), captureJobs: [] }),
}))

// AddItemModal is heavy (capture/library services) — stub it to surface initialUrl
// and expose a save trigger so the "card disappears once added" flow is testable.
vi.mock('../Capture/AddItemModal', () => ({
  default: ({
    initialUrl,
    onClose,
    onSaved,
    onJobStarted,
  }: {
    initialUrl?: string
    onClose: () => void
    onSaved: (item: { title: string }) => void
    onJobStarted: (jobId: string, url: string) => void
  }) => (
    <div data-testid="add-modal">
      <span data-testid="modal-url">{initialUrl}</span>
      <button onClick={onClose}>close-modal</button>
      <button onClick={() => onSaved({ title: 'Saved Item' })}>save-modal</button>
      <button onClick={() => onJobStarted('job-1', initialUrl ?? '')}>job-modal</button>
    </div>
  ),
}))

const svc = vi.mocked(discoverService)

const rec = (over: Partial<Recommendation> = {}): Recommendation => ({
  title: 'A Fic',
  author: 'Ficcer',
  coverUrl: null,
  sourceId: 'https://ao3/works/1',
  source: 'ao3',
  url: 'https://ao3/works/1',
  subjects: ['Harry Potter'],
  matchedTags: ['Harry Potter'],
  score: 0.9,
  ...over,
})

const renderView = () =>
  render(
    <MemoryRouter>
      <DiscoverView />
    </MemoryRouter>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  svc.get.mockResolvedValue(null)
})

describe('formatRelativeTime', () => {
  it('bins the age into just now / m / h / d', () => {
    const now = 1_000_000_000_000
    expect(formatRelativeTime(now, now)).toBe('just now')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2d ago')
  })
})

describe('DiscoverView', () => {
  it('shows the cached snapshot on mount without running the engine', async () => {
    svc.get.mockResolvedValue({ cards: [rec({ title: 'Cached Fic' })], generatedAt: Date.now() })
    renderView()

    expect(await screen.findByText('Cached Fic')).toBeInTheDocument()
    expect(svc.refresh).not.toHaveBeenCalled()
    expect(screen.getByText(/picks/)).toBeInTheDocument() // freshness subtitle
  })

  it('refresh renders the returned grid and swaps the spinner toast to success', async () => {
    svc.refresh.mockResolvedValue({
      cards: [rec({ title: 'Fresh Fic' })],
      generatedAt: Date.now(),
      coldStart: false,
    })
    renderView()
    await waitFor(() => expect(screen.getByText('No recommendations yet')).toBeInTheDocument())

    await userEvent.setup().click(screen.getByRole('button', { name: /Find recommendations/ }))

    expect(await screen.findByText('Fresh Fic')).toBeInTheDocument()
    // First run (no cards yet) gets the cold-path expectation-setting copy.
    expect(addToast).toHaveBeenCalledWith(
      'Finding your first recommendations — this can take a moment…',
      'info',
    )
    expect(updateToast).toHaveBeenCalledWith('toast-1', 'Found 1 recommendations', 'success')
  })

  it('refresh passes the currently-shown card ids so the engine can rotate past them', async () => {
    svc.get.mockResolvedValue({
      cards: [
        rec({ title: 'Shown A', sourceId: 'id-a' }),
        rec({ title: 'Shown B', sourceId: 'id-b' }),
      ],
      generatedAt: Date.now(),
    })
    svc.refresh.mockResolvedValue({
      cards: [rec({ title: 'Rotated', sourceId: 'id-c' })],
      generatedAt: Date.now(),
      coldStart: false,
    })
    renderView()
    await screen.findByText('Shown A')

    // Header Refresh is present because there are cards; it forwards their ids.
    await userEvent.setup().click(screen.getByRole('button', { name: /Refresh/ }))

    expect(svc.refresh).toHaveBeenCalledWith(['id-a', 'id-b'])
    expect(await screen.findByText('Rotated')).toBeInTheDocument()
  })

  it('shows skeleton cards while a cold first refresh is in flight', async () => {
    // A refresh that never resolves during the test — the grid should fill with
    // shimmer placeholders instead of sitting on the empty state.
    let release!: (v: { cards: Recommendation[]; generatedAt: number; coldStart: boolean }) => void
    svc.refresh.mockReturnValue(
      new Promise((r) => {
        release = r
      }),
    )
    renderView()
    await waitFor(() => expect(screen.getByText('No recommendations yet')).toBeInTheDocument())

    await userEvent.setup().click(screen.getByRole('button', { name: /Find recommendations/ }))

    await waitFor(() =>
      expect(document.querySelectorAll('.rec-card--skeleton').length).toBeGreaterThan(0),
    )
    expect(screen.queryByText('No recommendations yet')).not.toBeInTheDocument()

    // Let the refresh settle so the test doesn't leak a pending promise.
    release({ cards: [rec({ title: 'Fresh Fic' })], generatedAt: Date.now(), coldStart: false })
    expect(await screen.findByText('Fresh Fic')).toBeInTheDocument()
  })

  it('shows the cold-start message when the engine reports coldStart', async () => {
    svc.refresh.mockResolvedValue({ cards: [], generatedAt: Date.now(), coldStart: true })
    renderView()
    await waitFor(() => expect(screen.getByText('No recommendations yet')).toBeInTheDocument())

    await userEvent.setup().click(screen.getByRole('button', { name: /Find recommendations/ }))

    expect(await screen.findByText('Discover is learning your taste')).toBeInTheDocument()
  })

  it('dismiss removes the card and tells the engine to exclude it', async () => {
    svc.get.mockResolvedValue({ cards: [rec({ title: 'Doomed Fic' })], generatedAt: Date.now() })
    renderView()
    await screen.findByText('Doomed Fic')

    await userEvent.setup().click(screen.getByText('Not interested'))

    await waitFor(() => expect(screen.queryByText('Doomed Fic')).not.toBeInTheDocument())
    expect(svc.dismiss).toHaveBeenCalledWith(expect.objectContaining({ title: 'Doomed Fic' }))
  })

  it('Add to Library opens the capture modal pre-filled with the card URL', async () => {
    svc.get.mockResolvedValue({
      cards: [rec({ title: 'Add Me', url: 'https://ao3/works/42' })],
      generatedAt: Date.now(),
    })
    renderView()
    await screen.findByText('Add Me')

    await userEvent.setup().click(screen.getByText('+ Add to Library'))

    expect(screen.getByTestId('add-modal')).toBeInTheDocument()
    expect(screen.getByTestId('modal-url')).toHaveTextContent('https://ao3/works/42')
  })

  it('drops a card from the feed once it has been added to the library', async () => {
    svc.get.mockResolvedValue({
      cards: [
        rec({ title: 'Add Me', sourceId: 'id-add' }),
        rec({ title: 'Keep Me', sourceId: 'id-keep' }),
      ],
      generatedAt: Date.now(),
    })
    renderView()
    await screen.findByText('Add Me')

    const user = userEvent.setup()
    await user.click(screen.getAllByText('+ Add to Library')[0]) // "Add Me" is first
    await user.click(screen.getByText('save-modal'))

    await waitFor(() => expect(screen.queryByText('Add Me')).not.toBeInTheDocument())
    expect(screen.getByText('Keep Me')).toBeInTheDocument()
  })

  it('tracks the capture job globally and drops the card when a capture job starts', async () => {
    svc.get.mockResolvedValue({
      cards: [
        rec({ title: 'Add Me', sourceId: 'id-add', url: 'https://ao3/works/add' }),
        rec({ title: 'Keep Me', sourceId: 'id-keep' }),
      ],
      generatedAt: Date.now(),
    })
    renderView()
    await screen.findByText('Add Me')

    const user = userEvent.setup()
    await user.click(screen.getAllByText('+ Add to Library')[0])
    await user.click(screen.getByText('job-modal'))

    // The job is handed to the global tracker (sidebar), not owned by Discover.
    expect(startJob).toHaveBeenCalledWith('job-1', 'https://ao3/works/add')
    await waitFor(() => expect(screen.queryByText('Add Me')).not.toBeInTheDocument())
    expect(screen.getByText('Keep Me')).toBeInTheDocument()
  })

  // N distinct cards for the infinite-scroll tests.
  const recs = (n: number, from = 1) =>
    Array.from({ length: n }, (_, i) =>
      rec({ title: `Fic ${from + i}`, sourceId: `id-${from + i}`, url: `https://ao3/${from + i}` }),
    )

  it('reveals more of the loaded pool a page at a time as the sentinel scrolls in', async () => {
    svc.get.mockResolvedValue({ cards: recs(15), generatedAt: Date.now() })
    renderView()
    await screen.findByText('Fic 1')

    // First page = 12 cards; the 13th–15th are loaded but not yet rendered.
    expect(screen.queryByText('Fic 13')).not.toBeInTheDocument()

    await act(async () => fireIntersection())

    expect(await screen.findByText('Fic 15')).toBeInTheDocument()
    expect(svc.more).not.toHaveBeenCalled() // still local — no engine call
  })

  it('auto-loads the next page (excluding shown ids) once the pool is on screen', async () => {
    svc.get.mockResolvedValue({ cards: recs(2), generatedAt: Date.now() })
    svc.more.mockResolvedValue({ cards: recs(1, 3) }) // one genuinely-new card
    renderView()
    await screen.findByText('Fic 1')

    await act(async () => fireIntersection())

    expect(await screen.findByText('Fic 3')).toBeInTheDocument()
    expect(svc.more).toHaveBeenCalledWith(['id-1', 'id-2'])
  })

  it('shows "all caught up" and stops when load-more returns nothing new', async () => {
    svc.get.mockResolvedValue({ cards: recs(2), generatedAt: Date.now() })
    svc.more.mockResolvedValue({ cards: [] })
    renderView()
    await screen.findByText('Fic 1')

    await act(async () => fireIntersection())

    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument()

    // A further sentinel hit must NOT fire another engine call (exhausted latch).
    await act(async () => fireIntersection())
    expect(svc.more).toHaveBeenCalledTimes(1)
  })

  it('shows the loading indicator while the next page is in flight', async () => {
    svc.get.mockResolvedValue({ cards: recs(2), generatedAt: Date.now() })
    let resolveMore!: (v: { cards: Recommendation[] }) => void
    svc.more.mockReturnValue(new Promise((r) => (resolveMore = r)))
    renderView()
    await screen.findByText('Fic 1')

    await act(async () => fireIntersection())

    // While more() is pending, the indicator is visible…
    expect(await screen.findByText(/finding more/i)).toBeInTheDocument()

    // …and it clears once the page resolves.
    await act(async () => resolveMore({ cards: recs(1, 3) }))
    await waitFor(() => expect(screen.queryByText(/finding more/i)).not.toBeInTheDocument())
  })
})
