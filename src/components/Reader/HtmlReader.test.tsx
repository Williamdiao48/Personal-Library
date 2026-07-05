import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import HtmlReader, { parseChapters, parseSingleChapter } from './HtmlReader'
import type { Item } from '../../types'

// HtmlReader is pure DOM (no canvas/pdfjs). We mock the two services it calls and
// the three hooks it consumes (all covered by their own suites) so the render tests
// exercise HtmlReader's own wiring — mode selection, chapter nav, restore math — in
// isolation. Heavy children are stubbed to inert markers. No ABI toggle (jsdom).

vi.mock('../../services/library', () => ({
  libraryService: {
    updateProgress: vi.fn(),
    saveScrollPos: vi.fn(),
  },
}))
vi.mock('../../services/reader', () => ({
  readerService: {
    loadChapter: vi.fn().mockResolvedValue('<p>lazy body</p>'),
  },
}))

// Hooks: canned returns. useAnnotations must expose every member HtmlReader reads.
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

// Heavy children — inert. TextSelectionPopup is a self-mounting popup we don't drive.
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
    id: 'i1',
    title: 'A Story',
    content_type: 'article',
    file_path: 'i1.html',
    source_url: null,
    scroll_position: 0,
    ...over,
  }) as Item

// Legacy single-file multi-chapter document (the `.chapter` / `.chapter-title` shape
// parseChapters splits on).
const threeChapterHtml =
  '<div class="chapter"><h2 class="chapter-title">One</h2><p>First chapter body</p></div>' +
  '<div class="chapter"><h2 class="chapter-title">Two</h2><p>Second chapter body</p></div>' +
  '<div class="chapter"><h2 class="chapter-title">Three</h2><p>Third chapter body</p></div>'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  reader.loadChapter.mockResolvedValue('<p>lazy body</p>')
  // jsdom implements neither; the rAF scroll-restore effects call both.
  Element.prototype.scrollTo = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

// ── Pure helpers ────────────────────────────────────────────────────────────────
describe('parseChapters', () => {
  it('returns titled chapters for a document with >=2 .chapter divs', () => {
    const chapters = parseChapters(threeChapterHtml)
    expect(chapters).not.toBeNull()
    expect(chapters).toHaveLength(3)
    expect(chapters!.map((c) => c.title)).toEqual(['One', 'Two', 'Three'])
    expect(chapters![0].html).toContain('First chapter body')
  })

  it('falls back to "Chapter N" when a .chapter has no .chapter-title', () => {
    const html = '<div class="chapter"><p>a</p></div><div class="chapter"><p>b</p></div>'
    expect(parseChapters(html)!.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2'])
  })

  // Headline A: the null-guard at <2 .chapter divs is what selects single-article mode
  // over paged mode. Exactly one .chapter must NOT be treated as multi-chapter.
  it('returns null for a document with a single .chapter div', () => {
    expect(parseChapters('<div class="chapter"><p>only</p></div>')).toBeNull()
  })

  it('returns null for a document with no .chapter divs', () => {
    expect(parseChapters('<p>just an article</p>')).toBeNull()
  })
})

describe('parseSingleChapter', () => {
  it('extracts title + body from a per-chapter file', () => {
    const html = '<div class="chapter"><h2 class="chapter-title">Ch 5</h2><p>body</p></div>'
    const ch = parseSingleChapter(html, 4)
    expect(ch.title).toBe('Ch 5')
    expect(ch.html).toContain('body')
  })

  it('falls back to "Chapter N" (1-based) when there is no .chapter div', () => {
    const ch = parseSingleChapter('<p>raw</p>', 2)
    expect(ch.title).toBe('Chapter 3')
    expect(ch.html).toBe('<p>raw</p>')
  })
})

// ── Mode selection (render) ─────────────────────────────────────────────────────
describe('HtmlReader — mode selection', () => {
  it('renders a single .chapter document as a single-page article (not paged)', () => {
    const { container } = render(
      <HtmlReader
        item={mkItem()}
        content='<div class="chapter"><p>solo article</p></div>'
        onBack={() => {}}
      />,
    )
    expect(container.querySelector('.reader-progress-track')).not.toBeNull()
    expect(screen.queryByText('Next →')).toBeNull()
    expect(screen.getByText('solo article')).toBeInTheDocument()
  })

  it('renders a >=2 .chapter document in paged multi-chapter mode', () => {
    render(<HtmlReader item={mkItem()} content={threeChapterHtml} onBack={() => {}} />)
    expect(screen.getByText('First chapter body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next →' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /1\. One/ })).toBeInTheDocument()
  })
})

