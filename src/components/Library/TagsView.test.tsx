import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import TagsView from './TagsView'
import type { Tag } from '../../types'

vi.mock('./Sidebar', () => ({ default: () => null }))
vi.mock('../../services/library', () => ({
  tagService: {
    getAll: vi.fn(),
    getItemCounts: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    setColor: vi.fn(),
    delete: vi.fn(),
  },
  collectionService: {
    getAll: vi.fn().mockResolvedValue([]),
    getAllItemCollections: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    delete: vi.fn(),
    rename: vi.fn(),
  },
  libraryService: {
    getAll: vi.fn().mockResolvedValue([]),
    getTrashed: vi.fn().mockResolvedValue([]),
  },
}))
import { tagService } from '../../services/library'
const tags = tagService as unknown as Record<string, ReturnType<typeof vi.fn>>

const tag = (over: Partial<Tag> = {}): Tag => ({
  id: 't1',
  name: 'scifi',
  color: '#ff0000',
  ...over,
})

function renderTags() {
  render(
    <MemoryRouter initialEntries={['/tags']}>
      <Routes>
        <Route path="/tags" element={<TagsView />} />
        <Route path="/" element={<div>LIBRARY HOME</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  tags.getAll.mockResolvedValue([tag()])
  tags.getItemCounts.mockResolvedValue([{ tag_id: 't1', count: 3 }])
})

describe('TagsView', () => {
  it('lists tags with their item counts and a header total', async () => {
    renderTags()
    expect(await screen.findByRole('button', { name: 'scifi' })).toBeInTheDocument()
    expect(screen.getByText('3 items')).toBeInTheDocument()
    expect(screen.getByText(/· 1 tag/)).toBeInTheDocument()
  })

  it('shows an empty state when there are no tags', async () => {
    tags.getAll.mockResolvedValue([])
    tags.getItemCounts.mockResolvedValue([])
    renderTags()
    expect(await screen.findByText(/No tags yet/)).toBeInTheDocument()
  })

  it('shows an error message when tags fail to load (RED-2)', async () => {
    tags.getAll.mockRejectedValue(new Error('db is locked'))
    renderTags()
    expect(await screen.findByText(/Failed to load tags: db is locked/)).toBeInTheDocument()
    expect(screen.queryByText(/No tags yet/)).toBeNull()
  })

  it('creates a tag through the form', async () => {
    tags.create.mockResolvedValue(tag({ id: 't2', name: 'fantasy' }))
    renderTags()
    await screen.findByRole('button', { name: 'scifi' })
    fireEvent.change(screen.getByPlaceholderText('Tag name'), { target: { value: 'fantasy' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '+ Create' }))
    })
    expect(tags.create).toHaveBeenCalledWith('fantasy', '#7c6aff')
    expect(await screen.findByRole('button', { name: 'fantasy' })).toBeInTheDocument()
  })

  it('renames a tag inline on Enter', async () => {
    renderTags()
    fireEvent.click(await screen.findByRole('button', { name: 'scifi' }))
    const input = screen.getByDisplayValue('scifi')
    fireEvent.change(input, { target: { value: 'science' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(tags.rename).toHaveBeenCalledWith('t1', 'science')
  })

  it('deletes a tag after confirming', async () => {
    renderTags()
    await screen.findByRole('button', { name: 'scifi' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete scifi' }))
    expect(screen.getByText(/Remove from 3 items\?/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(tags.delete).toHaveBeenCalledWith('t1')
    expect(screen.queryByRole('button', { name: 'scifi' })).toBeNull()
  })

  it('updates a tag color via the color input', async () => {
    renderTags()
    await screen.findByRole('button', { name: 'scifi' })
    const colorInput = document.querySelector('.tag-row input[type="color"]') as HTMLInputElement
    fireEvent.change(colorInput, { target: { value: '#00ff00' } })
    expect(tags.setColor).toHaveBeenCalledWith('t1', '#00ff00')
  })

  it('navigates to the filtered library from the count button', async () => {
    renderTags()
    await screen.findByRole('button', { name: 'scifi' })
    fireEvent.click(screen.getByRole('button', { name: '3 items' }))
    expect(screen.getByText('LIBRARY HOME')).toBeInTheDocument()
  })
})
