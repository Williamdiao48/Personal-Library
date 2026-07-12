import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PdfReader, {
  toSpreadStart,
  escapeHtml,
  median,
  buildPdfLines,
  getFirstLines,
  extractTitleFromRect,
  textItemsToHtml,
  tryOutlineChapters,
  tryAnnotationChapters,
  detectRunningText,
  clientRectsToScale1,
  scaleRectToPx,
  pointInRects,
  parseRects,
  type TextItem,
} from './PdfReader'
import type { Item } from '../../types'

// PdfReader renders to <canvas> via pdfjs-dist + an inline worker — none of which
// jsdom can run. The heavy value lives in the exported pure/mockable helpers, which
// this suite tests directly with plain fixtures + a duck-typed PDFDocumentProxy.
// The component smoke test only needs the module to load and paint its header, so
// pdfjs / the worker / getContext / IntersectionObserver are stubbed to inert; the
// spread-render effect bails on the 0-width jsdom container so no canvas work runs.
// No ABI toggle (renderer/jsdom).

const h = vi.hoisted(() => {
  const fakePage = {
    getViewport: ({ scale = 1 }: { scale?: number } = {}) => ({
      width: 600 * scale,
      height: 800 * scale,
    }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    getTextContent: async () => ({ items: [] as unknown[] }),
    getAnnotations: async () => [] as unknown[],
  }
  const fakeDoc = {
    numPages: 4,
    getPage: async () => fakePage,
    getOutline: async () => null,
    getDestination: async () => null,
    getPageIndex: async () => 0,
    destroy: () => {},
  }
  return { fakeDoc }
})

vi.mock('pdfjs-dist', () => ({
  getDocument: () => ({ promise: Promise.resolve(h.fakeDoc) }),
  PDFWorker: { create: () => ({ destroy: () => {} }) },
  GlobalWorkerOptions: {},
  version: '5.0.0',
}))
vi.mock('../../workers/pdf-worker?worker&inline', () => ({
  default: class {
    postMessage() {}
    terminate() {}
  },
}))

vi.mock('../../services/library', () => ({
  libraryService: { updateProgress: vi.fn(), setCover: vi.fn(), saveScrollPos: vi.fn() },
}))
vi.mock('../../services/reader', () => ({
  readerService: { loadBinaryContent: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])) },
}))
vi.mock('../../services/convert', () => ({
  convertService: { pdfToEpub: vi.fn() },
}))