// ── Chapter navigation (render + debounced save) ────────────────────────────────
describe('HtmlReader — chapter navigation', () => {
  it('advances to the next chapter and debounce-saves the new progress', () => {
    vi.useFakeTimers()
    try {
      render(<HtmlReader item={mkItem()} content={threeChapterHtml} onBack={() => {}} />)
      expect(screen.getByText('First chapter body')).toBeInTheDocument()

      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }))
      })
      expect(screen.getByText('Second chapter body')).toBeInTheDocument()

      // scheduleSaveProgress is debounced SAVE_DEBOUNCE_MS (1000ms).
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      // 3 chapters, moved to index 1 → fraction 1/(3-1) = 0.5
      expect(lib.updateProgress).toHaveBeenCalledWith('i1', 0.5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reaches the last chapter and shows the end-of-story marker', () => {
    render(<HtmlReader item={mkItem()} content={threeChapterHtml} onBack={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }))
    expect(screen.getByText('Third chapter body')).toBeInTheDocument()
    expect(screen.getByText('End of story')).toBeInTheDocument()
    expect(screen.queryByText('Next →')).toBeNull()
  })
})

// ── Restore math (render) ───────────────────────────────────────────────────────
describe('HtmlReader — initial-chapter restore', () => {
  // Headline B: initialChapter is derived once on mount from scroll_chapter (absolute)
  // or scroll_position (fractional, rounded across total-1). Lazy mode keeps titles
  // generic so we can assert purely on the derived index.
  it('restores the saved chapter index from scroll_chapter', async () => {
    render(
      <HtmlReader
        item={mkItem({ file_path: 'story-ch0.html', scroll_chapter: 3 })}
        content="<p>ch0</p>"
        onBack={() => {}}
        lazyChapterCount={5}
      />,
    )
    // scroll_chapter=3 → header shows the 4th chapter (1-based label "4.")
    expect(await screen.findByRole('button', { name: /^4\./ })).toBeInTheDocument()
  })

  it('restores a fractional scroll_position as a rounded chapter index', async () => {
    render(
      <HtmlReader
        item={mkItem({ file_path: 'story-ch0.html', scroll_position: 0.5 })}
        content="<p>ch0</p>"
        onBack={() => {}}
        lazyChapterCount={5}
      />,
    )
    // round(0.5 * (5-1)) = 2 → header label "3."
    expect(await screen.findByRole('button', { name: /^3\./ })).toBeInTheDocument()
  })
})

// ── "Updated" badge ─────────────────────────────────────────────────────────────
describe('HtmlReader — stale content badge', () => {
  it('fires onReloadContent when the Updated badge is clicked', () => {
    const onReloadContent = vi.fn()
    render(
      <HtmlReader
        item={mkItem()}
        content="<p>article</p>"
        onBack={() => {}}
        contentStale
        onReloadContent={onReloadContent}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Updated ↻' }))
    expect(onReloadContent).toHaveBeenCalledTimes(1)
  })

  it('does not render the Updated badge when content is not stale', () => {
    render(<HtmlReader item={mkItem()} content="<p>article</p>" onBack={() => {}} />)
    expect(screen.queryByText('Updated ↻')).toBeNull()
  })
})
