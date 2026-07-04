import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import TrashView from './TrashView'
import type { Item } from '../../types'

vi.mock('../../services/library', () => ({
  libraryService: {
    getTrashed: vi.fn(),
    restore: vi.fn().mockResolvedValue(undefined),
    permanentlyDelete: vi.fn().mockResolvedValue(undefined),
    emptyTrash: vi.fn().mockResolvedValue(undefined),
  },
}))
import { libraryService } from '../../services/library'
const lib = libraryService as unknown as Record<string, ReturnType<typeof vi.fn>>

const DAY = 24 * 60 * 60 * 1000
const trashed = (over: Partial<Item> = {}): Item =>
  ({
    id: 'i1',
    title: 'Old Book',
    author: 'Ann',
    content_type: 'epub',
    cover_path: null,
    deleted_at: Date.now(),
    ...over,
  }) as Item

function renderTrash() {
  render(
    <MemoryRouter initialEntries={['/trash']}>
      <Routes>
        <Route path="/trash" element={<TrashView />} />
        <Route path="/" element={<div>LIBRARY HOME</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('TrashView', () => {
  it('lists trashed items with the countdown to permanent deletion', async () => {
    lib.getTrashed.mockResolvedValue([trashed()])
    renderTrash()
    expect(await screen.findByText('Old Book')).toBeInTheDocument()
    expect(screen.getByText(/Deleted today/)).toBeInTheDocument()
    expect(screen.getByText(/30 days until permanent deletion/)).toBeInTheDocument()
  })

  it('marks very old items as pending purge', async () => {
    lib.getTrashed.mockResolvedValue([trashed({ deleted_at: Date.now() - 40 * DAY })])
    renderTrash()
    expect(await screen.findByText(/Will be purged on next launch/)).toBeInTheDocument()
  })

  it('renders a cover image when the item has one', async () => {
    lib.getTrashed.mockResolvedValue([trashed({ cover_path: 'covers/x.png' })])
    renderTrash()
    await screen.findByText('Old Book')
    const img = document.querySelector('.trash-row-cover img') as HTMLImageElement
    expect(img.src).toContain('library://covers/x.png')
  })

  it('shows the empty state when the trash is empty', async () => {
    lib.getTrashed.mockResolvedValue([])
    renderTrash()
    expect(await screen.findByText('Trash is empty')).toBeInTheDocument()
  })

  it('restores an item and removes its row', async () => {
    lib.getTrashed.mockResolvedValue([trashed()])
    renderTrash()
    await screen.findByText('Old Book')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    })
    expect(lib.restore).toHaveBeenCalledWith('i1')
    expect(screen.queryByText('Old Book')).toBeNull()
  })

  it('requires a two-step confirm to delete forever', async () => {
    lib.getTrashed.mockResolvedValue([trashed()])
    renderTrash()
    await screen.findByText('Old Book')
    fireEvent.click(screen.getByRole('button', { name: 'Delete Forever' }))
    expect(lib.permanentlyDelete).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Sure?' })).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sure?' }))
    })
    expect(lib.permanentlyDelete).toHaveBeenCalledWith('i1')
  })

  it('empties the trash and navigates home after confirming', async () => {
    lib.getTrashed.mockResolvedValue([trashed()])
    renderTrash()
    await screen.findByText('Old Book')
    fireEvent.click(screen.getByRole('button', { name: 'Empty Trash' }))
    const confirm = screen.getByRole('button', { name: /Empty Trash \(1\)/ })
    await act(async () => {
      fireEvent.click(confirm)
    })
    expect(lib.emptyTrash).toHaveBeenCalled()
    expect(screen.getByText('LIBRARY HOME')).toBeInTheDocument()
  })

  it('navigates back to the library', async () => {
    lib.getTrashed.mockResolvedValue([])
    renderTrash()
    await screen.findByText('Trash is empty')
    fireEvent.click(screen.getByRole('button', { name: '← Back to Library' }))
    expect(screen.getByText('LIBRARY HOME')).toBeInTheDocument()
  })
})
