import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import CollectionView from './CollectionView'
import { collectionService, libraryService, tagService } from '../../services/library'
import type { Item } from '../../types'

// CollectionView is heavy — router, dnd-kit, ResizeObserver, the service layer,
// and several child modals. These regression tests exercise CollectionView's own
// wiring/state (where BUG-1/5/7 live) by stubbing the periphery: the service layer
// is mocked with controllable spies, the heavy child components are reduced to
// stubs that surface the handlers CollectionView passes them, and dnd-kit is a
// pass-through so the grid renders in jsdom.

vi.mock('../../services/library', () => ({
  collectionService: {
    getAll: vi.fn(),
    getItems: vi.fn(),
    getAllItemCollections: vi.fn(),
    reorderItems: vi.fn(),
    removeItem: vi.fn(),
    create: vi.fn(),
  },
  libraryService: {
    getAll: vi.fn(),
    getAllItemTags: vi.fn(),
    getTrashed: vi.fn(),
    setStatus: vi.fn(),
    softDelete: vi.fn(),
    setTitle: vi.fn(),
    setAuthor: vi.fn(),
    setRating: vi.fn(),
  },
  tagService: { getAll: vi.fn() },
}))

// ItemCard stub: renders the item's current status and buttons that fire the two
// handlers these tests drive (status change → BUG-1; edit tags → BUG-5).
vi.mock('./ItemCard', () => ({
  default: ({ item, onStatusChange, onEditTags }: any) => (
    <div data-testid={`card-${item.id}`}>
      <span data-testid={`status-${item.id}`}>{item.status ?? 'none'}</span>
      <button data-testid={`finish-${item.id}`} onClick={() => onStatusChange('finished')}>
        finish
      </button>
      <button data-testid={`edit-tags-${item.id}`} onClick={onEditTags}>
        edit tags
      </button>
    </div>
  ),
}))

// TagsModal stub: exposes only a close button so a test can trigger onClose.
vi.mock('./TagsModal', () => ({
  default: ({ onClose }: any) => (
    <button data-testid="tags-modal-close" onClick={onClose}>
      close tags
    </button>
  ),
}))

// The rest of the periphery is irrelevant to these tests — stub to nothing.
vi.mock('./Sidebar', () => ({ default: () => null }))
vi.mock('./ReviewModal', () => ({ default: () => null }))
vi.mock('./AddToCollectionModal', () => ({ default: () => null }))
vi.mock('../ui/CustomSelect', () => ({ default: () => null }))
vi.mock('../ui/MultiSelect', () => ({ default: () => null }))

// dnd-kit → pass-through so the grid renders without real drag sensors.
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: any) => <>{children}</>,
  DragOverlay: ({ children }: any) => <>{children}</>,
  closestCenter: vi.fn(),
}))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: any) => <>{children}</>,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  arrayMove: (arr: unknown[]) => arr,
  rectSortingStrategy: vi.fn(),
}))
vi.mock('@dnd-kit/utilities', () => ({ CSS: { Transform: { toString: () => '' } } }))

function makeItem(id: string, over: Partial<Item> = {}): Item {
  return { id, title: `Title ${id}`, status: null, ...over } as Item
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/collection/c1']}>
      <Routes>
        <Route path="/collection/:id" element={<CollectionView />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: everything loads successfully with two items in collection "c1".
  ;(collectionService.getAll as any).mockResolvedValue([{ id: 'c1', name: 'My Collection' }])
  ;(collectionService.getItems as any).mockResolvedValue([makeItem('i1'), makeItem('i2')])
  ;(collectionService.getAllItemCollections as any).mockResolvedValue([])
  ;(collectionService.reorderItems as any).mockResolvedValue(undefined)
  ;(tagService.getAll as any).mockResolvedValue([])
  ;(libraryService.getAllItemTags as any).mockResolvedValue([])
  ;(libraryService.getTrashed as any).mockResolvedValue([])
  ;(libraryService.getAll as any).mockResolvedValue([])
  ;(libraryService.setStatus as any).mockResolvedValue(undefined)
})

describe('CollectionView — report.md regressions', () => {
  // BUG-1: the status control inside a collection was wired to a no-op, so status
  // changes were silently dropped (no DB write, badge never updated).
  it('regression BUG-1: changing a card status persists via setStatus and updates the badge', async () => {
    renderView()
    await screen.findByTestId('card-i1')
    expect(screen.getByTestId('status-i1')).toHaveTextContent('none')

    await userEvent.click(screen.getByTestId('finish-i1'))

    expect(libraryService.setStatus).toHaveBeenCalledWith('i1', 'finished')
    // The badge reflecting the change proves updateItem() ran, not just the DB call.
    await waitFor(() => expect(screen.getByTestId('status-i1')).toHaveTextContent('finished'))
  })

  // BUG-7: the load chain had no .catch(), so any failure showed a silent empty
  // grid with no feedback.
  it('regression BUG-7: a load failure renders the error state, not a silent empty grid', async () => {
    ;(collectionService.getItems as any).mockRejectedValue(new Error('DB is corrupt'))
    renderView()

    expect(await screen.findByText(/Failed to load collection: DB is corrupt/)).toBeInTheDocument()
    expect(screen.queryByTestId('card-i1')).not.toBeInTheDocument()
  })

  // BUG-5: closing the tags modal must re-fetch tag data so the maps don't go
  // stale after the modal mutates them.
  it('regression BUG-5: closing the tags modal refreshes tag data', async () => {
    renderView()
    await screen.findByTestId('card-i1')

    // The initial load fetched tag data exactly once.
    expect(tagService.getAll).toHaveBeenCalledTimes(1)
    expect(libraryService.getAllItemTags).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('edit-tags-i1')) // open modal
    await userEvent.click(await screen.findByTestId('tags-modal-close')) // close → refreshTagData

    await waitFor(() => {
      expect(tagService.getAll).toHaveBeenCalledTimes(2)
      expect(libraryService.getAllItemTags).toHaveBeenCalledTimes(2)
    })
  })
})
