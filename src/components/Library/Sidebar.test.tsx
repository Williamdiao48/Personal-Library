import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Sidebar from './Sidebar'
import type { CaptureJob, Collection } from '../../types'

const updaterState = vi.hoisted(() => ({ pendingVersion: null as string | null }))
vi.mock('../../contexts/UpdaterContext', () => ({
  useUpdater: () => ({ pendingVersion: updaterState.pendingVersion, setPendingVersion: vi.fn() }),
}))

const settingsState = vi.hoisted(() => ({ enableDiscover: true }))
vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ settings: { enableDiscover: settingsState.enableDiscover } }),
}))

function mgmt(over: Partial<React.ComponentProps<typeof Sidebar>['collectionMgmt']> = {}) {
  return {
    collections: [] as Collection[],
    itemCounts: {} as Record<string, number>,
    onCreate: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

function renderSidebar(
  over: Partial<React.ComponentProps<typeof Sidebar>> = {},
  initialEntries: string[] = ['/'],
) {
  const props = {
    collectionMgmt: mgmt(),
    captureJobs: [] as CaptureJob[],
    onDismissJob: vi.fn(),
    trashedCount: 0,
    ...over,
  }
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <Sidebar {...props} />
    </MemoryRouter>,
  )
  return props
}

const col = (over: Partial<Collection> = {}): Collection =>
  ({ id: 'c1', name: 'Sci-Fi', created_at: 0, ...over }) as Collection

const runningJob = (over: Partial<CaptureJob> = {}): CaptureJob => ({
  id: 'j1',
  url: 'https://example.com/story/chapter-1',
  status: 'running',
  msg: 'Fetching chapter 2…',
  chapter: 2,
  total: 5,
  startedAt: Date.now(),
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  updaterState.pendingVersion = null
  settingsState.enableDiscover = true
})

describe('Sidebar — navigation', () => {
  it('marks All Items active at the root route', () => {
    renderSidebar()
    expect(screen.getByRole('link', { name: 'All Items' }).className).toContain('active')
  })

  it('marks the filter link active from the query string', () => {
    renderSidebar({}, ['/?filter=unread'])
    expect(screen.getByRole('link', { name: 'Unread' }).className).toContain('active')
    expect(screen.getByRole('link', { name: 'All Items' }).className).not.toContain('active')
  })

  it('marks Manage Tags active on the tags route', () => {
    renderSidebar({}, ['/tags'])
    expect(screen.getByRole('link', { name: 'Manage Tags' }).className).toContain('active')
  })

  it('marks Authors active on the authors route', () => {
    renderSidebar({}, ['/authors'])
    const authors = screen.getByRole('link', { name: 'Authors' })
    expect(authors).toHaveAttribute('href', '/authors')
    expect(authors.className).toContain('active')
  })

  it('shows the Discover nav entry when the setting is enabled', () => {
    renderSidebar()
    expect(screen.getByRole('link', { name: 'Discover' })).toHaveAttribute('href', '/discover')
  })

  it('hides the Discover nav entry when the setting is disabled', () => {
    settingsState.enableDiscover = false
    renderSidebar()
    expect(screen.queryByRole('link', { name: 'Discover' })).not.toBeInTheDocument()
  })
})

describe('Sidebar — collections CRUD', () => {
  it('renders collections with their item counts', () => {
    renderSidebar({ collectionMgmt: mgmt({ collections: [col()], itemCounts: { c1: 3 } }) })
    expect(screen.getByText('Sci-Fi')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('shows an empty state when there are no collections', () => {
    renderSidebar()
    expect(screen.getByText('No collections yet')).toBeInTheDocument()
  })

  it('creates a collection from the + input on blur', async () => {
    const cm = mgmt()
    renderSidebar({ collectionMgmt: cm })
    fireEvent.click(screen.getByTitle('New collection'))
    const input = screen.getByPlaceholderText('Collection name…')
    fireEvent.change(input, { target: { value: 'Fantasy' } })
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(cm.onCreate).toHaveBeenCalledWith('Fantasy')
  })

  it('surfaces an error when creation fails', async () => {
    const cm = mgmt({ onCreate: vi.fn().mockRejectedValue(new Error('nope')) })
    renderSidebar({ collectionMgmt: cm })
    fireEvent.click(screen.getByTitle('New collection'))
    const input = screen.getByPlaceholderText('Collection name…')
    fireEvent.change(input, { target: { value: 'Fantasy' } })
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(screen.getByText('Failed to create collection.')).toBeInTheDocument()
  })

  it('renames a collection via the context menu', async () => {
    const cm = mgmt({ collections: [col()] })
    renderSidebar({ collectionMgmt: cm })
    fireEvent.contextMenu(screen.getByText('Sci-Fi').closest('.sidebar-collection-row')!)
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByDisplayValue('Sci-Fi')
    fireEvent.change(input, { target: { value: 'Fantasy' } })
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(cm.onRename).toHaveBeenCalledWith('c1', 'Fantasy')
  })

  it('does not rename when the name is unchanged', async () => {
    const cm = mgmt({ collections: [col()] })
    renderSidebar({ collectionMgmt: cm })
    fireEvent.contextMenu(screen.getByText('Sci-Fi').closest('.sidebar-collection-row')!)
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await act(async () => {
      fireEvent.blur(screen.getByDisplayValue('Sci-Fi'))
    })
    expect(cm.onRename).not.toHaveBeenCalled()
  })

  it('deletes a collection through the confirm prompt', async () => {
    const cm = mgmt({ collections: [col()] })
    renderSidebar({ collectionMgmt: cm })
    fireEvent.contextMenu(screen.getByText('Sci-Fi').closest('.sidebar-collection-row')!)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText('Delete "Sci-Fi"?')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    })
    expect(cm.onDelete).toHaveBeenCalledWith('c1')
  })

  it('cancels a delete with No', () => {
    const cm = mgmt({ collections: [col()] })
    renderSidebar({ collectionMgmt: cm })
    fireEvent.contextMenu(screen.getByText('Sci-Fi').closest('.sidebar-collection-row')!)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(screen.queryByText('Delete "Sci-Fi"?')).toBeNull()
    expect(cm.onDelete).not.toHaveBeenCalled()
  })

  it('cancels new-collection input on Escape', () => {
    const cm = mgmt()
    renderSidebar({ collectionMgmt: cm })
    fireEvent.click(screen.getByTitle('New collection'))
    const input = screen.getByPlaceholderText('Collection name…')
    fireEvent.change(input, { target: { value: 'X' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Collection name…')).toBeNull()
    expect(cm.onCreate).not.toHaveBeenCalled()
  })

  it('cancels rename on Escape', () => {
    const cm = mgmt({ collections: [col()] })
    renderSidebar({ collectionMgmt: cm })
    fireEvent.contextMenu(screen.getByText('Sci-Fi').closest('.sidebar-collection-row')!)
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByDisplayValue('Sci-Fi')
    fireEvent.change(input, { target: { value: 'Y' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(cm.onRename).not.toHaveBeenCalled()
    expect(screen.getByText('Sci-Fi')).toBeInTheDocument()
  })

  it('closes the context menu on an outside click', () => {
    renderSidebar({ collectionMgmt: mgmt({ collections: [col()] }) })
    fireEvent.contextMenu(screen.getByText('Sci-Fi').closest('.sidebar-collection-row')!)
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
  })

  it('creates via the form submit (Enter)', async () => {
    const cm = mgmt()
    renderSidebar({ collectionMgmt: cm })
    fireEvent.click(screen.getByTitle('New collection'))
    const input = screen.getByPlaceholderText('Collection name…')
    fireEvent.change(input, { target: { value: 'Zed' } })
    await act(async () => {
      fireEvent.submit(input.closest('form')!)
    })
    expect(cm.onCreate).toHaveBeenCalledWith('Zed')
  })

  it('renames via the form submit (Enter)', async () => {
    const cm = mgmt({ collections: [col()] })
    renderSidebar({ collectionMgmt: cm })
    fireEvent.contextMenu(screen.getByText('Sci-Fi').closest('.sidebar-collection-row')!)
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByDisplayValue('Sci-Fi')
    fireEvent.change(input, { target: { value: 'Fantasy' } })
    await act(async () => {
      fireEvent.submit(input.closest('form')!)
    })
    expect(cm.onRename).toHaveBeenCalledWith('c1', 'Fantasy')
  })

  it('surfaces an error when delete fails', async () => {
    const cm = mgmt({ collections: [col()], onDelete: vi.fn().mockRejectedValue(new Error('x')) })
    renderSidebar({ collectionMgmt: cm })
    fireEvent.contextMenu(screen.getByText('Sci-Fi').closest('.sidebar-collection-row')!)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    })
    expect(screen.getByText('Failed to delete collection.')).toBeInTheDocument()
  })
})

describe('Sidebar — capture jobs', () => {
  it('renders a running job with its message, host, and chapter count', () => {
    renderSidebar({ captureJobs: [runningJob()] })
    expect(screen.getByText('Fetching chapter 2…')).toBeInTheDocument()
    expect(screen.getByText('2/5')).toBeInTheDocument()
    expect(screen.getByText(/example\.com/)).toBeInTheDocument()
  })

  it('renders a completed job and dismisses it', () => {
    const props = renderSidebar({
      captureJobs: [
        runningJob({ status: 'done', title: 'My Article', chapter: null, total: null }),
      ],
    })
    expect(screen.getByText('✓ My Article')).toBeInTheDocument()
    expect(screen.getByText('Saved to library')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(props.onDismissJob).toHaveBeenCalledWith('j1')
  })

  it('renders a failed job with its error message', () => {
    renderSidebar({
      captureJobs: [
        runningJob({ status: 'error', error: 'Blocked by site', chapter: null, total: null }),
      ],
    })
    expect(screen.getByText('Blocked by site')).toBeInTheDocument()
  })

  it('uses an indeterminate bar when a job has no chapter progress', () => {
    renderSidebar({ captureJobs: [runningJob({ chapter: null, total: null, msg: 'Starting…' })] })
    expect(document.querySelector('.capture-job-bar--indeterminate')).not.toBeNull()
  })

  it('pins the bar to 99% while a job is saving', () => {
    renderSidebar({
      captureJobs: [runningJob({ chapter: null, total: null, msg: 'Saving to library…' })],
    })
    const bar = document.querySelector('.capture-job-bar') as HTMLElement
    expect(bar.style.width).toBe('99%')
  })

  it('falls back to the raw string for an unparseable URL', () => {
    renderSidebar({ captureJobs: [runningJob({ url: 'not a url', chapter: null, total: null })] })
    expect(screen.getByText('not a url')).toBeInTheDocument()
  })

  it('ticks a live ETA for a running multi-chapter job', () => {
    vi.useFakeTimers()
    try {
      renderSidebar({ captureJobs: [runningJob({ startedAt: Date.now() - 10_000 })] })
      act(() => vi.advanceTimersByTime(1000))
      expect(document.querySelector('.capture-job-eta')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Sidebar — footer', () => {
  it('shows the trash count and the update button when a version is pending', () => {
    updaterState.pendingVersion = '9.9.9'
    renderSidebar({ trashedCount: 7 })
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Update to v9\.9\.9/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Reading stats' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
  })

  it('hides the update button when no version is pending', () => {
    renderSidebar()
    expect(screen.queryByRole('button', { name: /Update to/ })).toBeNull()
  })
})
