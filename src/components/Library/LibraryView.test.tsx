import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LibraryView from './LibraryView'
import { SettingsProvider } from '../../contexts/SettingsContext'
import { ToastProvider } from '../../contexts/ToastContext'
import { CaptureJobsProvider } from '../../contexts/CaptureJobsContext'
import type { Item } from '../../types'

// Virtualizer → render every row directly.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 280,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 280 })),
    measureElement: () => {},
  }),
}))

// Heavy children reduced to identifiable stubs. ItemCard surfaces the
// callbacks under test as buttons (the CollectionView.test.tsx pattern).
type CardProps = {
  item: Item
  onClick: (e: React.MouseEvent) => void
  onDelete: () => void
  onRatingChange: (r: number | null) => void
  onStatusChange: (s: string | null) => void
  onWriteReview: () => void
  onEditTags: () => void
  onEditCollections: () => void
}
vi.mock('./ItemCard', () => ({
  default: (p: CardProps) => (
    <div data-testid="card">
      <span data-testid="card-title">{p.item.title}</span>
      {/* Drives bulk selection: a synthetic shift-click into handleCardClick. */}
      <button
        onClick={() =>
          p.onClick({
            shiftKey: true,
            stopPropagation() {},
            preventDefault() {},
          } as unknown as React.MouseEvent)
        }
      >
        select-{p.item.title}
      </button>
      <button onClick={() => p.onDelete()}>del-{p.item.title}</button>
      <button onClick={() => p.onRatingChange(5)}>rate-{p.item.title}</button>
      <button onClick={() => p.onStatusChange('finished')}>status-{p.item.title}</button>
      <button onClick={() => p.onWriteReview()}>review-{p.item.title}</button>
      <button onClick={() => p.onEditTags()}>tags-{p.item.title}</button>
      <button onClick={() => p.onEditCollections()}>cols-{p.item.title}</button>
    </div>
  ),
}))
vi.mock('./Sidebar', () => ({ default: () => null }))
vi.mock('../Capture/AddItemModal', () => ({ default: () => <div>ADD MODAL</div> }))
vi.mock('../Capture/AppendModal', () => ({ default: () => null }))
vi.mock('./TagsModal', () => ({ default: () => <div>TAGS MODAL</div> }))
vi.mock('./CollectionsModal', () => ({ default: () => <div>COLLECTIONS MODAL</div> }))
vi.mock('./ReviewModal', () => ({ default: () => <div>REVIEW MODAL</div> }))

vi.mock('../../services/library', () => ({
  libraryService: {
    getAll: vi.fn(),
    getAllItemTags: vi.fn().mockResolvedValue([]),
    getTrashed: vi.fn().mockResolvedValue([]),
    softDelete: vi.fn().mockResolvedValue(undefined),
    setRating: vi.fn(),
    setStatus: vi.fn(),
  },
  tagService: {
    getAll: vi.fn().mockResolvedValue([]),
    setForItem: vi.fn().mockResolvedValue(undefined),
  },
  collectionService: {
    getAll: vi.fn().mockResolvedValue([]),
    getAllItemCollections: vi.fn().mockResolvedValue([]),
  },
}))
import { libraryService, tagService } from '../../services/library'
const lib = libraryService as unknown as Record<string, ReturnType<typeof vi.fn>>
const tagSvc = tagService as unknown as Record<string, ReturnType<typeof vi.fn>>

const mkItem = (over: Partial<Item> = {}): Item =>
  ({
    id: 'i1',
    title: 'Alpha',
    author: 'Ann',
    content_type: 'html',
    description: null,
    status: null,
    scroll_position: 0,
    word_count: 100,
    rating: null,
    cover_path: null,
    derived_from: null,
    ...over,
  }) as Item

