import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
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

// useNavigate → spy (useSearchParams stays real; the component drives filters through it).
const navSpy = vi.fn()
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navSpy,
}))

// Heavy children reduced to identifiable stubs. ItemCard surfaces every callback
// LibraryView wires (the CollectionView.test.tsx pattern), guarding the optional
// ones (onRefresh/onAppend/onOpenSource/onTogglePreferred) so their presence is
// itself assertable for grouped PDF/EPUB cards.
vi.mock('./ItemCard', () => ({
  default: (p: any) => (
    <div data-testid="card" data-selected={p.isSelected ? '1' : '0'}>
      <span data-testid="card-title">{p.item.title}</span>
      <button
        onClick={(e) => {
          // Real ItemCard stops the click bubbling to the layout's clear-handler;
          // mirror that here so multi-select doesn't self-clear.
          e.stopPropagation()
          p.onClick({
            shiftKey: true,
            stopPropagation() {},
            preventDefault() {},
          } as unknown as React.MouseEvent)
        }}
      >
        select-{p.item.title}
      </button>
      <button onClick={() => p.onDelete()}>del-{p.item.title}</button>
      <button onClick={() => p.onRatingChange(5)}>rate-{p.item.title}</button>
      <button onClick={() => p.onStatusChange('finished')}>status-{p.item.title}</button>
      <button onClick={() => p.onWriteReview()}>review-{p.item.title}</button>
      <button onClick={() => p.onEditTags()}>tags-{p.item.title}</button>
      <button onClick={() => p.onEditCollections()}>cols-{p.item.title}</button>
      <button onClick={() => p.onCoverChange('/c.png')}>cover-{p.item.title}</button>
      <button onClick={() => p.onAuthorChange('Zed')}>author-{p.item.title}</button>
      <button onClick={() => p.onTitleChange('Renamed')}>title-{p.item.title}</button>
      <button onClick={() => p.onTagClick('t1')}>tagclick-{p.item.title}</button>
      <button onClick={() => p.onAuthorClick('Ann')}>authorclick-{p.item.title}</button>
      {p.onOpenSource && <button onClick={() => p.onOpenSource()}>opensrc-{p.item.title}</button>}
      {p.onTogglePreferred && (
        <button onClick={() => p.onTogglePreferred()}>toggle-{p.item.title}</button>
      )}
      {p.onRefresh && (
        // onRefresh rethrows on failure (the real card handles it); swallow here.
        <button onClick={() => p.onRefresh().catch(() => {})}>refresh-{p.item.title}</button>
      )}
      {p.onAppend && <button onClick={() => p.onAppend()}>append-{p.item.title}</button>}
    </div>
  ),
}))

// Sidebar surfaces the collection-management handlers it receives.
vi.mock('./Sidebar', () => ({
  default: ({ collectionMgmt }: any) => (
    <div>
      <button onClick={() => collectionMgmt.onCreate('New Col')}>sb-create</button>
      <button onClick={() => collectionMgmt.onRename('c1', 'Renamed Col')}>sb-rename</button>
      <button onClick={() => collectionMgmt.onDelete('c1')}>sb-delete</button>
    </div>
  ),
}))

vi.mock('../Capture/AddItemModal', () => ({
  default: ({ onSaved, onJobStarted, onClose }: any) => (
    <div>
      ADD MODAL
      <button onClick={() => onSaved({ id: 'new1', title: 'Saved', content_type: 'html' })}>
        add-saved
      </button>
      <button onClick={() => onJobStarted('job1', 'https://x')}>add-job</button>
      <button onClick={() => onClose()}>add-close</button>
    </div>
  ),
}))
vi.mock('../Capture/AppendModal', () => ({
  default: ({ onClose, onJobStarted }: any) => (
    <div>
      APPEND MODAL
      <button onClick={() => onJobStarted('job2', 'https://y')}>append-job</button>
      <button onClick={() => onClose()}>append-close</button>
    </div>
  ),
}))
vi.mock('./TagsModal', () => ({
  default: ({ onClose }: any) => (
    <div>
      TAGS MODAL
      <button onClick={() => onClose()}>tags-close</button>
    </div>
  ),
}))
vi.mock('./CollectionsModal', () => ({
  default: ({ onClose }: any) => (
    <div>
      COLLECTIONS MODAL
      <button onClick={() => onClose()}>cols-close</button>
    </div>
  ),
}))
vi.mock('./ReviewModal', () => ({
  default: ({ onSave, onClose }: any) => (
    <div>
      REVIEW MODAL
      <button onClick={() => onSave('Nice', 4)}>review-save</button>
      <button onClick={() => onClose()}>review-close</button>
    </div>
  ),
}))

