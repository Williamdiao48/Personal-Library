import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import EpubReader, { columnForMark, pageCount } from './EpubReader'
import type { Item, EpubBook } from '../../types'

// EpubReader parses the EPUB in the main process (readerService.loadEpub → plain
// EpubBook), so there is no epubjs to mock — just the two services and the three
// hooks. Pagination is CSS-multicolumn + transform; the two exported pure helpers
// (columnForMark / pageCount) carry the tricky math. ResizeObserver is stubbed by
// test/renderer/setup.ts; jsdom reports 0-width so page-count effects stay inert,
// which is fine for header/content smoke assertions. No ABI toggle (jsdom).

vi.mock('../../services/library', () => ({
  libraryService: { updateProgress: vi.fn() },
}))
vi.mock('../../services/reader', () => ({
  readerService: { loadEpub: vi.fn() },
}))

vi.mock('../../hooks/useReadingSession', () => ({
  useReadingSession: () => ({ recordActivity: vi.fn() }),
}))
vi.mock('../../hooks/useTextHighlight', () => ({
  useTextHighlight: () => ({ matchCount: 0, currentMatch: 0, goNext: vi.fn(), goPrev: vi.fn() }),
}))
vi.mock('../../hooks/useAnnotations', () => ({
  useAnnotations: () => ({
    annotations: [],
    applyHighlightsToDOM: vi.fn(),
    createBookmark: vi.fn(),
    createHighlight: vi.fn(),
    createNote: vi.fn(),
    updateNote: vi.fn(),
    deleteAnnotation: vi.fn(),
    swapAnnotationOrder: vi.fn(),
  }),
}))

vi.mock('./SearchBar', () => ({ default: () => <div>SEARCH BAR</div> }))
vi.mock('./TextSelectionPopup', () => ({ default: () => null }))
vi.mock('./AnnotationsPanel', () => ({ default: () => <div>ANNOTATIONS PANEL</div> }))
vi.mock('./BookmarksPanel', () => ({ default: () => <div>BOOKMARKS PANEL</div> }))
vi.mock('./NotePopover', () => ({ default: () => null }))
vi.mock('./AnnotationContextMenu', () => ({ default: () => null }))

import { libraryService } from '../../services/library'
import { readerService } from '../../services/reader'
const lib = libraryService as unknown as Record<string, ReturnType<typeof vi.fn>>
const reader = readerService as unknown as Record<string, ReturnType<typeof vi.fn>>

const mkItem = (over: Partial<Item> = {}): Item =>
  ({
    id: 'e1',
    title: 'A Book',
    content_type: 'epub',
    file_path: 'book.epub',
    source_url: null,
    scroll_position: 0,
    ...over,
  }) as Item

const mkBook = (): EpubBook => ({
  chapters: [
    { title: 'Chapter One', html: '<p>Alpha body</p>' },
    { title: 'Chapter Two', html: '<p>Beta body</p>' },
    { title: 'Chapter Three', html: '<p>Gamma body</p>' },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  reader.loadEpub.mockResolvedValue(mkBook())
})

// ── Pure helpers ────────────────────────────────────────────────────────────────
describe('columnForMark', () => {
  it('returns the current page when the mark sits at the left edge of that page', () => {
    // mark flush with outer-left, on page 2, column width 100 → logicalX = 200 → page 2
    expect(columnForMark(10, 10, 2, 100, 5)).toBe(2)
  })

  it('recovers a later column from the mark offset within the current page', () => {
    // page 0, mark 350px into the strip, width 100 → floor(350/100) = 3
    expect(columnForMark(350, 0, 0, 100, 5)).toBe(3)
  })

  // Headline A: search-activation / jump-to-annotation flip to the mark's page, so
  // the clamp into [0, totalPages-1] must hold at both ends — an out-of-range column
  // would page past the chapter.
  it('clamps below 0', () => {
    expect(columnForMark(-500, 0, 0, 100, 5)).toBe(0)
  })

  it('clamps to the last page (totalPages - 1)', () => {
    expect(columnForMark(10000, 0, 0, 100, 3)).toBe(2)
  })
})

describe('pageCount', () => {
  it('rounds rendered width over column width', () => {
    expect(pageCount(1000, 100)).toBe(10)
    expect(pageCount(160, 100)).toBe(2)
    expect(pageCount(140, 100)).toBe(1)
  })

  it('floors at 1 for empty content', () => {
    expect(pageCount(0, 100)).toBe(1)
  })

  it('guards a zero column width (no Infinity/NaN)', () => {
    expect(pageCount(500, 0)).toBe(1)
  })
})

// ── Load + render (smoke) ───────────────────────────────────────────────────────
describe('EpubReader — load states', () => {
  it('shows a loading state until the EPUB resolves', () => {
    reader.loadEpub.mockReturnValue(new Promise(() => {})) // never resolves
    render(<EpubReader item={mkItem()} onBack={() => {}} />)
    expect(screen.getByText('Loading EPUB…')).toBeInTheDocument()
  })

  it('loads and renders the first chapter', async () => {
    render(<EpubReader item={mkItem()} onBack={() => {}} />)
    expect(await screen.findByText('Alpha body')).toBeInTheDocument()
    expect(reader.loadEpub).toHaveBeenCalledWith('book.epub')
    expect(screen.getByRole('button', { name: /1\. Chapter One/ })).toBeInTheDocument()
  })

  it('surfaces a load error', async () => {
    reader.loadEpub.mockRejectedValue(new Error('bad epub'))
    render(<EpubReader item={mkItem()} onBack={() => {}} />)
    expect(await screen.findByText('bad epub')).toBeInTheDocument()
  })
})

describe('EpubReader — chapter navigation', () => {
  it('advances chapters with the next arrow (instant jump)', async () => {
    render(<EpubReader item={mkItem()} onBack={() => {}} />)
    await screen.findByText('Alpha body')
    fireEvent.click(screen.getByRole('button', { name: '›' }))
    expect(screen.getByText('Beta body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /2\. Chapter Two/ })).toBeInTheDocument()
  })
})

// ── Initial-chapter restore (Headline B) ────────────────────────────────────────
describe('EpubReader — restore', () => {
  it('restores the initial chapter from a fractional scroll_position', async () => {
    // round(0.5 * (3 - 1)) = 1 → second chapter
    render(<EpubReader item={mkItem({ scroll_position: 0.5 })} onBack={() => {}} />)
    expect(await screen.findByText('Beta body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /2\. Chapter Two/ })).toBeInTheDocument()
  })
})