vi.mock('../../hooks/useReadingSession', () => ({
  useReadingSession: () => ({ recordActivity: vi.fn() }),
}))
vi.mock('../../hooks/usePdfSearch', () => ({
  usePdfSearch: () => ({
    buildIndex: vi.fn(),
    search: vi.fn(),
    goNext: vi.fn(),
    goPrev: vi.fn(),
    matchCount: 0,
    currentMatch: 0,
    targetPage: null,
    indexBuilt: false,
    indexing: false,
  }),
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

vi.mock('./SearchBar', () => ({
  default: (p: { onClose?: () => void }) => (
    <div>
      SEARCH BAR<button onClick={() => p.onClose?.()}>close-search</button>
    </div>
  ),
}))
vi.mock('./AnnotationsPanel', () => ({ default: () => <div>ANNOTATIONS PANEL</div> }))
vi.mock('./BookmarksPanel', () => ({ default: () => <div>BOOKMARKS PANEL</div> }))
vi.mock('./ConvertProgress', () => ({
  default: (p: { onCancel?: () => void }) => (
    <div>
      CONVERT PROGRESS<button onClick={() => p.onCancel?.()}>cancel-convert</button>
    </div>
  ),
}))

import { readerService } from '../../services/reader'
import { convertService } from '../../services/convert'
import { libraryService } from '../../services/library'
const reader = readerService as unknown as Record<string, ReturnType<typeof vi.fn>>
const convert = convertService as unknown as Record<string, ReturnType<typeof vi.fn>>
const lib = libraryService as unknown as Record<string, ReturnType<typeof vi.fn>>

// TextItem factory — [4]=x, [5]=y in the transform; width defaults to a rough glyph run.
const ti = (str: string, x: number, y: number, width = str.length * 6): TextItem => ({
  str,
  dir: 'ltr',
  transform: [1, 0, 0, 1, x, y],
  width,
  height: 12,
  fontName: 'F',
  hasEOL: false,
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  reader.loadBinaryContent.mockResolvedValue(new Uint8Array([1, 2, 3]))
  convert.pdfToEpub.mockResolvedValue({ id: 'e9' })
  ;(HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = vi.fn(
    () => ({}),
  )
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  Element.prototype.scrollIntoView = vi.fn()
})

// ── Small pure helpers ──────────────────────────────────────────────────────────
describe('toSpreadStart', () => {
  it('snaps every page to the odd left page of its two-page spread', () => {
    expect([1, 2, 3, 4, 5].map(toSpreadStart)).toEqual([1, 1, 3, 3, 5])
  })
})

describe('escapeHtml', () => {
  it('escapes &, <, >, and " (ampersand first so entities are not double-escaped)', () => {
    expect(escapeHtml('a & <b> "c"')).toBe('a &amp; &lt;b&gt; &quot;c&quot;')
  })
})

describe('median', () => {
  it('averages the two middles for an even-length list', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
  it('takes the middle for an odd-length list, regardless of input order', () => {
    expect(median([3, 1, 2])).toBe(2)
  })
  it('falls back to 12 for an empty list', () => {
    expect(median([])).toBe(12)
  })
})

// ── buildPdfLines ───────────────────────────────────────────────────────────────
describe('buildPdfLines', () => {
  it('sorts lines top-to-bottom (descending Y) and joins same-line items left-to-right', () => {
    const lines = buildPdfLines([ti('World', 60, 100), ti('Hello ', 0, 100), ti('Below', 0, 80)])
    expect(lines.map((l) => l.text)).toEqual(['Hello World', 'Below'])
  })

  // Headline A: a superscript footnote marker (1-char, baseline a few points above the
  // text) escapes Y-grouping and becomes its own line; it must merge back into the
  // nearest adjacent line, but ONLY when that gap is under the median line spacing.
  it('merges an isolated 1-char token backward into the nearer line within the median gap', () => {
    const lines = buildPdfLines([
      ti('First line here', 0, 140, 100),
      ti('§', 0, 132, 5), // 8pt above line 1 (own group), 12pt above line 3 → merges backward
      ti('second line body', 0, 120, 90),
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0].text).toBe('First line here§')
    expect(lines[1].text).toBe('second line body')
  })
})

// ── getFirstLines ───────────────────────────────────────────────────────────────
describe('getFirstLines', () => {
  it('skips a bare page number in the header zone and honours the excluded set', () => {
    // "42" sits a full line-space above the title (gap > median) so it stays its own
    // line rather than footnote-merging; pageHeight 300 → header zone y > 276, numeric → dropped.
    const items = [ti('42', 0, 340), ti('The Title', 0, 250), ti('An Author', 0, 200)]
    expect(getFirstLines(items, 3, new Set(), 300)).toEqual(['The Title', 'An Author'])
    // excluded normalises to lowercase
    expect(getFirstLines(items, 3, new Set(['the title']), 300)).toEqual(['An Author'])
  })
})

// ── extractTitleFromRect ────────────────────────────────────────────────────────
describe('extractTitleFromRect', () => {
  it('joins only the text items whose origin falls inside the rect (± tolerance)', () => {
    const items = [ti('Chapter ', 100, 200), ti('One', 160, 200), ti('faraway', 500, 500)]
    expect(extractTitleFromRect(items, [95, 195, 205, 210])).toBe('Chapter One')
  })
})

// ── textItemsToHtml ─────────────────────────────────────────────────────────────
describe('textItemsToHtml', () => {
  // Headline B: paragraph breaks are inferred geometrically — here an indented next
  // line (minX > leftMargin + 10) splits paragraph 1 from paragraph 2.
  it('splits paragraphs on an indentation signal', () => {
    const items = [
      ti('Para one line one.', 50, 200, 100),
      ti('para one line two.', 50, 180, 100),
      ti('Para two starts here.', 70, 155, 100), // indented → new paragraph
    ]
    const html = textItemsToHtml(items, 1, 300, new Set())
    expect(html).toContain('<p>Para one line one. para one line two.</p>')
    expect(html).toContain('<p>Para two starts here.</p>')
  })

  it('returns an image-only placeholder when there is no extractable text', () => {
    expect(textItemsToHtml([], 7, 300, new Set())).toContain('Page 7: image-only')
  })
})

// ── Doc-driven async helpers (duck-typed PDFDocumentProxy) ───────────────────────
type DestRef = { num: number; gen: number }
const docWith = (over: Record<string, unknown>): PDFDocumentProxy =>
  ({
    getPageIndex: async (ref: DestRef) => ref.num - 1, // startPage = pageIndex + 1 = num
    ...over,
  }) as unknown as PDFDocumentProxy

describe('tryOutlineChapters', () => {
  // Headline C: the outline tree is flattened depth-first (nested chapters collected)
  // and, when a parent + its first child land on the same page, the LAST (deeper)
  // entry per page wins.
  it('flattens nested entries and keeps the deeper entry when a parent shares its page', async () => {
    const dest: Record<string, DestRef> = {
      p1: { num: 5, gen: 0 },
      c1: { num: 5, gen: 0 }, // same page as its parent p1
      c2: { num: 20, gen: 0 },
    }
    const doc = docWith({
      getOutline: async () => [
        { title: 'Part One', dest: 'p1', items: [{ title: 'Chapter 1', dest: 'c1' }] },
        { title: 'Chapter 2', dest: 'c2' },
      ],
      getDestination: async (name: string) => [dest[name]],
    })
    expect(await tryOutlineChapters(doc)).toEqual([
      { title: 'Chapter 1', startPage: 5 },
      { title: 'Chapter 2', startPage: 20 },
    ])
  })

  it('returns null when the PDF has no outline', async () => {
    expect(await tryOutlineChapters(docWith({ getOutline: async () => null }))).toBeNull()
  })
})

describe('tryAnnotationChapters', () => {
  it('resolves link annotations into sorted chapter boundaries with rect-derived titles', async () => {
    const dest: Record<string, DestRef> = { a: { num: 3, gen: 0 }, b: { num: 10, gen: 0 } }
    const doc = docWith({ getDestination: async (name: string) => [dest[name]] })
    const candidate = {
      textItems: [ti('Intro', 100, 200), ti('Body', 100, 150)],
      links: [
        { dest: 'a', rect: [95, 195, 205, 210] as [number, number, number, number] },
        { dest: 'b', rect: [95, 145, 205, 160] as [number, number, number, number] },
      ],
    }
    expect(await tryAnnotationChapters(doc, candidate)).toEqual([
      { title: 'Intro', startPage: 3 },
      { title: 'Body', startPage: 10 },
    ])
  })

  it('returns null for fewer than two links', async () => {
    expect(await tryAnnotationChapters(docWith({}), { textItems: [], links: [] })).toBeNull()
  })
})

describe('detectRunningText', () => {
  it('returns an empty set for PDFs shorter than 6 pages', async () => {
    const excluded = await detectRunningText(docWith({}), 4)
    expect(excluded.size).toBe(0)
  })

  it('flags repeated header text and footer page numbers as running text', async () => {
    const page = {
      getViewport: () => ({ height: 100 }),
      getTextContent: async () => ({
        items: [
          ti('Running Head', 20, 95), // top 8% zone, repeats every sampled page
          ti('Story text here', 20, 50), // body — never flagged
          ti('7', 20, 4), // bottom 8% zone, numeric → always excluded
        ],
      }),
    }
    const doc = docWith({ getPage: async () => page })
    const excluded = await detectRunningText(doc, 10)
    expect(excluded.has('running head')).toBe(true)
    expect(excluded.has('7')).toBe(true)
    expect(excluded.has('story text here')).toBe(false)
  })
})

// ── Component smoke ─────────────────────────────────────────────────────────────
const mkItem = (over: Partial<Item> = {}): Item =>
  ({
    id: 'p1',
    title: 'A PDF',
    content_type: 'pdf',
    file_path: 'p1.pdf',
    source_url: null,
    scroll_position: 0,
    cover_path: 'c.jpg', // set so lazy cover extraction is skipped
    ...over,
  }) as Item

const renderPdf = (item = mkItem(), props: Partial<{ hasEpub: boolean }> = {}) =>
  render(
    <MemoryRouter>
      <PdfReader item={item} onBack={() => {}} hasEpub={props.hasEpub} />
    </MemoryRouter>,
  )

describe('PdfReader — smoke', () => {
  it('shows a loading message until the document resolves', () => {
    reader.loadBinaryContent.mockReturnValue(new Promise(() => {})) // never resolves
    renderPdf()
    expect(screen.getByText('Loading PDF…')).toBeInTheDocument()
  })

  it('loads the PDF and renders the header with a Convert-to-EPUB button', async () => {
    renderPdf()
    expect(await screen.findByText('⇄ EPUB')).toBeInTheDocument()
    expect(reader.loadBinaryContent).toHaveBeenCalledWith('p1.pdf')
    expect(screen.getByText('A PDF')).toBeInTheDocument()
    expect(screen.getByText('1–2')).toBeInTheDocument() // current spread (pages 1–2 of 4)
  })

  it('hides the Convert button when a derived EPUB already exists', async () => {
    renderPdf(mkItem(), { hasEpub: true })
    await screen.findByText('A PDF')
    expect(screen.queryByText('⇄ EPUB')).toBeNull()
  })

  it('toggles between spread and scroll view modes', async () => {
    renderPdf()
    await screen.findByText('A PDF')
    const toggle = screen.getByRole('button', { name: 'Switch to scroll view' })
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Switch to spread view' })).toBeInTheDocument()
  })

  it('surfaces a load error', async () => {
    reader.loadBinaryContent.mockRejectedValue(new Error('bad pdf'))
    renderPdf()
    expect(await screen.findByText('bad pdf')).toBeInTheDocument()
  })
})

describe('PdfReader — header interactions', () => {
  it('opens and closes in-content search', async () => {
    renderPdf()
    await screen.findByText('A PDF')
    fireEvent.click(screen.getByRole('button', { name: 'Search in content' }))
    expect(screen.getByText('SEARCH BAR')).toBeInTheDocument()
    fireEvent.click(screen.getByText('close-search'))
    expect(screen.queryByText('SEARCH BAR')).toBeNull()
  })

  it('opens zoom settings and changes the zoom level', async () => {
    renderPdf()
    await screen.findByText('A PDF')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom settings' }))
    fireEvent.click(screen.getByText('150%'))
    expect(localStorage.getItem('pdf-zoom')).toBe('1.5')
  })

  it('jumps to a page via the page-number editor (snaps to the spread start)', async () => {
    renderPdf()
    await screen.findByText('A PDF')
    fireEvent.click(screen.getByText('1–2')) // startEditing
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '4' } })
    fireEvent.keyDown(input, { key: 'Enter' }) // commitEdit → goTo(4) → toSpreadStart(4)=3
    expect(screen.getByText('3–4')).toBeInTheDocument()
  })

  it('toggles the bookmark and both side panels', async () => {
    renderPdf()
    await screen.findByText('A PDF')
    fireEvent.click(screen.getByRole('button', { name: 'Bookmark this page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Bookmarks' }))
    expect(screen.getByText('BOOKMARKS PANEL')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Annotations' }))
    expect(screen.getByText('ANNOTATIONS PANEL')).toBeInTheDocument()
  })

  it('navigates spreads with the arrow keys', async () => {
    renderPdf()
    await screen.findByText('A PDF')
    fireEvent.keyDown(window, { key: 'ArrowRight' }) // goTo(currentPage + 2) → 3 → 3–4
    expect(screen.getByText('3–4')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowLeft' }) // → back to 1–2
    expect(screen.getByText('1–2')).toBeInTheDocument()
  })
})

describe('PdfReader — convert to EPUB', () => {
  // Drives the whole conversion pipeline: detectRunningText → tryOutlineChapters →
  // page scan → tryAnnotationChapters → Stage-3 fixed chunking → convertService.
  // The fake doc has no outline/links/text, so it falls all the way to Stage 3.
  it('runs the conversion pipeline and calls convertService', async () => {
    renderPdf()
    await screen.findByText('A PDF')
    fireEvent.click(screen.getByText('⇄ EPUB'))
    expect(screen.getByText('CONVERT PROGRESS')).toBeInTheDocument() // converting modal
    await waitFor(() => expect(convert.pdfToEpub).toHaveBeenCalledTimes(1))
    expect(convert.pdfToEpub).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'p1', chapters: expect.any(Array) }),
    )
  })

  it('cancels an in-progress conversion', async () => {
    renderPdf()
    await screen.findByText('A PDF')
    fireEvent.click(screen.getByText('⇄ EPUB'))
    fireEvent.click(screen.getByText('cancel-convert')) // handleCancelConvert
    await waitFor(() => expect(screen.queryByText('CONVERT PROGRESS')).toBeNull())
  })
})

describe('PdfReader — highlight geometry helpers', () => {
  it('clientRectsToScale1 converts client rects to scale-1 px relative to the page origin', () => {
    // A rect at client (150, 250) size 100×20, page wrapper origin (100, 200), scale 2.
    const rects = [{ left: 150, top: 250, width: 100, height: 20 }]
    expect(clientRectsToScale1(rects, 100, 200, 2)).toEqual([[25, 25, 50, 10]])
  })

  it('clientRectsToScale1 drops sub-pixel slivers and guards a non-positive scale', () => {
    const rects = [
      { left: 100, top: 200, width: 0.4, height: 20 }, // too thin
      { left: 100, top: 200, width: 40, height: 40 },
    ]
    expect(clientRectsToScale1(rects, 100, 200, 1)).toEqual([[0, 0, 40, 40]])
    expect(clientRectsToScale1(rects, 100, 200, 0)).toEqual([])
  })

  it('scaleRectToPx multiplies a scale-1 rect by the live scale', () => {
    expect(scaleRectToPx([10, 20, 30, 40], 1.5)).toEqual({
      left: 15,
      top: 30,
      width: 45,
      height: 60,
    })
  })

  it('pointInRects hit-tests a point against scale-1 rects (inclusive edges)', () => {
    const rects = [
      [0, 0, 10, 10],
      [50, 50, 20, 20],
    ]
    expect(pointInRects(rects, 5, 5)).toBe(true)
    expect(pointInRects(rects, 60, 60)).toBe(true)
    expect(pointInRects(rects, 70, 70)).toBe(true) // right/bottom edge inclusive
    expect(pointInRects(rects, 30, 30)).toBe(false) // gap between rects
  })

  it('parseRects tolerates null and malformed JSON', () => {
    expect(parseRects(null)).toEqual([])
    expect(parseRects('not json')).toEqual([])
    expect(parseRects('{"x":1}')).toEqual([]) // object, not array
    expect(parseRects('[[1,2,3,4]]')).toEqual([[1, 2, 3, 4]])
  })
})

describe('PdfReader — cover extraction', () => {
  it('extracts and saves a cover on first open when the item has none', async () => {
    // jsdom's Blob lacks arrayBuffer(), so hand extractCover a minimal blob-like object.
    const fakeBlob = { arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Blob
    ;(HTMLCanvasElement.prototype as unknown as { toBlob: unknown }).toBlob = vi.fn(
      (cb: (b: Blob) => void) => cb(fakeBlob),
    )
    renderPdf(mkItem({ cover_path: null }))
    await screen.findByText('A PDF')
    await waitFor(() => expect(lib.setCover).toHaveBeenCalledWith('p1', expect.anything(), 'jpg'))
  })
})