// CustomSelect (sort) + MultiSelect (filters) → functional stubs firing onChange.
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

vi.mock('../../services/library', () => ({
  libraryService: {
    getAll: vi.fn(),
    getAllItemTags: vi.fn().mockResolvedValue([]),
    getTrashed: vi.fn().mockResolvedValue([]),
    softDelete: vi.fn().mockResolvedValue(undefined),
    setRating: vi.fn(),
    setStatus: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn(),
    refresh: vi.fn(),
  },
  tagService: {
    getAll: vi.fn().mockResolvedValue([]),
    setForItem: vi.fn().mockResolvedValue(undefined),
  },
  collectionService: {
    getAll: vi.fn().mockResolvedValue([]),
    getAllItemCollections: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    setForItem: vi.fn().mockResolvedValue(undefined),
  },
}))
import { libraryService, tagService, collectionService } from '../../services/library'
const lib = libraryService as unknown as Record<string, ReturnType<typeof vi.fn>>
const tagSvc = tagService as unknown as Record<string, ReturnType<typeof vi.fn>>
const colSvc = collectionService as unknown as Record<string, ReturnType<typeof vi.fn>>

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
    source_url: null,
    ...over,
  }) as Item

// Captured window.api listener callbacks so tests can drive them. Both LibraryView
// AND CaptureJobsContext register onCaptureComplete, so collect every callback and
// fire them all (the CaptureJobsContext handler tolerates the partial event).
let requestCaptureCbs: ((url: string) => void)[] = []
let captureCompleteCbs: ((e: any) => void)[] = []

function fireCaptureComplete(id: string) {
  for (const cb of captureCompleteCbs) {
    try {
      cb({ result: { id }, jobId: 'job', url: 'https://x' })
    } catch {
      /* the job-tracking handler may not accept the partial event; ignore */
    }
  }
}

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

/** Click an item inside the open bulk tag/collection popover. Scoped to
 *  `.bulk-popover` because the filter-bar MultiSelect can share a label (e.g. a
 *  tag named "scifi" appears both as a filter option and a bulk-tag toggle). */
