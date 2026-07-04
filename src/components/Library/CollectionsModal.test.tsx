import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import CollectionsModal from './CollectionsModal'
import type { Collection } from '../../types'

vi.mock('../../services/library', () => ({
  collectionService: {
    create: vi.fn(),
    setForItem: vi.fn().mockResolvedValue(undefined),
  },
}))
import { collectionService } from '../../services/library'
const coll = collectionService as unknown as Record<string, ReturnType<typeof vi.fn>>

const collection = (over: Partial<Collection> = {}): Collection =>
  ({ id: 'c1', name: 'Favorites', created_at: 0, ...over }) as Collection

function renderModal(over: Partial<React.ComponentProps<typeof CollectionsModal>> = {}) {
  const props = {
    itemId: 'i1',
    itemTitle: 'Dune',
    allCollections: [collection()] as Collection[],
    itemCollectionIds: new Set<string>(),
    onClose: vi.fn(),
    ...over,
  }
  render(<CollectionsModal {...props} />)
  return props
}

beforeEach(() => vi.clearAllMocks())

describe('CollectionsModal', () => {
  it('renders collections and reflects the pre-selected ones', () => {
    renderModal({ itemCollectionIds: new Set(['c1']) })
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(screen.getByText('Favorites')).toBeInTheDocument()
  })

  it('saves the selected collection ids and closes', async () => {
    const props = renderModal()
    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(coll.setForItem).toHaveBeenCalledWith('i1', ['c1'])
    expect(props.onClose).toHaveBeenCalled()
  })

  it('creates a new collection and auto-selects it', async () => {
    coll.create.mockResolvedValue(collection({ id: 'c2', name: 'To Read' }))
    renderModal()
    fireEvent.change(screen.getByPlaceholderText('Collection name'), {
      target: { value: 'To Read' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '+ Create' }))
    })
    expect(coll.create).toHaveBeenCalledWith('To Read')
    expect(screen.getByText('To Read')).toBeInTheDocument()
  })

  it('deselects a pre-selected collection', async () => {
    renderModal({ itemCollectionIds: new Set(['c1']) })
    fireEvent.click(screen.getByRole('checkbox')) // toggle off
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(coll.setForItem).toHaveBeenCalledWith('i1', [])
  })

  it('ignores a blank new-collection submission', async () => {
    renderModal()
    await act(async () => {
      fireEvent.submit(screen.getByPlaceholderText('Collection name').closest('form')!)
    })
    expect(coll.create).not.toHaveBeenCalled()
  })

  it('shows an empty state and disables Create for a blank name', () => {
    renderModal({ allCollections: [] })
    expect(screen.getByText(/No collections yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Create' })).toBeDisabled()
  })

  it('closes on Cancel', () => {
    const props = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onClose).toHaveBeenCalled()
  })
})
