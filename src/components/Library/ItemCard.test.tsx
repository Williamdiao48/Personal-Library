import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import ItemCard from './ItemCard'
import type { Item, Tag } from '../../types'

vi.mock('../../services/library', () => ({
  libraryService: {
    setTitle: vi.fn().mockResolvedValue(undefined),
    setAuthor: vi.fn().mockResolvedValue(undefined),
    pickCover: vi.fn(),
  },
}))
import { libraryService } from '../../services/library'
const lib = libraryService as unknown as Record<string, ReturnType<typeof vi.fn>>

function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: 'item1',
    title: 'The Great Book',
    author: 'Jane Doe',
    source_url: null,
    content_type: 'html',
    file_path: 'x.html',
    word_count: null,
    cover_path: null,
    description: null,
    date_saved: 0,
    date_modified: 0,
    scroll_position: 0,
    status: null,
    rating: null,
    review: null,
    ...over,
  }
}

function renderCard(overProps: Partial<React.ComponentProps<typeof ItemCard>> = {}) {
  const props = {
    item: makeItem(),
    tags: [] as Tag[],
    onClick: vi.fn(),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onEditTags: vi.fn(),
    onEditCollections: vi.fn(),
    onCoverChange: vi.fn(),
    onAuthorChange: vi.fn(),
    onTitleChange: vi.fn(),
    onStatusChange: vi.fn(),
    onTagClick: vi.fn(),
    onAuthorClick: vi.fn(),
    onRatingChange: vi.fn(),
    onWriteReview: vi.fn(),
    ...overProps,
  }
  const result = render(<ItemCard {...props} />)
  return { props, ...result }
}

beforeEach(() => vi.clearAllMocks())

describe('ItemCard — display', () => {
  it('renders title, author, and a placeholder cover initial when no cover image', () => {
    renderCard()
    expect(screen.getByText('The Great Book')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Jane Doe' })).toBeInTheDocument()
    expect(screen.getByText('T')).toBeInTheDocument() // placeholder initial (uppercased)
  })

  it('renders a cover image when cover_path is set', () => {
    renderCard({ item: makeItem({ cover_path: 'covers/x.png' }) })
    const img = screen.getByRole('img') as HTMLImageElement
    expect(img.src).toContain('library://covers/x.png')
  })

  it('shows "Unknown" and derives status from scroll_position when unset', () => {
    renderCard({ item: makeItem({ author: null, status: null, scroll_position: 0.5 }) })
    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reading' })).toBeInTheDocument()
  })

  it('formats the word count in K above a thousand', () => {
    renderCard({ item: makeItem({ word_count: 12_000 }) })
    expect(screen.getByText('12K words')).toBeInTheDocument()
  })

  it('shows the raw word count below a thousand', () => {
    renderCard({ item: makeItem({ word_count: 500 }) })
    expect(screen.getByText('500 words')).toBeInTheDocument()
  })

  it('closes the status menu on an outside click', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Unread' }))
    expect(screen.getByRole('button', { name: 'Auto' })).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull()
  })
})

describe('ItemCard — tags & author interactions', () => {
  it('fires onTagClick when a tag pill is clicked (without shift)', () => {
    const tags: Tag[] = [{ id: 't1', name: 'scifi', color: '#f00' }]
    const { props } = renderCard({ tags })
    fireEvent.click(screen.getByRole('button', { name: 'scifi' }))
    expect(props.onTagClick).toHaveBeenCalledWith('t1')
  })

  it('does not fire onTagClick when shift is held', () => {
    const tags: Tag[] = [{ id: 't1', name: 'scifi', color: '#f00' }]
    const { props } = renderCard({ tags })
    fireEvent.click(screen.getByRole('button', { name: 'scifi' }), { shiftKey: true })
    expect(props.onTagClick).not.toHaveBeenCalled()
  })

  it('fires onAuthorClick when the author is clicked', () => {
    const { props } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Jane Doe' }))
    expect(props.onAuthorClick).toHaveBeenCalledWith('Jane Doe')
  })
})

describe('ItemCard — inline title editing', () => {
  it('commits a changed title through the service and callback', async () => {
    const { props } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }))
    const input = screen.getByPlaceholderText('Title…')
    fireEvent.change(input, { target: { value: 'New Title' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(lib.setTitle).toHaveBeenCalledWith('item1', 'New Title')
    expect(props.onTitleChange).toHaveBeenCalledWith('New Title')
  })

  it('does not call the service when the title is unchanged or blank', async () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }))
    const input = screen.getByPlaceholderText('Title…')
    fireEvent.change(input, { target: { value: '   ' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(lib.setTitle).not.toHaveBeenCalled()
  })

  it('cancels editing on Escape without saving', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }))
    const input = screen.getByPlaceholderText('Title…')
    fireEvent.change(input, { target: { value: 'Discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(lib.setTitle).not.toHaveBeenCalled()
    expect(screen.getByText('The Great Book')).toBeInTheDocument()
  })
})

