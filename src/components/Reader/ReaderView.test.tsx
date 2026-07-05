import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ReaderView from './ReaderView'
import type { Item } from '../../types'

// HtmlReader stub surfaces onReloadContent + onBack as buttons so the reader's
// inline callbacks get exercised.
vi.mock('./HtmlReader', () => ({
  default: (p: { onReloadContent?: () => void; onBack?: () => void }) => (
    <div>
      HTML READER
      <button onClick={() => p.onReloadContent?.()}>reload</button>
      <button onClick={() => p.onBack?.()}>back</button>
    </div>
  ),
}))
vi.mock('./EpubReader', () => ({ default: () => <div>EPUB READER</div> }))
vi.mock('./PdfReader', () => ({ default: () => <div>PDF READER</div> }))

vi.mock('../../services/library', () => ({
  libraryService: {
    getById: vi.fn(),
    updateProgress: vi.fn(),
    refresh: vi.fn().mockResolvedValue({ changed: false }),
    getAll: vi.fn().mockResolvedValue([]),
  },
}))
vi.mock('../../services/reader', () => ({
  readerService: {
    loadContent: vi.fn().mockResolvedValue('<p>body</p>'),
    getChapterCount: vi.fn().mockResolvedValue(3),
    loadChapter: vi.fn().mockResolvedValue('<p>ch0</p>'),
  },
}))
import { libraryService } from '../../services/library'
import { readerService } from '../../services/reader'
const lib = libraryService as unknown as Record<string, ReturnType<typeof vi.fn>>
const reader = readerService as unknown as Record<string, ReturnType<typeof vi.fn>>

const mkItem = (over: Partial<Item> = {}): Item =>
  ({
    id: 'i1',
    title: 'A Story',
    content_type: 'article',
    file_path: 'i1.html',
    source_url: null,
    scroll_position: 0,
    ...over,
  }) as Item

function renderReader(id = 'i1') {
  render(
    <MemoryRouter initialEntries={[`/read/${id}`]}>
      <Routes>
        <Route path="/read/:id" element={<ReaderView />} />
        <Route path="/" element={<div>LIBRARY HOME</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  lib.refresh.mockResolvedValue({ changed: false })
  lib.getAll.mockResolvedValue([])
  reader.loadContent.mockResolvedValue('<p>body</p>')
  reader.getChapterCount.mockResolvedValue(3)
  reader.loadChapter.mockResolvedValue('<p>ch0</p>')
})

describe('ReaderView — routing by content type', () => {
  it('loads a legacy single-file article into the HtmlReader', async () => {
    lib.getById.mockResolvedValue(mkItem({ file_path: 'i1.html' }))
    renderReader()
    expect(await screen.findByText('HTML READER')).toBeInTheDocument()
    expect(reader.loadContent).toHaveBeenCalledWith('i1.html')
    expect(lib.updateProgress).toHaveBeenCalledWith('i1', 0)
  })

  it('lazy-loads a multi-chapter article (first chapter + count)', async () => {
    lib.getById.mockResolvedValue(mkItem({ file_path: 'story-ch0.html' }))
    renderReader()
    expect(await screen.findByText('HTML READER')).toBeInTheDocument()
    expect(reader.getChapterCount).toHaveBeenCalledWith('story-ch0.html')
    expect(reader.loadChapter).toHaveBeenCalledWith('story-ch0.html', 0)
    expect(reader.loadContent).not.toHaveBeenCalled()
  })

  it('renders a PDF and checks for a derived EPUB', async () => {
    lib.getById.mockResolvedValue(mkItem({ content_type: 'pdf' }))
    lib.getAll.mockResolvedValue([mkItem({ id: 'e1', content_type: 'epub', derived_from: 'i1' })])
    renderReader()
    expect(await screen.findByText('PDF READER')).toBeInTheDocument()
    expect(lib.getAll).toHaveBeenCalled()
  })

  it('renders an EPUB', async () => {
    lib.getById.mockResolvedValue(mkItem({ content_type: 'epub' }))
    renderReader()
    expect(await screen.findByText('EPUB READER')).toBeInTheDocument()
  })

  it('kicks off a background refresh for an article with a source URL', async () => {
    lib.getById.mockResolvedValue(mkItem({ source_url: 'https://x.com/story' }))
    renderReader()
    await screen.findByText('HTML READER')
    expect(lib.refresh).toHaveBeenCalledWith('i1')
  })

  it('reloads content when the reader requests it', async () => {
    lib.getById.mockResolvedValue(mkItem())
    renderReader()
    await screen.findByText('HTML READER')
    await act(async () => {
      fireEvent.click(screen.getByText('reload'))
    })
    expect(lib.getById).toHaveBeenCalledTimes(2)
    expect(reader.loadContent).toHaveBeenCalledTimes(2)
  })

  it('reloads via lazy chapters for a multi-chapter article', async () => {
    lib.getById.mockResolvedValue(mkItem({ file_path: 'story-ch0.html' }))
    renderReader()
    await screen.findByText('HTML READER')
    await act(async () => {
      fireEvent.click(screen.getByText('reload'))
    })
    expect(reader.getChapterCount).toHaveBeenCalledTimes(2)
    expect(reader.loadChapter).toHaveBeenCalledTimes(2)
  })

  it('navigates back to the library from the reader', async () => {
    lib.getById.mockResolvedValue(mkItem())
    renderReader()
    await screen.findByText('HTML READER')
    fireEvent.click(screen.getByText('back'))
    expect(screen.getByText('LIBRARY HOME')).toBeInTheDocument()
  })
})

describe('ReaderView — edge cases', () => {
  it('redirects to the library when the item is not found', async () => {
    lib.getById.mockResolvedValue(null)
    renderReader('missing')
    expect(await screen.findByText('LIBRARY HOME')).toBeInTheDocument()
  })

  it('shows a load error when content fails to load', async () => {
    lib.getById.mockResolvedValue(mkItem())
    reader.loadContent.mockRejectedValue(new Error('missing file'))
    renderReader()
    expect(await screen.findByText(/Could not load content/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to library' })).toBeInTheDocument()
  })

  it('shows a loading state until the item resolves', () => {
    lib.getById.mockReturnValue(new Promise(() => {})) // never resolves
    renderReader()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })
})
