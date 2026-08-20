import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import EpubReader, {
  columnForMark,
  pageCount,
  chapterNumbers,
  activeNavEntry,
  isSelfNumbered,
} from './EpubReader'
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
  readerService: { loadEpub: vi.fn(), resyncFocus: vi.fn() },
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

import { readerService } from '../../services/reader'
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
    // Named (not self-numbered) chapters, so the reader's own numbering applies.
    { title: 'The Shire', html: '<p>Alpha body</p>', frontMatter: false },
    { title: 'Rivendell', html: '<p>Beta body</p>', frontMatter: false },
    { title: 'Moria', html: '<p>Gamma body</p>', frontMatter: false },
  ],
  toc: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  reader.loadEpub.mockResolvedValue(mkBook())
})

// ── Pure helpers ────────────────────────────────────────────────────────────────
describe('chapterNumbers', () => {
  it('numbers only body chapters, skipping front/back matter', () => {
    const nums = chapterNumbers([
      { frontMatter: true }, // Cover
      { frontMatter: true }, // Title Page
      { frontMatter: false }, // Chapter → 1
      { frontMatter: false }, // Chapter → 2
      { frontMatter: true }, // Epilogue
      { frontMatter: false }, // Chapter → 3
    ])
    expect(nums).toEqual([null, null, 1, 2, null, 3])
  })

  it('numbers every chapter when there is no front matter', () => {
    expect(chapterNumbers([{ frontMatter: false }, { frontMatter: false }])).toEqual([1, 2])
  })

  it('returns all-null when every entry is matter', () => {
    expect(chapterNumbers([{ frontMatter: true }, { frontMatter: true }])).toEqual([null, null])
  })
})

describe('isSelfNumbered', () => {
  const e = (title: string, frontMatter = false) => ({ title, frontMatter })

  it('detects a book whose labels already carry numbers ("1: …", "Chapter 3")', () => {
    expect(
      isSelfNumbered([e('1: STORMBLESSED'), e('2: HONOR IS DEAD'), e('3: CITY OF BELLS')]),
    ).toBe(true)
    expect(
      isSelfNumbered([e('Chapter 1 - Funeral Voices'), e('Chapter 2 - Heaven'), e('Chapter 3')]),
    ).toBe(true)
  })

  it('is false when labels are bare names (we should add numbers)', () => {
    expect(isSelfNumbered([e('EAGLE STRIKE'), e('The Gift'), e('Trapped')])).toBe(false)
  })

  it('ignores front matter and tolerates a few section headers (majority rules)', () => {
    // Cover/Contents excluded; Part header is a minority among numbered chapters.
    expect(
      isSelfNumbered([
        e('Cover', true),
        e('Part One: Above Silence'),
        e('1: STORMBLESSED'),
        e('2: HONOR IS DEAD'),
        e('3: CITY OF BELLS'),
      ]),
    ).toBe(true)
  })

  it('needs at least three body entries to decide', () => {
    expect(isSelfNumbered([e('1. One'), e('2. Two')])).toBe(false)
  })
})

describe('activeNavEntry', () => {
  const toc = [
    { chapterIndex: 2 }, // Maps
    { chapterIndex: 3 }, // Chapter One (spans spine 3–4)
    { chapterIndex: 5 }, // Chapter Two
  ]

  it('picks the last entry at or before the current spine chapter', () => {
    expect(activeNavEntry(toc, 3)).toBe(1) // in Chapter One
    expect(activeNavEntry(toc, 4)).toBe(1) // still Chapter One (its continuation file)
    expect(activeNavEntry(toc, 5)).toBe(2) // Chapter Two
  })

  it('returns -1 before the first entry, and clamps to the last', () => {
    expect(activeNavEntry(toc, 0)).toBe(-1)
    expect(activeNavEntry(toc, 99)).toBe(2)
  })
})

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
    expect(screen.getByRole('button', { name: /1\. The Shire/ })).toBeInTheDocument()
  })

  it('surfaces a load error', async () => {
    reader.loadEpub.mockRejectedValue(new Error('bad epub'))
    render(<EpubReader item={mkItem()} onBack={() => {}} />)
    expect(await screen.findByText('bad epub')).toBeInTheDocument()
  })
})

