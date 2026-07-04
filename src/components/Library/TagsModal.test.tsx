import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import TagsModal from './TagsModal'
import type { Tag } from '../../types'

vi.mock('../../services/library', () => ({
  tagService: {
    create: vi.fn(),
    setForItem: vi.fn().mockResolvedValue(undefined),
  },
}))
import { tagService } from '../../services/library'
const tags = tagService as unknown as Record<string, ReturnType<typeof vi.fn>>

const tag = (over: Partial<Tag> = {}): Tag => ({ id: 't1', name: 'scifi', color: '#f00', ...over })

function renderModal(over: Partial<React.ComponentProps<typeof TagsModal>> = {}) {
  const props = {
    itemId: 'i1',
    itemTitle: 'Dune',
    allTags: [tag()] as Tag[],
    itemTagIds: new Set<string>(),
    onClose: vi.fn(),
    ...over,
  }
  render(<TagsModal {...props} />)
  return props
}

beforeEach(() => vi.clearAllMocks())

describe('TagsModal', () => {
  it('renders tags and reflects the pre-selected ones', () => {
    renderModal({ itemTagIds: new Set(['t1']) })
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(screen.getByText('scifi')).toBeInTheDocument()
  })

  it('saves the selected tag ids and closes', async () => {
    const props = renderModal()
    fireEvent.click(screen.getByRole('checkbox')) // select t1
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(tags.setForItem).toHaveBeenCalledWith('i1', ['t1'])
    expect(props.onClose).toHaveBeenCalled()
  })

  it('creates a new tag and auto-selects it', async () => {
    tags.create.mockResolvedValue(tag({ id: 't2', name: 'fantasy', color: '#0f0' }))
    renderModal()
    fireEvent.change(screen.getByPlaceholderText('Tag name'), { target: { value: 'fantasy' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '+ Add' }))
    })
    expect(tags.create).toHaveBeenCalledWith('fantasy', '#7c6aff')
    expect(screen.getByText('fantasy')).toBeInTheDocument()
  })

  it('deselects a pre-selected tag', async () => {
    renderModal({ itemTagIds: new Set(['t1']) })
    fireEvent.click(screen.getByRole('checkbox')) // toggle off
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    expect(tags.setForItem).toHaveBeenCalledWith('i1', [])
  })

  it('ignores a blank new-tag submission', async () => {
    renderModal()
    await act(async () => {
      fireEvent.submit(screen.getByPlaceholderText('Tag name').closest('form')!)
    })
    expect(tags.create).not.toHaveBeenCalled()
  })

  it('shows an empty state and disables Add for a blank name', () => {
    renderModal({ allTags: [] })
    expect(screen.getByText(/No tags yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Add' })).toBeDisabled()
  })

  it('closes on Cancel', () => {
    const props = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onClose).toHaveBeenCalled()
  })
})
