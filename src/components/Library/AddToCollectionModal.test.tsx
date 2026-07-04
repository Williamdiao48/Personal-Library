import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import AddToCollectionModal from './AddToCollectionModal'
import type { Item } from '../../types'

vi.mock('../../services/library', () => ({
  libraryService: { getAll: vi.fn() },
  collectionService: { addItem: vi.fn().mockResolvedValue(undefined) },
}))
import { libraryService, collectionService } from '../../services/library'
const lib = libraryService as unknown as Record<string, ReturnType<typeof vi.fn>>
const coll = collectionService as unknown as Record<string, ReturnType<typeof vi.fn>>

const mkItem = (over: Partial<Item> = {}): Item =>
  ({ id: 'i1', title: 'Dune', author: 'Herbert', content_type: 'epub', ...over }) as Item

function renderModal(over: Partial<React.ComponentProps<typeof AddToCollectionModal>> = {}) {
  const props = {
    collectionId: 'c1',
    collectionName: 'Favorites',
    existingItemIds: new Set<string>(),
    onAdd: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  render(<AddToCollectionModal {...props} />)
  return props
}

beforeEach(() => vi.clearAllMocks())

describe('AddToCollectionModal', () => {
  it('lists library items, excluding ones already in the collection', async () => {
    lib.getAll.mockResolvedValue([mkItem(), mkItem({ id: 'i2', title: 'Hyperion' })])
    renderModal({ existingItemIds: new Set(['i2']) })
    expect(await screen.findByText('Dune')).toBeInTheDocument()
    expect(screen.queryByText('Hyperion')).toBeNull()
  })

  it('filters by title/author as you type', async () => {
    lib.getAll.mockResolvedValue([
      mkItem(),
      mkItem({ id: 'i2', title: 'Hyperion', author: 'Simmons' }),
    ])
    renderModal()
    await screen.findByText('Dune')
    fireEvent.change(screen.getByPlaceholderText('Search by title or author…'), {
      target: { value: 'simm' },
    })
    expect(screen.getByText('Hyperion')).toBeInTheDocument()
    expect(screen.queryByText('Dune')).toBeNull()
  })

  it('adds an item and removes it from the list', async () => {
    lib.getAll.mockResolvedValue([mkItem()])
    const props = renderModal()
    await screen.findByText('Dune')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '+ Add' }))
    })
    expect(coll.addItem).toHaveBeenCalledWith('c1', 'i1')
    expect(props.onAdd).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Dune')).toBeNull())
  })

  it('shows the appropriate empty states', async () => {
    lib.getAll.mockResolvedValue([])
    renderModal()
    expect(await screen.findByText(/already in this collection/)).toBeInTheDocument()
  })

  it('shows a no-matches message for a fruitless search', async () => {
    lib.getAll.mockResolvedValue([mkItem()])
    renderModal()
    await screen.findByText('Dune')
    fireEvent.change(screen.getByPlaceholderText('Search by title or author…'), {
      target: { value: 'zzz' },
    })
    expect(screen.getByText('No matches.')).toBeInTheDocument()
  })

  it('closes via the ✕ button', async () => {
    lib.getAll.mockResolvedValue([])
    const props = renderModal()
    await screen.findByText(/already in this collection/)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(props.onClose).toHaveBeenCalled()
  })
})