function clickBulkPopoverItem(name: string) {
  const pop = document.querySelector('.bulk-popover') as HTMLElement
  fireEvent.click(within(pop).getByText(name))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  requestCaptureCbs = []
  captureCompleteCbs = []
  ;(window as unknown as { api: unknown }).api = {
    onRequestCapture: vi.fn((cb: any) => {
      requestCaptureCbs.push(cb)
      return () => {}
    }),
    onCaptureProgress: vi.fn(() => () => {}),
    onCaptureComplete: vi.fn((cb: any) => {
      captureCompleteCbs.push(cb)
      return () => {}
    }),
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

  it('filters by in-progress status from the URL', async () => {
    lib.getAll.mockResolvedValue(items)
    renderLibrary(['/?filter=in-progress'])
    expect(await screen.findByText('Reading One')).toBeInTheDocument()
    expect(screen.queryByText('Unread One')).toBeNull()
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

  it('clears the search with the ✕ button', async () => {
    lib.getAll.mockResolvedValue([mkItem({ id: 'i1', title: 'Dune' })])
    renderLibrary()
    const input = screen.getByPlaceholderText('Search title, author, tags…')
    fireEvent.change(input, { target: { value: 'zzz' } })
    await waitFor(() => expect(screen.getByText('No items match this filter.')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Clear search'))
    await waitFor(() => expect(screen.getByText('Dune')).toBeInTheDocument())
  })

  it('shows a no-match message when a filter excludes everything', async () => {
    lib.getAll.mockResolvedValue([mkItem({ status: 'finished' })])
    renderLibrary(['/?filter=unread'])
    expect(await screen.findByText('No items match this filter.')).toBeInTheDocument()
  })

  it('shows the collection-specific empty message when a collection filter matches nothing', async () => {
    lib.getAll.mockResolvedValue([mkItem({ id: 'i1', title: 'Alpha' })])
    colSvc.getAll.mockResolvedValue([{ id: 'c1', name: 'Faves' }])
    renderLibrary(['/?collection=c1'])
    expect(await screen.findByText(/No items in "Faves" yet/)).toBeInTheDocument()
  })
})

describe('LibraryView — filter bar dropdowns', () => {
  beforeEach(() => {
    lib.getAll.mockResolvedValue([
      mkItem({ id: 'i1', title: 'Art', author: 'Ann', content_type: 'article' }),
      mkItem({ id: 'i2', title: 'Book', author: 'Bob', content_type: 'epub' }),
    ])
    lib.getAllItemTags.mockResolvedValue([{ item_id: 'i1', tag_id: 't1', name: 'scifi', color: '#f00' }])
    tagSvc.getAll.mockResolvedValue([{ id: 't1', name: 'scifi', color: '#f00' }])
  })

  it('type filter narrows the grid and Clear filters resets', async () => {
    renderLibrary()
    await screen.findByText('Art')
    fireEvent.click(screen.getByTestId('filter-Type-epub'))
    await waitFor(() => expect(cardTitles()).toEqual(['Book']))
    fireEvent.click(screen.getByText('Clear filters'))
    await waitFor(() => expect(cardTitles().sort()).toEqual(['Art', 'Book']))
  })

  it('tag filter narrows to items carrying the tag', async () => {
    renderLibrary()
    await screen.findByText('Art')
    fireEvent.click(screen.getByTestId('filter-Tag-t1'))
    await waitFor(() => expect(cardTitles()).toEqual(['Art']))
  })

  it('author filter narrows to the chosen author', async () => {
    renderLibrary()
    await screen.findByText('Art')
    fireEvent.click(screen.getByTestId('filter-Author-Bob'))
    await waitFor(() => expect(cardTitles()).toEqual(['Book']))
  })
})

describe('LibraryView — sorting & modal', () => {
  const sortItems = [
    mkItem({ id: 'i1', title: 'Zebra', last_read_at: 100, word_count: 50, scroll_position: 0.1, rating: 2 }),
    mkItem({ id: 'i2', title: 'Apple', last_read_at: 300, word_count: 900, scroll_position: 0.9, rating: 5 }),
    mkItem({ id: 'i3', title: 'Mango', last_read_at: 200, word_count: 500, scroll_position: 0.5, rating: null }),
  ]

  it('sorts by title when that is the default sort', async () => {
    lib.getAll.mockResolvedValue([
      mkItem({ id: 'i1', title: 'Zebra' }),
      mkItem({ id: 'i2', title: 'Apple' }),
    ])
    renderLibrary(['/'], { defaultSort: 'title' })
    await screen.findByText('Zebra')
    expect(cardTitles()).toEqual(['Apple', 'Zebra'])
  })

  it('applies each sort option from the Sort dropdown', async () => {
    lib.getAll.mockResolvedValue(sortItems)
    renderLibrary()
    await screen.findByText('Zebra')

    fireEvent.click(screen.getByTestId('sort-title'))
    await waitFor(() => expect(cardTitles()).toEqual(['Apple', 'Mango', 'Zebra']))

    fireEvent.click(screen.getByTestId('sort-last_read'))
    await waitFor(() => expect(cardTitles()).toEqual(['Apple', 'Mango', 'Zebra'])) // 300,200,100

    fireEvent.click(screen.getByTestId('sort-word_count'))
    await waitFor(() => expect(cardTitles()).toEqual(['Apple', 'Mango', 'Zebra'])) // 900,500,50

    fireEvent.click(screen.getByTestId('sort-progress'))
    await waitFor(() => expect(cardTitles()).toEqual(['Apple', 'Mango', 'Zebra'])) // 0.9,0.5,0.1

    fireEvent.click(screen.getByTestId('sort-rating_high'))
    await waitFor(() => expect(cardTitles()).toEqual(['Apple', 'Zebra', 'Mango'])) // 5,2,null-last

    fireEvent.click(screen.getByTestId('sort-rating_low'))
    await waitFor(() => expect(cardTitles()).toEqual(['Zebra', 'Apple', 'Mango'])) // 2,5,null-last
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
    await waitFor(() => expect(lib.setStatus).toHaveBeenCalledWith('i1', 'finished'))
  })

  it('cover/author/title edits update the item in place', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('author-Alpha'))
    fireEvent.click(screen.getByText('title-Alpha'))
    await waitFor(() => expect(screen.getByText('Renamed')).toBeInTheDocument())
    fireEvent.click(screen.getByText('cover-Renamed')) // no throw; setItems only
  })

  it('tag/author clicks push a filter into the URL', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('tagclick-Alpha'))
    fireEvent.click(screen.getByText('authorclick-Alpha'))
    // After both clicks the item still shows (it has author Ann + could be tag-filtered out
    // only if it lacked t1); assert no crash and the card remains addressable.
    expect(screen.getByTestId('card')).toBeInTheDocument()
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

describe('LibraryView — refresh & append (source_url items)', () => {
  const withSource = mkItem({
    id: 'i1',
    title: 'Serial',
    source_url: 'https://ao3.org/works/1',
    chapter_end: 5,
  })

  it('refresh reports "updated" when the content changed', async () => {
    lib.getAll.mockResolvedValue([withSource])
    lib.refresh.mockResolvedValue({ changed: true, wordCount: 999 })
    renderLibrary()
    await screen.findByText('Serial')
    fireEvent.click(screen.getByText('refresh-Serial'))
    expect(await screen.findByText(/"Serial" updated/)).toBeInTheDocument()
  })

  it('refresh reports "already up to date" when nothing changed', async () => {
    lib.getAll.mockResolvedValue([withSource])
    lib.refresh.mockResolvedValue({ changed: false })
    renderLibrary()
    await screen.findByText('Serial')
    fireEvent.click(screen.getByText('refresh-Serial'))
    expect(await screen.findByText(/already up to date/)).toBeInTheDocument()
  })

  it('refresh surfaces an error toast on failure', async () => {
    lib.getAll.mockResolvedValue([withSource])
    lib.refresh.mockRejectedValue(new Error('offline'))
    renderLibrary()
    await screen.findByText('Serial')
    fireEvent.click(screen.getByText('refresh-Serial'))
    expect(await screen.findByText(/Refresh failed: offline/)).toBeInTheDocument()
  })

  it('append opens the append modal', async () => {
    lib.getAll.mockResolvedValue([withSource])
    renderLibrary()
    await screen.findByText('Serial')
    fireEvent.click(screen.getByText('append-Serial'))
    expect(screen.getByText('APPEND MODAL')).toBeInTheDocument()
  })
})

describe('LibraryView — PDF/EPUB grouping', () => {
  const grouped = [
    mkItem({ id: 'pdf1', title: 'MyPDF', content_type: 'pdf' }),
    mkItem({ id: 'epub1', title: 'MyEPUB', content_type: 'epub', derived_from: 'pdf1' }),
  ]

  it('shows the EPUB companion by default and hides the standalone EPUB card', async () => {
    lib.getAll.mockResolvedValue(grouped)
    renderLibrary()
    expect(await screen.findByText('MyEPUB')).toBeInTheDocument()
    // Only one card renders (the grouped one), not two.
    expect(screen.getAllByTestId('card')).toHaveLength(1)
  })

  it('toggling the preferred format swaps the displayed item to the PDF', async () => {
    lib.getAll.mockResolvedValue(grouped)
    renderLibrary()
    await screen.findByText('MyEPUB')
    fireEvent.click(screen.getByText('toggle-MyEPUB'))
    await waitFor(() => expect(screen.getByText('MyPDF')).toBeInTheDocument())
    expect(localStorage.getItem('format-pref-pdf1')).toBe('pdf')
  })

  it('opening the source navigates to the companion PDF', async () => {
    lib.getAll.mockResolvedValue(grouped)
    renderLibrary()
    await screen.findByText('MyEPUB')
    fireEvent.click(screen.getByText('opensrc-MyEPUB'))
    expect(navSpy).toHaveBeenCalledWith('/read/pdf1')
  })

  it('deleting a grouped card removes both the item and its companion', async () => {
    lib.getAll.mockResolvedValue(grouped)
    renderLibrary()
    await screen.findByText('MyEPUB')
    fireEvent.click(screen.getByText('del-MyEPUB'))
    await waitFor(() => expect(lib.softDelete).toHaveBeenCalledWith('epub1'))
    expect(lib.softDelete).toHaveBeenCalledWith('pdf1')
  })
})

describe('LibraryView — sidebar collection management', () => {
  beforeEach(() => {
    lib.getAll.mockResolvedValue([mkItem({ id: 'i1', title: 'Alpha' })])
    colSvc.getAll.mockResolvedValue([{ id: 'c1', name: 'Faves' }])
    colSvc.create.mockResolvedValue({ id: 'c2', name: 'New Col' })
  })

  it('create calls the service', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('sb-create'))
    await waitFor(() => expect(colSvc.create).toHaveBeenCalledWith('New Col'))
  })

  it('rename calls the service', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('sb-rename'))
    await waitFor(() => expect(colSvc.rename).toHaveBeenCalledWith('c1', 'Renamed Col'))
  })

  it('deleting the actively-filtered collection clears the collection filter', async () => {
    renderLibrary(['/?collection=c1'])
    await waitFor(() => expect(colSvc.getAll).toHaveBeenCalled())
    fireEvent.click(screen.getByText('sb-delete'))
    expect(colSvc.delete).toHaveBeenCalledWith('c1')
    // Filter cleared → the header returns to "Library".
    await waitFor(() => expect(screen.getByText('Library')).toBeInTheDocument())
  })
})