function renderLibrary(initialEntries: string[] = ['/'], settings?: Record<string, unknown>) {
  if (settings) localStorage.setItem('app-settings', JSON.stringify(settings))
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <SettingsProvider>
        <ToastProvider>
          <CaptureJobsProvider>
            <LibraryView />
          </CaptureJobsProvider>
        </ToastProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

const cardTitles = () => screen.getAllByTestId('card-title').map((c) => c.textContent)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  ;(window as unknown as { api: unknown }).api = {
    onRequestCapture: vi.fn(() => () => {}),
    onCaptureProgress: vi.fn(() => () => {}),
    onCaptureComplete: vi.fn(() => () => {}),
    onCaptureError: vi.fn(() => () => {}),
  }
  lib.getAll.mockResolvedValue([])
})

describe('LibraryView — load states', () => {
  it('renders a card per item once loaded', async () => {
    lib.getAll.mockResolvedValue([mkItem(), mkItem({ id: 'i2', title: 'Beta' })])
    renderLibrary()
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('shows the empty state when there are no items', async () => {
    lib.getAll.mockResolvedValue([])
    renderLibrary()
    expect(await screen.findByText('Your library is empty')).toBeInTheDocument()
  })

  it('surfaces a load error', async () => {
    lib.getAll.mockRejectedValue(new Error('db locked'))
    renderLibrary()
    expect(await screen.findByText(/Failed to load library: db locked/)).toBeInTheDocument()
  })
})

describe('LibraryView — filtering', () => {
  const items = [
    mkItem({ id: 'i1', title: 'Unread One', status: 'unread', content_type: 'html' }),
    mkItem({ id: 'i2', title: 'Finished One', status: 'finished', content_type: 'pdf' }),
    mkItem({ id: 'i3', title: 'Reading One', scroll_position: 0.5, content_type: 'epub' }),
  ]

  it('filters by reading status from the URL', async () => {
    lib.getAll.mockResolvedValue(items)
    renderLibrary(['/?filter=finished'])
    expect(await screen.findByText('Finished One')).toBeInTheDocument()
    expect(screen.queryByText('Unread One')).toBeNull()
    expect(screen.queryByText('Reading One')).toBeNull()
  })

  it('filters by content type from the URL', async () => {
    lib.getAll.mockResolvedValue(items)
    renderLibrary(['/?type=pdf'])
    expect(await screen.findByText('Finished One')).toBeInTheDocument()
    expect(screen.queryByText('Unread One')).toBeNull()
  })

  it('filters by tag from the URL', async () => {
    lib.getAll.mockResolvedValue([
      mkItem({ id: 'i1', title: 'Tagged' }),
      mkItem({ id: 'i2', title: 'Untagged' }),
    ])
    lib.getAllItemTags.mockResolvedValue([
      { item_id: 'i1', tag_id: 't1', name: 'scifi', color: '#f00' },
    ])
    renderLibrary(['/?tag=t1'])
    expect(await screen.findByText('Tagged')).toBeInTheDocument()
    expect(screen.queryByText('Untagged')).toBeNull()
  })

  it('filters by author from the URL', async () => {
    lib.getAll.mockResolvedValue([
      mkItem({ id: 'i1', title: 'By Ann', author: 'Ann' }),
      mkItem({ id: 'i2', title: 'By Bob', author: 'Bob' }),
    ])
    renderLibrary(['/?author=Ann'])
    expect(await screen.findByText('By Ann')).toBeInTheDocument()
    expect(screen.queryByText('By Bob')).toBeNull()
  })

  it('filters by the debounced search query', async () => {
    lib.getAll.mockResolvedValue([
      mkItem({ id: 'i1', title: 'Dune' }),
      mkItem({ id: 'i2', title: 'Hyperion' }),
    ])
    renderLibrary()
    await screen.findByText('Dune')
    fireEvent.change(screen.getByPlaceholderText('Search title, author, tags…'), {
      target: { value: 'hyper' },
    })
    await waitFor(() => expect(screen.queryByText('Dune')).toBeNull())
    expect(screen.getByText('Hyperion')).toBeInTheDocument()
  })

  it('shows a no-match message when a filter excludes everything', async () => {
    lib.getAll.mockResolvedValue([mkItem({ status: 'finished' })])
    renderLibrary(['/?filter=unread'])
    expect(await screen.findByText('No items match this filter.')).toBeInTheDocument()
  })
})

describe('LibraryView — sorting & modal', () => {
  it('sorts by title when that is the default sort', async () => {
    lib.getAll.mockResolvedValue([
      mkItem({ id: 'i1', title: 'Zebra' }),
      mkItem({ id: 'i2', title: 'Apple' }),
    ])
    renderLibrary(['/'], { defaultSort: 'title' })
    await screen.findByText('Zebra')
    expect(cardTitles()).toEqual(['Apple', 'Zebra'])
  })

  it('opens the add-item modal', async () => {
    lib.getAll.mockResolvedValue([mkItem()])
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }))
    expect(screen.getByText('ADD MODAL')).toBeInTheDocument()
  })
})

