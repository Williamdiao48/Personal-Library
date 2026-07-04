import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import ReviewModal from './ReviewModal'
import type { Item } from '../../types'

vi.mock('../../services/library', () => ({
  libraryService: {
    setReview: vi.fn().mockResolvedValue(undefined),
    setRating: vi.fn().mockResolvedValue(undefined),
  },
}))
import { libraryService } from '../../services/library'
const lib = libraryService as unknown as Record<string, ReturnType<typeof vi.fn>>

const item = (over: Partial<Item> = {}): Item =>
  ({ id: 'i1', title: 'My Book', review: null, rating: null, ...over }) as Item

beforeEach(() => vi.clearAllMocks())

describe('ReviewModal', () => {
  it('opens straight into edit mode when there is no review yet', () => {
    render(<ReviewModal item={item()} onClose={vi.fn()} onSave={vi.fn()} />)
    expect(screen.getByPlaceholderText('Write your thoughts…')).toBeInTheDocument()
  })

  it('shows the existing review in read mode with an edit affordance', () => {
    render(<ReviewModal item={item({ review: 'Loved it' })} onClose={vi.fn()} onSave={vi.fn()} />)
    expect(screen.getByText('Loved it')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Write your thoughts…')).toBeNull()
    fireEvent.click(screen.getByTitle('Edit review'))
    expect(screen.getByPlaceholderText('Write your thoughts…')).toBeInTheDocument()
  })

  it('saves review text and rating through the service', async () => {
    const onSave = vi.fn()
    render(<ReviewModal item={item()} onClose={vi.fn()} onSave={onSave} />)
    fireEvent.change(screen.getByPlaceholderText('Write your thoughts…'), {
      target: { value: 'Great read' },
    })
    fireEvent.click(screen.getByLabelText('Rate 4 stars'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(lib.setReview).toHaveBeenCalledWith('i1', 'Great read')
    expect(lib.setRating).toHaveBeenCalledWith('i1', 4)
    expect(onSave).toHaveBeenCalledWith('Great read', 4)
  })

  it('closes when saving an empty review', async () => {
    const onClose = vi.fn()
    render(<ReviewModal item={item()} onClose={onClose} onSave={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(lib.setReview).toHaveBeenCalledWith('i1', null)
    expect(onClose).toHaveBeenCalled()
  })

  it('cancel reverts to read mode when a review already exists', () => {
    render(<ReviewModal item={item({ review: 'Original' })} onClose={vi.fn()} onSave={vi.fn()} />)
    fireEvent.click(screen.getByTitle('Edit review'))
    fireEvent.change(screen.getByPlaceholderText('Write your thoughts…'), {
      target: { value: 'edited' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Original')).toBeInTheDocument()
  })

  it('cancel closes when there is no existing review', () => {
    const onClose = vi.fn()
    render(<ReviewModal item={item()} onClose={onClose} onSave={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