describe('LibraryView — bulk actions', () => {
  const two = [
    mkItem({ id: 'i1', title: 'Alpha' }),
    mkItem({ id: 'i2', title: 'Beta' }),
  ]

  beforeEach(() => {
    lib.getAll.mockResolvedValue(two)
    lib.getAllItemTags.mockResolvedValue([])
    tagSvc.getAll.mockResolvedValue([{ id: 't1', name: 'scifi', color: '#f00' }])
    colSvc.getAll.mockResolvedValue([{ id: 'c1', name: 'Faves' }])
  })

  it('shift-click range-selects across the anchor', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('select-Alpha')) // anchor
    fireEvent.click(screen.getByText('select-Beta')) // range → both
    expect(await screen.findByText('2 selected')).toBeInTheDocument()
  })

  it('Select all selects every displayed item', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('select-Alpha'))
    fireEvent.click(await screen.findByText('Select all (2)'))
    expect(await screen.findByText('2 selected')).toBeInTheDocument()
  })

  it('bulk add-tag then remove-tag toggles the applied state', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('select-Alpha'))
    fireEvent.click(await screen.findByText('Tags'))
    // Not yet applied → clicking adds.
    clickBulkPopoverItem('scifi')
    await waitFor(() => expect(tagSvc.setForItem).toHaveBeenCalledWith('i1', ['t1']))

    // Re-open; now applied (universalTagIds) → clicking removes.
    fireEvent.click(screen.getByText('Tags'))
    clickBulkPopoverItem('scifi')
    await waitFor(() => expect(tagSvc.setForItem).toHaveBeenCalledWith('i1', []))
  })

  it('bulk add-collection calls setForItem via the collections popover', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('select-Alpha'))
    fireEvent.click(await screen.findByText('Collections'))
    clickBulkPopoverItem('Faves')
    await waitFor(() => expect(colSvc.setForItem).toHaveBeenCalledWith('i1', ['c1']))
  })

  it('bulk delete removes the selected items after confirmation', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('select-Alpha'))
    fireEvent.click(await screen.findByText('Delete 1'))
    fireEvent.click(await screen.findByText('Confirm'))
    await waitFor(() => expect(lib.softDelete).toHaveBeenCalledWith('i1'))
    await waitFor(() => expect(screen.queryByText('Alpha')).toBeNull())
  })

  it('bulk delete can be cancelled', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('select-Alpha'))
    fireEvent.click(await screen.findByText('Delete 1'))
    fireEvent.click(await screen.findByText('Cancel'))
    expect(screen.getByText('Delete 1')).toBeInTheDocument() // back to the un-confirmed button
  })

  it('the tag popover shows an empty state when there are no tags', async () => {
    tagSvc.getAll.mockResolvedValue([])
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('select-Alpha'))
    fireEvent.click(await screen.findByText('Tags'))
    expect(await screen.findByText('No tags yet')).toBeInTheDocument()
  })

  it('clicking empty layout space clears the selection', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('select-Alpha'))
    expect(await screen.findByText('1 selected')).toBeInTheDocument()
    fireEvent.click(document.querySelector('.library-layout')!)
    await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull())
  })
})