describe('LibraryView — per-card actions', () => {
  beforeEach(() => lib.getAll.mockResolvedValue([mkItem({ id: 'i1', title: 'Alpha' })]))

  it('soft-deletes an item and removes its card', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('del-Alpha'))
    await waitFor(() => expect(lib.softDelete).toHaveBeenCalledWith('i1'))
    await waitFor(() => expect(screen.queryByText('Alpha')).toBeNull())
  })

  it('persists a rating change', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('rate-Alpha'))
    expect(lib.setRating).toHaveBeenCalledWith('i1', 5)
  })

  it('persists a status change', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('status-Alpha'))
    expect(lib.setStatus).toHaveBeenCalledWith('i1', 'finished')
  })

  it('opens the tags, collections, and review modals', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('tags-Alpha'))
    expect(screen.getByText('TAGS MODAL')).toBeInTheDocument()
    fireEvent.click(screen.getByText('cols-Alpha'))
    expect(screen.getByText('COLLECTIONS MODAL')).toBeInTheDocument()
    fireEvent.click(screen.getByText('review-Alpha'))
    expect(screen.getByText('REVIEW MODAL')).toBeInTheDocument()
  })
})

describe('LibraryView — bulk actions (PERF-2 / ROB-2)', () => {
  beforeEach(() => {
    lib.getAll.mockResolvedValue([mkItem({ id: 'i1', title: 'Alpha' })])
    // Reset the item→tag map explicitly: another test permanently overrides
    // getAllItemTags and clearAllMocks doesn't reset implementations, so without
    // this the selected item would already have the tag (→ the remove path).
    lib.getAllItemTags.mockResolvedValue([])
    tagSvc.getAll.mockResolvedValue([{ id: 't1', name: 'scifi', color: '#f00' }])
  })

  it('toasts on a partial failure and does not apply the tag locally', async () => {
    tagSvc.setForItem.mockRejectedValue(new Error('db is locked'))
    renderLibrary()
    await screen.findByText('Alpha')

    // Shift-select the card → the bulk action bar appears.
    fireEvent.click(screen.getByText('select-Alpha'))
    fireEvent.click(await screen.findByText('Tags')) // open the bulk tag popover
    fireEvent.click(await screen.findByRole('button', { name: 'scifi' }))

    // Promise.allSettled → 1 rejected → error toast; no throw, no silent success.
    expect(await screen.findByText(/Couldn't tag 1 of 1 item\./)).toBeInTheDocument()
    expect(tagSvc.setForItem).toHaveBeenCalledWith('i1', ['t1'])
  })

  it('applies the tag with no toast when the op succeeds', async () => {
    tagSvc.setForItem.mockResolvedValue(undefined)
    renderLibrary()
    await screen.findByText('Alpha')

    fireEvent.click(screen.getByText('select-Alpha'))
    fireEvent.click(await screen.findByText('Tags'))
    fireEvent.click(await screen.findByRole('button', { name: 'scifi' }))

    await waitFor(() => expect(tagSvc.setForItem).toHaveBeenCalledWith('i1', ['t1']))
    expect(screen.queryByText(/Couldn't tag/)).toBeNull()
  })
})