describe('EpubReader — TOC-driven chapter list', () => {
  // A Calibre-split shape: spine files all share the book <title>, real chapters
  // live in the TOC. The dropdown must show TOC labels (numbered from the body),
  // never the repeated spine title.
  const mkTocBook = (): EpubBook => ({
    chapters: [
      { title: 'Fire in the Sky', html: '<p>Alpha body</p>', frontMatter: false },
      { title: 'Fire in the Sky', html: '<p>Beta body</p>', frontMatter: false },
      { title: 'Fire in the Sky', html: '<p>Gamma body</p>', frontMatter: false },
    ],
    toc: [
      { title: 'Maps', chapterIndex: 0, frontMatter: true },
      { title: 'Chapter One', chapterIndex: 1, frontMatter: false },
      { title: 'Chapter Two', chapterIndex: 2, frontMatter: false },
    ],
  })

  it('lists TOC chapters (numbered from the body), not the repeated spine title', async () => {
    reader.loadEpub.mockResolvedValue(mkTocBook())
    render(<EpubReader item={mkItem()} onBack={() => {}} />)
    await screen.findByText('Alpha body')

    // Open the chapter dropdown (label reflects the active TOC entry: "Maps").
    fireEvent.click(screen.getByRole('button', { name: /Maps/ }))

    expect(screen.getByRole('button', { name: /1\. Chapter One/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /2\. Chapter Two/ })).toBeInTheDocument()
    // The repeated spine title never appears as a chapter entry.
    expect(screen.queryByText('Fire in the Sky')).not.toBeInTheDocument()
  })

  it('does not add its own numbers when the book already self-numbers its labels', async () => {
    reader.loadEpub.mockResolvedValue({
      chapters: [
        { title: 'x', html: '<p>Alpha body</p>', frontMatter: false },
        { title: 'x', html: '<p>Beta body</p>', frontMatter: false },
        { title: 'x', html: '<p>Gamma body</p>', frontMatter: false },
      ],
      toc: [
        { title: 'Chapter 1 - The Gift', chapterIndex: 0, frontMatter: false },
        { title: 'Chapter 2 - Trapped', chapterIndex: 1, frontMatter: false },
        { title: 'Chapter 3 - Escape', chapterIndex: 2, frontMatter: false },
      ],
    } as EpubBook)
    render(<EpubReader item={mkItem()} onBack={() => {}} />)
    await screen.findByText('Alpha body')
    fireEvent.click(screen.getByRole('button', { name: /Chapter 1 - The Gift/ }))

    // Labels verbatim — no prepended "1. Chapter 1".
    expect(screen.getByRole('button', { name: /^Chapter 2 - Trapped$/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /\d+\.\s*Chapter 2/ })).not.toBeInTheDocument()
  })
})

describe('EpubReader — chapter navigation', () => {
  it('advances chapters with the next arrow (instant jump)', async () => {
    render(<EpubReader item={mkItem()} onBack={() => {}} />)
    await screen.findByText('Alpha body')
    fireEvent.click(screen.getByRole('button', { name: '›' }))
    expect(screen.getByText('Beta body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /2\. Rivendell/ })).toBeInTheDocument()
  })
})

// ── Initial-chapter restore (Headline B) ────────────────────────────────────────
describe('EpubReader — restore', () => {
  it('restores the initial chapter from a fractional scroll_position', async () => {
    // round(0.5 * (3 - 1)) = 1 → second chapter
    render(<EpubReader item={mkItem({ scroll_position: 0.5 })} onBack={() => {}} />)
    expect(await screen.findByText('Beta body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /2\. Rivendell/ })).toBeInTheDocument()
  })
})