describe('ItemCard — status menu', () => {
  it('changes status through the menu, including Auto (null)', () => {
    const { props } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Unread' }))
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }))
    expect(props.onStatusChange).toHaveBeenCalledWith(null)
  })
})

describe('ItemCard — delete confirmation', () => {
  it('confirms and calls onDelete', async () => {
    const { props } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText('Delete this item?')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    })
    expect(props.onDelete).toHaveBeenCalled()
  })

  it('surfaces a delete error and keeps the card', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('still in use'))
    renderCard({ onDelete })
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    })
    expect(screen.getByText('still in use')).toBeInTheDocument()
  })

  it('cancels the confirmation', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Delete this item?')).toBeNull()
  })
})

describe('ItemCard — dropdown menu actions', () => {
  it('routes edit-tags, edit-collections, and review actions', () => {
    const { props } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit tags' }))
    expect(props.onEditTags).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to collection' }))
    expect(props.onEditCollections).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Write review' }))
    expect(props.onWriteReview).toHaveBeenCalled()
  })

  it('changes the cover via the service when a file is picked', async () => {
    lib.pickCover.mockResolvedValue('covers/new.png')
    const { props } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Change cover' }))
    })
    expect(props.onCoverChange).toHaveBeenCalledWith('covers/new.png')
  })

  it('runs an async refresh from the menu', async () => {
    const onRefresh = vi.fn().mockResolvedValue({ added: 0 })
    renderCard({ onRefresh })
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh from source' }))
    })
    expect(onRefresh).toHaveBeenCalled()
  })

  it('offers source-item actions and a "Remove from collection" entry', () => {
    const sourceItem = makeItem({ id: 'src', content_type: 'pdf' })
    const { props } = renderCard({
      sourceItem,
      onOpenSource: vi.fn(),
      onTogglePreferred: vi.fn(),
      onRemoveFromCollection: vi.fn(),
    })
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open as PDF' }))
    expect(props.onOpenSource).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Make PDF default' }))
    expect(props.onTogglePreferred).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove from collection' }))
    expect(props.onRemoveFromCollection).toHaveBeenCalled()
  })

  it('routes the Append action', () => {
    const { props } = renderCard({ onAppend: vi.fn() })
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Append chapters…' }))
    expect(props.onAppend).toHaveBeenCalled()
  })

  it('does nothing when the cover picker is cancelled', async () => {
    lib.pickCover.mockResolvedValue(null)
    const { props } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Change cover' }))
    })
    expect(props.onCoverChange).not.toHaveBeenCalled()
  })
})

describe('ItemCard — author editing, rating & review', () => {
  it('commits a changed author through the service and callback', async () => {
    const { props } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Edit author' }))
    const input = screen.getByPlaceholderText('Author name…')
    fireEvent.change(input, { target: { value: 'New Author' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(lib.setAuthor).toHaveBeenCalledWith('item1', 'New Author')
    expect(props.onAuthorChange).toHaveBeenCalledWith('New Author')
  })

  it('does not call the service when the author is unchanged', async () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Edit author' }))
    const input = screen.getByPlaceholderText('Author name…')
    fireEvent.change(input, { target: { value: 'Jane Doe' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(lib.setAuthor).not.toHaveBeenCalled()
  })

  it('cancels author editing on Escape', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Edit author' }))
    const input = screen.getByPlaceholderText('Author name…')
    fireEvent.change(input, { target: { value: 'Discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(lib.setAuthor).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Jane Doe' })).toBeInTheDocument()
  })

  it('shows the chapter range when present', () => {
    renderCard({ item: makeItem({ chapter_start: 2, chapter_end: 7 }) })
    expect(screen.getByText('Ch. 2–7')).toBeInTheDocument()
  })

  it('closes the ⋯ menu on an outside click', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    expect(screen.getByRole('button', { name: 'Edit tags' })).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('button', { name: 'Edit tags' })).toBeNull()
  })

  it('changes the rating through StarRating', () => {
    const { props } = renderCard()
    fireEvent.click(screen.getByLabelText('Rate 4 stars'))
    expect(props.onRatingChange).toHaveBeenCalledWith(4)
  })

  it('opens the review editor from the inline review text', () => {
    const { props } = renderCard({ item: makeItem({ review: 'A memorable read' }) })
    fireEvent.click(screen.getByRole('button', { name: 'A memorable read' }))
    expect(props.onWriteReview).toHaveBeenCalled()
  })
})

describe('ItemCard — memoization', () => {
  it('skips re-render on equal item data but updates when a tracked field changes', () => {
    const { props, rerender } = renderCard({ item: makeItem({ title: 'Stable' }) })
    // New item object, identical tracked fields → comparator returns true.
    rerender(<ItemCard {...props} item={makeItem({ title: 'Stable' })} />)
    expect(screen.getByText('Stable')).toBeInTheDocument()
    // Tracked field changed → comparator returns false → re-renders.
    rerender(<ItemCard {...props} item={makeItem({ title: 'Changed' })} />)
    expect(screen.getByText('Changed')).toBeInTheDocument()
  })
})