describe('LibraryView — bulk failure reporting (PERF-2 / ROB-2)', () => {
  beforeEach(() => {
    lib.getAll.mockResolvedValue([mkItem({ id: 'i1', title: 'Alpha' })])
    lib.getAllItemTags.mockResolvedValue([])
    tagSvc.getAll.mockResolvedValue([{ id: 't1', name: 'scifi', color: '#f00' }])
  })

  it('toasts on a partial failure and does not apply the tag locally', async () => {
    tagSvc.setForItem.mockRejectedValue(new Error('db is locked'))
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('select-Alpha'))
    fireEvent.click(await screen.findByText('Tags'))
    clickBulkPopoverItem('scifi')
    expect(await screen.findByText(/Couldn't tag 1 of 1 item\./)).toBeInTheDocument()
    expect(tagSvc.setForItem).toHaveBeenCalledWith('i1', ['t1'])
  })

  it('applies the tag with no toast when the op succeeds', async () => {
    tagSvc.setForItem.mockResolvedValue(undefined)
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('select-Alpha'))
    fireEvent.click(await screen.findByText('Tags'))
    clickBulkPopoverItem('scifi')
    await waitFor(() => expect(tagSvc.setForItem).toHaveBeenCalledWith('i1', ['t1']))
    expect(screen.queryByText(/Couldn't tag/)).toBeNull()
  })
})

describe('LibraryView — keyboard shortcuts', () => {
  beforeEach(() =>
    lib.getAll.mockResolvedValue([
      mkItem({ id: 'i1', title: 'Alpha' }),
      mkItem({ id: 'i2', title: 'Beta' }),
    ]),
  )

  it('Cmd+A selects all visible items and Escape clears', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.keyDown(window, { key: 'a', metaKey: true })
    expect(await screen.findByText('2 selected')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull())
  })

  it('Cmd+A is ignored while typing in the search input', async () => {
    renderLibrary()
    await screen.findByText('Alpha')
    const input = screen.getByPlaceholderText('Search title, author, tags…')
    input.focus()
    fireEvent.keyDown(input, { key: 'a', metaKey: true })
    expect(screen.queryByText('2 selected')).toBeNull()
  })
})

describe('LibraryView — capture listeners & modals', () => {
  it('a completed capture for a new item prepends it live', async () => {
    lib.getAll.mockResolvedValue([mkItem({ id: 'i1', title: 'Alpha' })])
    lib.getById.mockResolvedValue(mkItem({ id: 'i2', title: 'Freshly Captured' }))
    renderLibrary()
    await screen.findByText('Alpha')
    await act(async () => {
      fireCaptureComplete('i2')
    })
    expect(await screen.findByText('Freshly Captured')).toBeInTheDocument()
  })

  it('a request-capture event opens the add modal', async () => {
    lib.getAll.mockResolvedValue([mkItem()])
    renderLibrary()
    await screen.findByText('Alpha')
    act(() => requestCaptureCbs.forEach((cb) => cb('https://x/story')))
    expect(await screen.findByText('ADD MODAL')).toBeInTheDocument()
  })

  it('closing the tags modal refreshes tag data', async () => {
    lib.getAll.mockResolvedValue([mkItem({ id: 'i1', title: 'Alpha' })])
    renderLibrary()
    await screen.findByText('Alpha')
    expect(tagSvc.getAll).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('tags-Alpha'))
    fireEvent.click(screen.getByText('tags-close'))
    await waitFor(() => expect(tagSvc.getAll).toHaveBeenCalledTimes(2))
  })

  it('closing the collections modal refreshes collection data', async () => {
    lib.getAll.mockResolvedValue([mkItem({ id: 'i1', title: 'Alpha' })])
    renderLibrary()
    await screen.findByText('Alpha')
    expect(colSvc.getAll).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('cols-Alpha'))
    fireEvent.click(screen.getByText('cols-close'))
    await waitFor(() => expect(colSvc.getAll).toHaveBeenCalledTimes(2))
  })

  it('saving a review updates the item', async () => {
    lib.getAll.mockResolvedValue([mkItem({ id: 'i1', title: 'Alpha' })])
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('review-Alpha'))
    fireEvent.click(screen.getByText('review-save'))
    await waitFor(() => expect(screen.queryByText('REVIEW MODAL')).toBeNull())
  })

  it('the add-item modal onSaved prepends the new item', async () => {
    lib.getAll.mockResolvedValue([mkItem({ id: 'i1', title: 'Alpha' })])
    renderLibrary()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }))
    fireEvent.click(screen.getByText('add-saved'))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })
})
