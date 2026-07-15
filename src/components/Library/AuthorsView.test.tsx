import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useSearchParams } from 'react-router-dom'
import AuthorsView from './AuthorsView'
import type { Item } from '../../types'

vi.mock('./Sidebar', () => ({ default: () => null }))
vi.mock('../../services/library', () => ({
  collectionService: {
    getAll: vi.fn().mockResolvedValue([]),
    getAllItemCollections: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    delete: vi.fn(),
    rename: vi.fn(),
  },
  libraryService: {
    getAll: vi.fn(),
    getTrashed: vi.fn().mockResolvedValue([]),
  },
}))
import { libraryService } from '../../services/library'
const lib = libraryService as unknown as Record<string, ReturnType<typeof vi.fn>>

const item = (over: Partial<Item> = {}): Item =>
  ({ id: 'i', title: 't', author: null, ...over }) as unknown as Item

// Landing route that echoes the ?author= param so navigation is observable.
function LibraryStub() {
  const [params] = useSearchParams()
  return <div>HOME author={params.get('author')}</div>
}

function renderAuthors() {
  render(
    <MemoryRouter initialEntries={['/authors']}>
      <Routes>
        <Route path="/authors" element={<AuthorsView />} />
        <Route path="/" element={<LibraryStub />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  lib.getAll.mockResolvedValue([
    item({ id: '1', author: 'Bob' }),
    item({ id: '2', author: 'Ann' }),
    item({ id: '3', author: 'Ann' }),
    item({ id: '4', author: null }),
  ])
  lib.getTrashed.mockResolvedValue([])
})

describe('AuthorsView', () => {
  it('lists distinct authors with counts and a header total, sorted A–Z', async () => {
    renderAuthors()
    const ann = await screen.findByRole('button', { name: /Ann/ })
    expect(ann).toBeInTheDocument()
    expect(screen.getByText('2 items')).toBeInTheDocument() // Ann
    expect(screen.getByText('1 item')).toBeInTheDocument() // Bob
    expect(screen.getByText(/· 2 authors/)).toBeInTheDocument()

    // A–Z: Ann appears before Bob in the DOM order.
    const rows = screen.getAllByRole('button').filter((b) => /item/.test(b.textContent ?? ''))
    expect(rows[0]).toHaveTextContent('Ann')
    expect(rows[1]).toHaveTextContent('Bob')
  })

  it('filters authors by the search box', async () => {
    renderAuthors()
    await screen.findByRole('button', { name: /Ann/ })
    fireEvent.change(screen.getByPlaceholderText('Search authors…'), { target: { value: 'bo' } })
    expect(screen.queryByRole('button', { name: /Ann/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Bob/ })).toBeInTheDocument()
  })

  it('reorders by item count when "By count" is selected', async () => {
    renderAuthors()
    await screen.findByRole('button', { name: /Ann/ })
    fireEvent.click(screen.getByRole('button', { name: 'By count' }))
    const rows = screen.getAllByRole('button').filter((b) => /item/.test(b.textContent ?? ''))
    expect(rows[0]).toHaveTextContent('Ann') // 2 items → first
    expect(rows[1]).toHaveTextContent('Bob') // 1 item
  })

  it('navigates to the author filter when a row is clicked', async () => {
    renderAuthors()
    fireEvent.click(await screen.findByRole('button', { name: /Ann/ }))
    expect(screen.getByText('HOME author=Ann')).toBeInTheDocument()
  })

  it('shows an empty state when no items have an author', async () => {
    lib.getAll.mockResolvedValue([item({ id: '1', author: null })])
    renderAuthors()
    expect(await screen.findByText(/No authors yet/)).toBeInTheDocument()
  })

  it('surfaces a load error', async () => {
    lib.getAll.mockRejectedValue(new Error('boom'))
    renderAuthors()
    expect(await screen.findByText(/Failed to load authors: boom/)).toBeInTheDocument()
  })
})
