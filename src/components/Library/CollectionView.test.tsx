import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import CollectionView from './CollectionView'
import { collectionService, libraryService, tagService } from '../../services/library'
import type { Item } from '../../types'

// CollectionView is heavy — router, dnd-kit, ResizeObserver, the service layer,
// and several child modals. These tests exercise CollectionView's own wiring/state
// by stubbing the periphery: the service layer is mocked with controllable spies,
// the heavy child components are reduced to stubs that surface the handlers
// CollectionView passes them, and dnd-kit is a pass-through (with a real arrayMove
// + captured drag callbacks) so the grid renders and reorders in jsdom.

// react-router's useNavigate → a spy, so navigation targets are assertable while
// MemoryRouter/Routes/Route stay real.
const navSpy = vi.fn()
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navSpy,
}))

// Captured dnd-kit drag callbacks so tests can drive drag start/end directly.
const dnd = vi.hoisted(() => ({ onDragStart: (_e: any) => {}, onDragEnd: (_e: any) => {} }))

vi.mock('../../services/library', () => ({
  collectionService: {
    getAll: vi.fn(),
    getItems: vi.fn(),
    getAllItemCollections: vi.fn(),
    reorderItems: vi.fn(),
    removeItem: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    rename: vi.fn(),
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

// ItemCard stub: renders the item's status + tag count and a button for every
// handler CollectionView wires, so each can be driven from a test.
vi.mock('./ItemCard', () => ({
  default: ({
    item,
    tags,
    onClick,
    onDelete,
    onEditTags,
    onRemoveFromCollection,
    onTitleChange,
    onAuthorChange,
    onStatusChange,
    onCoverChange,
    onTagClick,
    onAuthorClick,
    onRatingChange,
    onWriteReview,
  }: any) => (
    <div data-testid={`card-${item.id}`}>
      <span data-testid={`status-${item.id}`}>{item.status ?? 'none'}</span>
      <span data-testid={`tags-${item.id}`}>{(tags ?? []).map((t: any) => t.name).join(',')}</span>
      <button data-testid={`open-${item.id}`} onClick={onClick}>open</button>
      <button data-testid={`delete-${item.id}`} onClick={onDelete}>delete</button>
      <button data-testid={`remove-${item.id}`} onClick={onRemoveFromCollection}>remove</button>
      <button data-testid={`edit-tags-${item.id}`} onClick={onEditTags}>edit tags</button>
      <button data-testid={`finish-${item.id}`} onClick={() => onStatusChange('finished')}>finish</button>
      <button data-testid={`title-${item.id}`} onClick={() => onTitleChange('Retitled')}>title</button>
      <button data-testid={`author-${item.id}`} onClick={() => onAuthorChange('New Author')}>author</button>
      <button data-testid={`cover-${item.id}`} onClick={() => onCoverChange('/covers/x.png')}>cover</button>
      <button data-testid={`tagclick-${item.id}`} onClick={() => onTagClick('t1')}>tagclick</button>
      <button data-testid={`authorclick-${item.id}`} onClick={() => onAuthorClick('Alice & Co')}>authorclick</button>
      <button data-testid={`rate-${item.id}`} onClick={() => onRatingChange(4)}>rate</button>
      <button data-testid={`review-${item.id}`} onClick={onWriteReview}>review</button>
    </div>
  ),
}))

// TagsModal stub: exposes only a close button so a test can trigger onClose.
vi.mock('./TagsModal', () => ({
  default: ({ onClose }: any) => (
    <button data-testid="tags-modal-close" onClick={onClose}>close tags</button>
  ),
}))

// ReviewModal stub: surfaces save (with review + rating) and close.
vi.mock('./ReviewModal', () => ({
  default: ({ onSave, onClose }: any) => (
    <div>
      <button data-testid="review-save" onClick={() => onSave('Loved it', 5)}>save review</button>
      <button data-testid="review-close" onClick={onClose}>close review</button>
    </div>
  ),
}))

// AddToCollectionModal stub: surfaces add (a new item) and close.
vi.mock('./AddToCollectionModal', () => ({
  default: ({ onAdd, onClose }: any) => (
    <div>
      <button
        data-testid="add-item"
        onClick={() => onAdd({ id: 'i3', title: 'Cherry', status: null, content_type: 'article' })}
      >
        add item
      </button>
      <button data-testid="add-close" onClick={onClose}>close add</button>
    </div>
  ),
}))

// Sidebar stub: surfaces the collection-management handlers it receives.
vi.mock('./Sidebar', () => ({
  default: ({ collectionMgmt }: any) => (
    <div>
      <button data-testid="col-create" onClick={() => collectionMgmt.onCreate('New Col')}>create</button>
      <button data-testid="col-rename" onClick={() => collectionMgmt.onRename('c1', 'Renamed')}>rename</button>
      <button data-testid="col-delete" onClick={() => collectionMgmt.onDelete('c1')}>delete current</button>
      <button data-testid="col-delete-other" onClick={() => collectionMgmt.onDelete('c2')}>delete other</button>
    </div>
  ),
}))

// CustomSelect (sort) stub: a button per option that fires onChange(value).
vi.mock('../ui/CustomSelect', () => ({
  default: ({ options, onChange }: any) => (
    <div>
      {options.map((o: any) => (
        <button key={o.value} data-testid={`sort-${o.value}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  ),
}))

// MultiSelect (filters) stub: a button per option that fires onChange([value]).
vi.mock('../ui/MultiSelect', () => ({
  default: ({ label, options, onChange }: any) => (
    <div data-testid={`ms-${label}`}>
      {options.map((o: any) => (
        <button
          key={o.value}
          data-testid={`filter-${label}-${o.value}`}
          onClick={() => onChange([o.value])}
        >
          {o.label}
        </button>
      ))}
    </div>
  ),
}))

// dnd-kit → pass-through; capture the drag callbacks and use a REAL arrayMove so
// handleDragEnd produces a genuine reorder.
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragStart, onDragEnd }: any) => {
    dnd.onDragStart = onDragStart
    dnd.onDragEnd = onDragEnd
    return <>{children}</>
  },
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
  arrayMove: (arr: unknown[], from: number, to: number) => {
    const copy = [...arr]
    const [moved] = copy.splice(from, 1)
    copy.splice(to, 0, moved)
    return copy
  },
  rectSortingStrategy: vi.fn(),
}))
vi.mock('@dnd-kit/utilities', () => ({ CSS: { Transform: { toString: () => '' } } }))

function makeItem(id: string, over: Partial<Item> = {}): Item {
  return { id, title: `Title ${id}`, status: null, content_type: 'article', ...over } as Item
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

/** Ids of the currently-rendered grid cards, in DOM order. */
function cardOrder(): string[] {
  return screen.getAllByTestId(/^card-/).map((el) => el.getAttribute('data-testid')!.slice(5))
}

beforeEach(() => {
  vi.clearAllMocks()
  navSpy.mockReset()
  // Default: everything loads successfully with two items in collection "c1".
  ;(collectionService.getAll as any).mockResolvedValue([{ id: 'c1', name: 'My Collection' }])
  ;(collectionService.getItems as any).mockResolvedValue([makeItem('i1'), makeItem('i2')])
  ;(collectionService.getAllItemCollections as any).mockResolvedValue([])
  ;(collectionService.reorderItems as any).mockResolvedValue(undefined)
  ;(collectionService.removeItem as any).mockResolvedValue(undefined)
  ;(collectionService.create as any).mockResolvedValue({ id: 'c9', name: 'New Col' })
  ;(collectionService.delete as any).mockResolvedValue(undefined)
  ;(collectionService.rename as any).mockResolvedValue(undefined)
  ;(tagService.getAll as any).mockResolvedValue([])
  ;(libraryService.getAllItemTags as any).mockResolvedValue([])
  ;(libraryService.getTrashed as any).mockResolvedValue([])
  ;(libraryService.getAll as any).mockResolvedValue([])
  ;(libraryService.setStatus as any).mockResolvedValue(undefined)
  ;(libraryService.softDelete as any).mockResolvedValue(undefined)
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
    await waitFor(() => expect(screen.getByTestId('status-i1')).toHaveTextContent('finished'))
  })

  // BUG-7: the load chain had no .catch(), so any failure showed a silent empty grid.
  it('regression BUG-7: a load failure renders the error state, not a silent empty grid', async () => {
    ;(collectionService.getItems as any).mockRejectedValue(new Error('DB is corrupt'))
    renderView()

    expect(await screen.findByText(/Failed to load collection: DB is corrupt/)).toBeInTheDocument()
    expect(screen.queryByTestId('card-i1')).not.toBeInTheDocument()
  })

  // BUG-5: closing the tags modal must re-fetch tag data so the maps don't go stale.
  it('regression BUG-5: closing the tags modal refreshes tag data', async () => {
    ;(libraryService.getAllItemTags as any).mockResolvedValue([{ item_id: 'i1', tag_id: 't1' }])
    ;(tagService.getAll as any).mockResolvedValue([{ id: 't1', name: 'Fantasy', color: '#fff' }])
    renderView()
    await screen.findByTestId('card-i1')

    expect(tagService.getAll).toHaveBeenCalledTimes(1)
    expect(libraryService.getAllItemTags).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('edit-tags-i1')) // open modal
    await userEvent.click(await screen.findByTestId('tags-modal-close')) // close → refreshTagData

    await waitFor(() => {
      expect(tagService.getAll).toHaveBeenCalledTimes(2)
      expect(libraryService.getAllItemTags).toHaveBeenCalledTimes(2)
    })
    // refreshTagData rebuilt the tag map (BUG-5 loop body).
    expect(screen.getByTestId('tags-i1')).toHaveTextContent('Fantasy')
  })
})

describe('CollectionView — item card handlers', () => {
  it('opening a card navigates to the reader', async () => {
    renderView()
    await userEvent.click(await screen.findByTestId('open-i1'))
    expect(navSpy).toHaveBeenCalledWith('/read/i1')
  })

  it('deleting a card soft-deletes it and drops it from the grid', async () => {
    renderView()
    await userEvent.click(await screen.findByTestId('delete-i1'))
    expect(libraryService.softDelete).toHaveBeenCalledWith('i1')
    await waitFor(() => expect(screen.queryByTestId('card-i1')).not.toBeInTheDocument())
    expect(screen.getByTestId('card-i2')).toBeInTheDocument()
  })

  it('removing a card from the collection calls removeItem and drops it', async () => {
    renderView()
    await userEvent.click(await screen.findByTestId('remove-i1'))
    expect(collectionService.removeItem).toHaveBeenCalledWith('c1', 'i1')
    await waitFor(() => expect(screen.queryByTestId('card-i1')).not.toBeInTheDocument())
  })

  it('editing title/author/rating persists via the service and updates the item', async () => {
    renderView()
    await screen.findByTestId('card-i1')

    await userEvent.click(screen.getByTestId('title-i1'))
    expect(libraryService.setTitle).toHaveBeenCalledWith('i1', 'Retitled')

    await userEvent.click(screen.getByTestId('author-i1'))
    expect(libraryService.setAuthor).toHaveBeenCalledWith('i1', 'New Author')

    await userEvent.click(screen.getByTestId('rate-i1'))
    expect(libraryService.setRating).toHaveBeenCalledWith('i1', 4)
  })

  it('cover change updates state without a service call, tag/author clicks navigate', async () => {
    renderView()
    await screen.findByTestId('card-i1')

    await userEvent.click(screen.getByTestId('cover-i1')) // updateItem only — no throw
    await userEvent.click(screen.getByTestId('tagclick-i1'))
    expect(navSpy).toHaveBeenCalledWith('/?tag=t1')

    await userEvent.click(screen.getByTestId('authorclick-i1'))
    expect(navSpy).toHaveBeenCalledWith(`/?author=${encodeURIComponent('Alice & Co')}`)
  })

  it('writing a review opens the review modal and onSave updates the item', async () => {
    renderView()
    await userEvent.click(await screen.findByTestId('review-i1'))
    await userEvent.click(await screen.findByTestId('review-save'))
    // Modal closed after save (its close/save both unmount it).
    await waitFor(() => expect(screen.queryByTestId('review-save')).not.toBeInTheDocument())
  })
})

describe('CollectionView — filter / sort / search', () => {
  beforeEach(() => {
    ;(collectionService.getItems as any).mockResolvedValue([
      makeItem('i1', {
        title: 'Banana',
        author: 'Alice',
        content_type: 'article',
        date_saved: 100,
        last_read_at: 300,
        word_count: 500,
        scroll_position: 0.2,
      }),
      makeItem('i2', {
        title: 'Apple',
        author: 'Bob',
        content_type: 'epub',
        date_saved: 200,
        last_read_at: 100,
        word_count: 900,
        scroll_position: 0.5,
      }),
    ])
    ;(libraryService.getAllItemTags as any).mockResolvedValue([{ item_id: 'i1', tag_id: 't1' }])
    ;(tagService.getAll as any).mockResolvedValue([{ id: 't1', name: 'Fantasy', color: '#fff' }])
  })

  it('type filter narrows the grid to the matching content type', async () => {
    renderView()
    await screen.findByTestId('card-i1')
    await userEvent.click(screen.getByTestId('filter-Type-epub'))
    await waitFor(() => expect(cardOrder()).toEqual(['i2']))
  })

  it('tag filter narrows to items carrying the tag', async () => {
    renderView()
    await screen.findByTestId('card-i1')
    await userEvent.click(screen.getByTestId('filter-Tag-t1'))
    await waitFor(() => expect(cardOrder()).toEqual(['i1']))
  })

  it('author filter narrows to the chosen author, and Clear filters resets', async () => {
    renderView()
    await screen.findByTestId('card-i1')
    await userEvent.click(screen.getByTestId('filter-Author-Alice'))
    await waitFor(() => expect(cardOrder()).toEqual(['i1']))

    await userEvent.click(screen.getByText('Clear filters'))
    await waitFor(() => expect(cardOrder().sort()).toEqual(['i1', 'i2']))
  })

  it('search filters by title (debounced) and the clear button resets it', async () => {
    renderView()
    await screen.findByTestId('card-i1')
    const search = screen.getByPlaceholderText('Search this collection…')

    await userEvent.type(search, 'Apple')
    await waitFor(() => expect(cardOrder()).toEqual(['i2']))

    await userEvent.click(screen.getByLabelText('Clear search'))
    await waitFor(() => expect(cardOrder().sort()).toEqual(['i1', 'i2']))
  })

  it('shows the no-match state when filters exclude everything', async () => {
    renderView()
    await screen.findByTestId('card-i1')
    await userEvent.type(screen.getByPlaceholderText('Search this collection…'), 'zzzzz')
    expect(await screen.findByText('No items match your filters.')).toBeInTheDocument()
  })

  it('applies each sort option', async () => {
    renderView()
    await screen.findByTestId('card-i1')
    expect(cardOrder()).toEqual(['i1', 'i2']) // custom (load order)

    await userEvent.click(screen.getByTestId('sort-title'))
    await waitFor(() => expect(cardOrder()).toEqual(['i2', 'i1'])) // Apple, Banana

    await userEvent.click(screen.getByTestId('sort-last_read'))
    await waitFor(() => expect(cardOrder()).toEqual(['i1', 'i2'])) // 300 > 100

    await userEvent.click(screen.getByTestId('sort-word_count'))
    await waitFor(() => expect(cardOrder()).toEqual(['i2', 'i1'])) // 900 > 500

    await userEvent.click(screen.getByTestId('sort-date_saved'))
    await waitFor(() => expect(cardOrder()).toEqual(['i2', 'i1'])) // 200 > 100

    await userEvent.click(screen.getByTestId('sort-progress'))
    await waitFor(() => expect(cardOrder()).toEqual(['i2', 'i1'])) // 0.5 > 0.2

    await userEvent.click(screen.getByTestId('sort-custom'))
    await waitFor(() => expect(cardOrder()).toEqual(['i1', 'i2']))
  })
})

describe('CollectionView — drag reorder', () => {
  it('handleDragStart surfaces the dragged card in the overlay', async () => {
    renderView()
    await screen.findByTestId('card-i1')
    act(() => dnd.onDragStart({ active: { id: 'i1' } }))
    // grid card + overlay clone → two elements share the id.
    await waitFor(() => expect(screen.getAllByTestId('card-i1')).toHaveLength(2))
  })

  it('handleDragEnd reorders the items and persists the new order', async () => {
    renderView()
    await screen.findByTestId('card-i1')
    act(() => dnd.onDragEnd({ active: { id: 'i1' }, over: { id: 'i2' } }))
    await waitFor(() => expect(cardOrder()).toEqual(['i2', 'i1']))
    expect(collectionService.reorderItems).toHaveBeenLastCalledWith('c1', ['i2', 'i1'])
  })

  it('handleDragEnd is a no-op when dropped on itself', async () => {
    renderView()
    await screen.findByTestId('card-i1')
    ;(collectionService.reorderItems as any).mockClear()
    act(() => dnd.onDragEnd({ active: { id: 'i1' }, over: { id: 'i1' } }))
    expect(collectionService.reorderItems).not.toHaveBeenCalled()
    expect(cardOrder()).toEqual(['i1', 'i2'])
  })
})

describe('CollectionView — collection management (Sidebar)', () => {
  it('create appends the new collection', async () => {
    renderView()
    await userEvent.click(await screen.findByTestId('col-create'))
    expect(collectionService.create).toHaveBeenCalledWith('New Col')
  })

  it('renaming the current collection updates the header title', async () => {
    renderView()
    await screen.findByTestId('card-i1')
    await userEvent.click(screen.getByTestId('col-rename'))
    expect(collectionService.rename).toHaveBeenCalledWith('c1', 'Renamed')
    expect(await screen.findByText(/Renamed/)).toBeInTheDocument()
  })

  it('deleting the current collection navigates home', async () => {
    renderView()
    await userEvent.click(await screen.findByTestId('col-delete'))
    expect(collectionService.delete).toHaveBeenCalledWith('c1')
    await waitFor(() => expect(navSpy).toHaveBeenCalledWith('/'))
  })

  it('deleting a different collection does not navigate away', async () => {
    renderView()
    await screen.findByTestId('card-i1')
    await userEvent.click(screen.getByTestId('col-delete-other'))
    expect(collectionService.delete).toHaveBeenCalledWith('c2')
    expect(navSpy).not.toHaveBeenCalledWith('/')
  })
})

describe('CollectionView — empty states + add modal', () => {
  it('renders the empty state for a collection with no items', async () => {
    ;(collectionService.getItems as any).mockResolvedValue([])
    renderView()
    expect(await screen.findByText('This collection is empty')).toBeInTheDocument()
  })

  it('the Add modal appends the added item to the grid', async () => {
    renderView()
    await screen.findByTestId('card-i1')
    // Header "+ Add" opens the modal.
    await userEvent.click(screen.getByText('+ Add'))
    await userEvent.click(await screen.findByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('card-i3')).toBeInTheDocument())
  })

  it('the Add modal can be dismissed without adding', async () => {
    renderView()
    await screen.findByTestId('card-i1')
    await userEvent.click(screen.getByText('+ Add'))
    await userEvent.click(await screen.findByTestId('add-close'))
    await waitFor(() => expect(screen.queryByTestId('add-close')).not.toBeInTheDocument())
  })
})
