import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'

// TextItem is not re-exported from pdfjs-dist's main entry in v5
export type TextItem = {
  str: string
  dir: string
  transform: number[]
  width: number
  height: number
  fontName: string
  hasEOL: boolean
}
import PdfJsWorker from '../../workers/pdf-worker?worker&inline'
import { libraryService } from '../../services/library'
import { readerService } from '../../services/reader'
import { convertService } from '../../services/convert'
import { useReadingSession } from '../../hooks/useReadingSession'
import { usePdfSearch } from '../../hooks/usePdfSearch'
import { useAnnotations } from '../../hooks/useAnnotations'
import SearchBar from './SearchBar'
import AnnotationsPanel from './AnnotationsPanel'
import BookmarksPanel from './BookmarksPanel'
import ThemePicker from '../Annotations/ThemePicker'
import TextSelectionPopup from './TextSelectionPopup'
import AnnotationContextMenu from './AnnotationContextMenu'
import NotePopover from './NotePopover'
import type { Item, ConvertChapter, Annotation, AnnotationTheme, HighlightColor } from '../../types'
import ConvertProgress from './ConvertProgress'
import '../../styles/epub-reader.css'

const SAVE_DEBOUNCE_MS = 600
const PAGES_PER_CHAPTER = 10

/** Matches common chapter/section heading words at the start of a line (case-insensitive). */
const CHAPTER_HEADING_RE =
  /^(chapter|part|section|prologue|epilogue|afterword|interlude|book|volume|arc|coda|preface|introduction|conclusion|appendix)\b/i

const ZOOM_LEVELS = [0.75, 1.0, 1.25, 1.5] as const
type ZoomLevel = (typeof ZOOM_LEVELS)[number]

const LS_PDF_ZOOM = 'pdf-zoom'
const LS_PDF_VIEW_MODE = 'pdf-view-mode'

type ViewMode = 'spread' | 'scroll'
interface PageDim {
  width: number
  height: number
}

type PdfPage = Awaited<ReturnType<PDFDocumentProxy['getPage']>>
type PdfViewport = ReturnType<PdfPage['getViewport']>

function loadSavedZoom(): ZoomLevel {
  const n = Number(localStorage.getItem(LS_PDF_ZOOM))
  return (ZOOM_LEVELS as readonly number[]).includes(n) ? (n as ZoomLevel) : 1.0
}

function loadSavedViewMode(): ViewMode {
  const v = localStorage.getItem(LS_PDF_VIEW_MODE)
  return v === 'spread' || v === 'scroll' ? v : 'spread'
}

/** Snap any page number to the left side of its two-page spread (always odd). */
export function toSpreadStart(page: number): number {
  return page % 2 === 0 ? page - 1 : page
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 12
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 !== 0 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ── PDF highlight geometry (pure, unit-tested) ──────────────────────────────
// Highlights are stored as [x, y, w, h] rects in "scale-1 viewport pixels" (the
// page's top-left origin at scale 1). Redraw is just rect × liveScale, so the
// same stored value tracks the text through any zoom/fit without re-matching.

/** Convert DOM client rects (from a Range) into scale-1 px rects relative to a
 *  page wrapper's top-left. Drops sub-pixel slivers. `originLeft/Top` are the
 *  wrapper's client-rect origin; `scale` is the page's current render scale. */
export function clientRectsToScale1(
  rects: ArrayLike<{ left: number; top: number; width: number; height: number }>,
  originLeft: number,
  originTop: number,
  scale: number,
): number[][] {
  const out: number[][] = []
  if (scale <= 0) return out
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    if (r.width < 1 || r.height < 1) continue
    out.push([
      (r.left - originLeft) / scale,
      (r.top - originTop) / scale,
      r.width / scale,
      r.height / scale,
    ])
  }
  return out
}

/** Position/size for an overlay div: scale-1 rect × liveScale → CSS px. */
export function scaleRectToPx(
  rect: number[],
  scale: number,
): { left: number; top: number; width: number; height: number } {
  return {
    left: rect[0] * scale,
    top: rect[1] * scale,
    width: rect[2] * scale,
    height: rect[3] * scale,
  }
}

/** True if scale-1 point (px1x, px1y) falls inside any of the rects. */
export function pointInRects(rects: number[][], px1x: number, px1y: number): boolean {
  return rects.some(([x, y, w, h]) => px1x >= x && px1x <= x + w && px1y >= y && px1y <= y + h)
}

/** Parse the stored rects JSON, tolerating null/garbage → []. */
export function parseRects(json: string | null): number[][] {
  if (!json) return []
  try {
    const a = JSON.parse(json)
    return Array.isArray(a) ? a : []
  } catch {
    return []
  }
}

export interface PdfLine {
  text: string // joined text of all items on this line
  y: number // baseline Y coordinate
  minX: number // X of the first non-whitespace item (detects indentation)
  width: number // sum of item widths (detects short last lines)
}

/** Group raw pdfjs text items into visual lines with metadata. */
export function buildPdfLines(textItems: TextItem[]): PdfLine[] {
  // Sort: top-to-bottom (descending Y), left-to-right within each line
  const sorted = [...textItems].sort((a, b) => {
    const dy = b.transform[5] - a.transform[5]
    if (Math.abs(dy) > 5) return dy
    return a.transform[4] - b.transform[4]
  })

  // Group items whose Y baselines are within 5pt of each other
  // (5pt catches superscript footnote symbols like § ‡ that sit ~4pt above baseline)
  const groups: TextItem[][] = []
  let curY: number | null = null
  let cur: TextItem[] = []
  for (const item of sorted) {
    const y = item.transform[5]
    if (curY === null || Math.abs(y - curY) > 5) {
      if (cur.length) groups.push(cur)
      cur = [item]
      curY = y
    } else {
      cur.push(item)
    }
  }
  if (cur.length) groups.push(cur)

  const raw: PdfLine[] = groups.flatMap((group) => {
    const byX = [...group].sort((a, b) => a.transform[4] - b.transform[4])
    const text = byX
      .map((it) => it.str)
      .join('')
      .trim()
    if (!text) return []
    const y = byX[0].transform[5]
    const firstReal = byX.find((it) => it.str.trim().length > 0)
    const minX = firstReal ? firstReal.transform[4] : byX[0].transform[4]
    const width = byX.reduce((s, it) => s + it.width, 0)
    return [{ text, y, minX, width }]
  })

  if (raw.length < 2) return raw

  // Merge isolated 1–2 character tokens into the nearest adjacent line.
  // These are superscript footnote/endnote markers (§, ‡, *, ¹, etc.) whose
  // baseline pdfjs places a few points above the surrounding text, causing them
  // to escape Y-grouping and become their own line.
  //
  // Guard: only merge when the gap to the adjacent line is less than the
  // median inter-line spacing. Decorative separators ("* * *", roman numerals
  // at section headings) sit a full line-space away and are left untouched.
  const rawGaps = raw
    .slice(0, -1)
    .map((l, i) => {
      const g = Math.abs(l.y - raw[i + 1].y)
      return g > 0 && g < 100 ? g : null
    })
    .filter((g): g is number => g !== null)
  const medSp = median(rawGaps) || 14 // fallback for single-line pages

  const result: PdfLine[] = []
  let i = 0
  while (i < raw.length) {
    const line = raw[i]
    if (line.text.length <= 2) {
      const gapPrev = result.length > 0 ? Math.abs(result[result.length - 1].y - line.y) : Infinity
      const gapNext = i + 1 < raw.length ? Math.abs(line.y - raw[i + 1].y) : Infinity

      if (gapPrev <= gapNext && gapPrev < medSp) {
        // Merge backward — append to the preceding line (no space: "word§")
        const prev = result[result.length - 1]
        result[result.length - 1] = {
          ...prev,
          text: prev.text + line.text,
          width: prev.width + line.width,
        }
        i++
        continue
      } else if (gapNext < medSp) {
        // Merge forward — prepend to the next line ("§word")
        const next = raw[i + 1]
        result.push({
          text: line.text + next.text,
          y: next.y,
          minX: Math.min(line.minX, next.minX),
          width: line.width + next.width,
        })
        i += 2
        continue
      }
      // No nearby line within threshold — keep as-is (e.g. isolated heading character)
    }
    result.push(line)
    i++
  }
  return result
}

// ── Chapter boundary detection ───────────────────────────────────────────────

export interface ChapterBoundary {
  title: string
  startPage: number // 1-based
}

/** Return the first n non-empty line texts from a page's text items, skipping running header/footer lines. */
export function getFirstLines(
  items: (TextItem | { type: string })[],
  n = 3,
  excluded = new Set<string>(),
  pageHeight = Infinity,
): string[] {
  const real = items.filter((it): it is TextItem => 'str' in it && it.str.length > 0)
  return buildPdfLines(real)
    .filter((l) => {
      const norm = l.text.trim().toLowerCase()
      if (excluded.has(norm)) return false
      const inZone = l.y > pageHeight * 0.92 || l.y < pageHeight * 0.08
      if (inZone && /^\d+$/.test(l.text.trim())) return false
      return true
    })
    .slice(0, n)
    .map((l) => l.text.trim())
    .filter(Boolean)
}

/** Extract the visible text that overlaps a link annotation's bounding rect. */
export function extractTitleFromRect(
  textItems: TextItem[],
  rect: [number, number, number, number],
): string {
  const [x1, y1, x2, y2] = rect
  const tol = 5 // pt tolerance — accounts for sub-pixel baseline differences
  return textItems
    .filter((it) => {
      const ix = it.transform[4]
      const iy = it.transform[5]
      return ix >= x1 - tol && ix <= x2 + tol && iy >= y1 - tol && iy <= y2 + tol
    })
    .map((it) => it.str)
    .join('')
    .trim()
}

export interface TocCandidate {
  textItems: TextItem[]
  links: Array<{ dest: unknown; rect: [number, number, number, number] }>
}

/**
 * Stage 1.5 — extract chapter boundaries from link annotations on the page
 * with the most internal navigation links (the TOC page).
 * Returns null if no suitable TOC page is found.
 */
export async function tryAnnotationChapters(
  doc: PDFDocumentProxy,
  candidate: TocCandidate | null,
): Promise<ChapterBoundary[] | null> {
  if (!candidate || candidate.links.length < 2) return null
  try {
    const entries: ChapterBoundary[] = []

    for (const link of candidate.links) {
      try {
        const dest: unknown[] | null =
          typeof link.dest === 'string'
            ? await doc.getDestination(link.dest)
            : Array.isArray(link.dest)
              ? (link.dest as unknown[])
              : null
        if (!dest?.[0]) continue

        const pageIndex = await doc.getPageIndex(dest[0] as { num: number; gen: number })
        const title = extractTitleFromRect(candidate.textItems, link.rect)
        entries.push({
          title: title || `Chapter ${entries.length + 1}`,
          startPage: pageIndex + 1,
        })
      } catch {
        /* skip unresolvable links */
      }
    }

    if (entries.length < 2) return null
    entries.sort((a, b) => a.startPage - b.startPage)
    const deduped = entries.filter((e, i) => i === 0 || e.startPage !== entries[i - 1].startPage)
    return deduped.length >= 2 ? deduped : null
  } catch {
    return null
  }
}

/**
 * Stage 1 — extract chapter boundaries from the PDF's embedded outline (bookmarks).
 * Returns null if the PDF has no outline or fewer than 2 resolvable entries.
 */
export async function tryOutlineChapters(doc: PDFDocumentProxy): Promise<ChapterBoundary[] | null> {
  try {
    const outline = await doc.getOutline()
    if (!outline || outline.length === 0) return null

    // Flatten the entire outline tree depth-first so nested chapters
    // (e.g. chapters under Part / Act / Level headings) are all collected.

    function collectItems(items: any[]): any[] {
      const flat: any[] = []
      for (const item of items) {
        flat.push(item)
        if (item.items?.length) flat.push(...collectItems(item.items))
      }
      return flat
    }

    const entries: ChapterBoundary[] = []

    for (const item of collectItems(outline)) {
      if (!item.dest) continue
      try {
        const dest: unknown[] | null =
          typeof item.dest === 'string'
            ? await doc.getDestination(item.dest)
            : Array.isArray(item.dest)
              ? (item.dest as unknown[])
              : null
        if (!dest?.[0]) continue

        const pageIndex = await doc.getPageIndex(dest[0] as { num: number; gen: number })
        entries.push({
          title: item.title?.trim() || `Section ${entries.length + 1}`,
          startPage: pageIndex + 1,
        })
      } catch {
        /* skip unresolvable entries */
      }
    }

    if (entries.length < 2) return null
    entries.sort((a, b) => a.startPage - b.startPage)

    // When a parent (e.g. "Level One") and its first child (e.g. "Chapter 1") both
    // resolve to the same page, depth-first ordering puts the parent first.
    // Keeping the LAST entry per page therefore prefers the deeper (chapter-level) entry.
    const dedupedByPage = entries.filter(
      (e, i) => i === entries.length - 1 || entries[i + 1].startPage !== e.startPage,
    )

    // Secondary dedup: some outlines list the same section (e.g. "Cover", "Title Page")
    // at two different page numbers (once as a top-level entry, once as a child).
    // Normalise titles and keep only the first occurrence of each.
    const seenTitles = new Set<string>()
    const deduped = dedupedByPage.filter((e) => {
      const key = e.title.toLowerCase().trim()
      if (seenTitles.has(key)) return false
      seenTitles.add(key)
      return true
    })

    return deduped.length >= 2 ? deduped : null
  } catch {
    return null
  }
}

/**
 * Pre-pass: sample evenly-spaced pages and collect text that sits in the
 * top/bottom 8% of the page (the header/footer zones in PDF Y-coordinates,
 * where Y=0 is the bottom of the page).  Any string that appears on 3 or more
 * sampled pages is almost certainly a running header/footer and is returned in
 * the exclusion set.  Lone numeric strings in those zones (page numbers) are
 * also added regardless of frequency, because they change every page and will
 * never accumulate enough hits on their own.
 *
 * Returns an empty Set for PDFs shorter than 6 pages — too few pages to
 * distinguish running text from coincidental repetition.
 */
export async function detectRunningText(
  doc: PDFDocumentProxy,
  numPages: number,
): Promise<Set<string>> {
  if (numPages < 6) return new Set()

  const SAMPLE = 8
  const HEADER = 0.92 // top 8%  (Y measured from bottom)
  const FOOTER = 0.08 // bottom 8%
  const MIN_HITS = 3

  // Spread sample points across the book, skipping the first 3 pages
  // (cover / title / copyright — unique text that must not be flagged as running).
  const start = Math.min(4, numPages)
  const samplePages = [
    ...new Set(
      Array.from({ length: SAMPLE }, (_, i) =>
        Math.round(start + (i / (SAMPLE - 1)) * (numPages - start)),
      ).map((p) => Math.min(p, numPages)),
    ),
  ]

  const freq = new Map<string, number>()

  for (const pageNum of samplePages) {
    const page = await doc.getPage(pageNum)
    const height = page.getViewport({ scale: 1 }).height
    const tc = await page.getTextContent()

    for (const it of tc.items) {
      if (!('str' in it)) continue
      const norm = (it as TextItem).str.trim()
      if (!norm) continue
      const y = (it as TextItem).transform[5]
      if (y > height * HEADER || y < height * FOOTER) {
        const key = norm.toLowerCase()
        freq.set(key, (freq.get(key) ?? 0) + 1)
      }
    }
  }

  const excluded = new Set<string>()
  for (const [key, count] of freq) {
    if (count >= MIN_HITS) excluded.add(key)
    // Page numbers change every page so never reach MIN_HITS — add them anyway.
    if (/^\d+$/.test(key) || /^page\s+\d+/i.test(key) || /^\d+\s*of\s*\d+$/i.test(key))
      excluded.add(key)
  }
  return excluded
}

/**
 * Convert pdfjs TextItem[] for one page into HTML paragraphs.
 *
 * Paragraph breaks are detected by three complementary geometric signals:
 *   1. Large gap — spacing between two lines is > 1.5× the median line spacing.
 *      Catches typeset books that separate paragraphs with extra leading.
 *   2. Indentation — the next line's first character starts > 10pt to the right
 *      of the document's left margin.  Catches the classic indent style.
 *   3. Short last line — the current line's total width is < 60% of the widest
 *      line on the page.  Catches paragraphs that end before the right margin.
 *
 * All three signals are checked together; any one of them triggers a break.
 */
export function textItemsToHtml(
  items: (TextItem | { type: string })[],
  pageNum: number,
  pageHeight: number,
  excluded: Set<string>,
): string {
  const textItems = items.filter(
    (item): item is TextItem => 'str' in item && (item as TextItem).str.length > 0,
  )
  if (textItems.length === 0) {
    return `<p><em>[Page ${pageNum}: image-only — no text could be extracted]</em></p>`
  }

  // Strip running headers/footers (identified by detectRunningText pre-pass) and
  // bare page numbers sitting in the top/bottom 8% zone.
  const lines = buildPdfLines(textItems).filter((line) => {
    const norm = line.text.trim().toLowerCase()
    if (excluded.has(norm)) return false
    const inZone = line.y > pageHeight * 0.92 || line.y < pageHeight * 0.08
    if (inZone && /^\d+$/.test(line.text.trim())) return false
    return true
  })
  if (lines.length === 0) {
    return `<p><em>[Page ${pageNum}: image-only — no text could be extracted]</em></p>`
  }

  // ── Compute calibration values from this page ──────────────────
  // Median line spacing (ignore gaps > 100pt to skip column/section jumps)
  const gaps: number[] = []
  for (let i = 0; i < lines.length - 1; i++) {
    const g = Math.abs(lines[i].y - lines[i + 1].y)
    if (g > 0 && g < 100) gaps.push(g)
  }
  const medianSpacing = median(gaps)

  // Left margin: 10th-percentile of per-line minX (robust against headers/bullets)
  const sortedMinX = lines.map((l) => l.minX).sort((a, b) => a - b)
  const leftMargin = sortedMinX[Math.floor(sortedMinX.length * 0.1)] ?? sortedMinX[0]

  // Max line width on this page
  const maxWidth = Math.max(...lines.map((l) => l.width), 1)

  // ── Build paragraphs ───────────────────────────────────────────
  const paras: string[] = []
  let para: string[] = []

  for (let i = 0; i < lines.length; i++) {
    para.push(lines[i].text)

    if (i === lines.length - 1) break // last line — flush below

    const next = lines[i + 1]
    const gap = Math.abs(lines[i].y - next.y)

    const largeGap = gap > medianSpacing * 1.5
    const nextIndented = next.minX > leftMargin + 10
    // Exclude very short tokens (superscripts, footnote symbols like § ‡) from
    // triggering a paragraph break — they're rarely end-of-paragraph markers.
    const shortLine = lines[i].width < maxWidth * 0.6 && lines[i].text.length > 3

    if (largeGap || nextIndented || shortLine) {
      paras.push(para.join(' '))
      para = []
    }
  }
  if (para.length) paras.push(para.join(' '))

  return paras.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')
}

interface Props {
  item: Item
  onBack: () => void
  hasEpub?: boolean // true when a derived EPUB for this PDF already exists
}

export default function PdfReader({ item, onBack, hasEpub = false }: Props) {
  const { recordActivity } = useReadingSession(item.id)

  const navigate = useNavigate()

  const outerRef = useRef<HTMLDivElement>(null)
  const leftCanvasRef = useRef<HTMLCanvasElement>(null)
  const rightCanvasRef = useRef<HTMLCanvasElement>(null)
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)
  const currentPageRef = useRef(1) // always the left (odd) page of the current spread
  const totalPagesRef = useRef(0)
  const zoomRef = useRef<ZoomLevel>(loadSavedZoom())
  const leftRenderTaskRef = useRef<RenderTask | null>(null)
  const rightRenderTaskRef = useRef<RenderTask | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const convertCancelledRef = useRef(false)

  // Scroll mode refs
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const scrollPageDivRefs = useRef<Map<number, HTMLDivElement>>(new Map()) // 1-based page → div
  const scrollCanvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map()) // 1-based page → canvas
  const scrollRenderTasks = useRef<Map<number, RenderTask>>(new Map()) // 1-based page → task
  const viewModeRef = useRef<ViewMode>(loadSavedViewMode())
  const scrollRestoredRef = useRef(false) // restore position only once per PDF load

  // Text-layer refs (selectable, transparent DOM over each canvas) + the live
  // TextLayer instances, so we can cancel/rebuild them on re-render.
  const leftTextLayerRef = useRef<HTMLDivElement>(null)
  const rightTextLayerRef = useRef<HTMLDivElement>(null)
  const scrollTextLayerRefs = useRef<Map<number, HTMLDivElement>>(new Map()) // page → textLayer div
  const textLayerInstances = useRef<Map<number, { cancel: () => void }>>(new Map()) // page → TextLayer

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [totalPages, setTotalPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState<ZoomLevel>(loadSavedZoom)
  const [showSettings, setShowSettings] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const [pageInput, setPageInput] = useState('')
  const [renderKey, setRenderKey] = useState(0)
  const [viewMode, setViewMode] = useState<ViewMode>(loadSavedViewMode)
  const [pageDims, setPageDims] = useState<PageDim[]>([])

  // Annotations
  const [showPanel, setShowPanel] = useState(false)
  const [showBookmarks, setShowBookmarks] = useState(false)
  const [noteEditorState, setNoteEditorState] = useState<{
    existingId?: string
    initialText?: string
    // Selection-anchored note (from a text selection, not the page-level button):
    page?: number
    rects?: number[][]
    selectedText?: string
  } | null>(null)
  const [noteText, setNoteText] = useState('')
  const [noteThemes, setNoteThemes] = useState<AnnotationTheme[]>([])
  // Current render scale per page (drives highlight-overlay sizing). Updated
  // whenever a page renders; a scale change (zoom) re-renders the overlays.
  const [pageScales, setPageScales] = useState<Record<number, number>>({})
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    annotation: Annotation
  } | null>(null)
  const [notePopup, setNotePopup] = useState<{
    x: number
    y: number
    annotation: Annotation
  } | null>(null)

  const annot = useAnnotations({
    itemId: item.id,
    contentRef: outerRef, // PDF has no text DOM; outerRef is just used for deletion
    chapterIndex: null, // PDF annotations are page-indexed, no chapter concept
  })

  const pdfBookmarks = annot.annotations.filter((a) => a.type === 'bookmark')
  const isBookmarked = pdfBookmarks.some((b) => b.position === currentPage)

  function handleBookmarkToggle() {
    if (isBookmarked) {
      const existing = pdfBookmarks.find((b) => b.position === currentPageRef.current)
      if (existing) annot.deleteAnnotation(existing.id)
    } else {
      annot.createBookmark(currentPageRef.current)
    }
  }

  function handleAddNote() {
    setNoteText('')
    setNoteThemes([])
    setNoteEditorState({})
  }

  function closeNoteEditor() {
    setNoteEditorState(null)
    setNoteText('')
    setNoteThemes([])
  }

  async function savePdfNote() {
    if (!noteEditorState) return
    const text = noteText.trim()
    if (!text) {
      closeNoteEditor()
      return
    }
    if (noteEditorState.existingId) {
      await annot.updateNote(noteEditorState.existingId, text)
      await annot.setAnnotationThemes(noteEditorState.existingId, noteThemes)
    } else if (noteEditorState.rects && noteEditorState.page) {
      // Note anchored to a text selection → store geometry like a highlight.
      await annot.createPdfNote(
        noteEditorState.page,
        noteEditorState.rects,
        noteEditorState.selectedText ?? '',
        text,
        noteThemes,
      )
      window.getSelection()?.removeAllRanges()
    } else {
      await annot.createNote(currentPageRef.current, text, undefined, noteThemes)
    }
    closeNoteEditor()
  }

  function handleJumpToAnnotation(annotation: Annotation) {
    goTo(annotation.position)
  }

  // ── Text selection → highlight / note (geometry-anchored) ─────────────────
  // Map a selection Range to the page it starts on + its rects in scale-1 px.
  // Client rects that fall on a *different* page (scroll mode) are dropped, so a
  // cross-page selection anchors to its start page (MVP).
  function rangeToPageAndRects(range: Range): { page: number; rects: number[][] } | null {
    const startEl =
      range.startContainer instanceof HTMLElement
        ? range.startContainer
        : (range.startContainer.parentElement ?? null)
    const wrap = startEl?.closest<HTMLElement>('[data-page]') ?? null
    if (!wrap) return null
    const pageNum = Number(wrap.dataset.page)
    const scale = pageScales[pageNum]
    if (!pageNum || !scale) return null
    const origin = wrap.getBoundingClientRect()
    const onPage = Array.from(range.getClientRects()).filter((r) => {
      const cy = r.top + r.height / 2
      return cy >= origin.top - 2 && cy <= origin.bottom + 2
    })
    const rects = clientRectsToScale1(onPage, origin.left, origin.top, scale)
    if (rects.length === 0) return null
    return { page: pageNum, rects }
  }

  function handleSelectionHighlight(range: Range, color: HighlightColor) {
    const info = rangeToPageAndRects(range)
    if (!info) return
    annot.createPdfHighlight(info.page, info.rects, range.toString().trim(), color)
    window.getSelection()?.removeAllRanges()
  }

  function handleSelectionNote(range: Range) {
    const info = rangeToPageAndRects(range)
    if (!info) return
    setNoteText('')
    setNoteThemes([])
    setNoteEditorState({
      page: info.page,
      rects: info.rects,
      selectedText: range.toString().trim(),
    })
  }

  // ── Interact with existing highlights (hit-test, since overlays are
  // pointer-events:none so text selection works everywhere) ─────────────────
  function annotationAtPagePoint(
    pageNum: number,
    clientX: number,
    clientY: number,
    wrap: HTMLElement,
  ) {
    const scale = pageScales[pageNum]
    if (!scale) return null
    const r = wrap.getBoundingClientRect()
    const px1x = (clientX - r.left) / scale
    const px1y = (clientY - r.top) / scale
    // Iterate newest-first so a later highlight on top wins.
    for (let i = annot.annotations.length - 1; i >= 0; i--) {
      const a = annot.annotations[i]
      if (a.position !== pageNum || !a.rects) continue
      if (pointInRects(parseRects(a.rects), px1x, px1y)) return a
    }
    return null
  }

  function handlePageContextMenu(e: React.MouseEvent<HTMLElement>, pageNum: number) {
    const hit = annotationAtPagePoint(pageNum, e.clientX, e.clientY, e.currentTarget)
    if (!hit) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, annotation: hit })
  }

  function handlePageClick(e: React.MouseEvent<HTMLElement>, pageNum: number) {
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return // don't hijack an active text selection
    const hit = annotationAtPagePoint(pageNum, e.clientX, e.clientY, e.currentTarget)
    if (hit && hit.type === 'note') {
      setNotePopup({ x: e.clientX, y: e.clientY, annotation: hit })
    }
  }

  // Render the highlight/note overlays for one page (scale-1 rects × liveScale).
  function pageOverlays(pageNum: number) {
    const scale = pageScales[pageNum]
    if (!scale) return null
    return annot.annotations
      .filter(
        (a) => a.position === pageNum && a.rects && (a.type === 'highlight' || a.type === 'note'),
      )
      .flatMap((a) =>
        parseRects(a.rects).map((rect, ri) => {
          const box = scaleRectToPx(rect, scale)
          return (
            <div
              key={`${a.id}-${ri}`}
              className={`pdf-highlight-rect${a.type === 'note' ? ' is-note' : ''}`}
              data-annotation-id={a.id}
              data-color={a.color ?? 'yellow'}
              style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            />
          )
        }),
      )
  }

  // Conversion state
  const [converting, setConverting] = useState(false)
  const [convertStep, setConvertStep] = useState('')
  const [convertPct, setConvertPct] = useState(0)
  const [convertError, setConvertError] = useState<string | null>(null)
  const [convertedId, setConvertedId] = useState<string | null>(null)

  // ── In-content search ────────────────────────────────────────────
  // PDF is canvas-rendered — we can't highlight text. Instead we build a
  // per-page text index and navigate between matching pages.
  // Note: the hook is declared here but goTo is wired up after its definition.

  const pdfSearch = usePdfSearch()

  // ── Scroll mode callback-ref helpers ────────────────────────────
  // Using Map-based callback refs avoids the "hooks in loops" problem for N pages.
  function setScrollPageDiv(page: number) {
    return (el: HTMLDivElement | null) => {
      if (el) scrollPageDivRefs.current.set(page, el)
      else scrollPageDivRefs.current.delete(page)
    }
  }
  function setScrollCanvas(page: number) {
    return (el: HTMLCanvasElement | null) => {
      if (el) scrollCanvasRefs.current.set(page, el)
      else scrollCanvasRefs.current.delete(page)
    }
  }
  function setScrollTextLayer(page: number) {
    return (el: HTMLDivElement | null) => {
      if (el) scrollTextLayerRefs.current.set(page, el)
      else scrollTextLayerRefs.current.delete(page)
    }
  }

  // Keep viewModeRef in sync so stable callbacks (goTo, keyboard) see current value
  useEffect(() => {
    viewModeRef.current = viewMode
  }, [viewMode])

  // ── 1. Load PDF ─────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    let pdfWorker: InstanceType<typeof pdfjsLib.PDFWorker> | null = null

    async function load() {
      try {
        const data = await readerService.loadBinaryContent(item.file_path)
        if (cancelled) return

        const rawWorker = new PdfJsWorker()
        pdfWorker = pdfjsLib.PDFWorker.create({ port: rawWorker })

        const doc = await pdfjsLib.getDocument({
          data,
          worker: pdfWorker,
          isEvalSupported: false, // no eval() in worker
          disableFontFace: true, // no external font requests
          enableXfa: false, // no XFA script execution
          // No annotation layer is ever rendered, so PDF URI actions never fire.
        }).promise

        if (cancelled) {
          pdfWorker.destroy()
          return
        }

        const MAX_PAGES = 5_000
        if (doc.numPages > MAX_PAGES) {
          pdfWorker.destroy()
          throw new Error(
            `This PDF has ${doc.numPages.toLocaleString()} pages. ` +
              `Maximum supported is ${MAX_PAGES.toLocaleString()}.`,
          )
        }

        const saved = item.scroll_position ?? 0
        const rawPage =
          saved > 0 ? Math.max(1, Math.min(Math.round(saved * doc.numPages), doc.numPages)) : 1
        // Snap to the left page of the spread the saved position falls in
        const initial = Math.max(1, toSpreadStart(rawPage))

        pdfDocRef.current = doc
        totalPagesRef.current = doc.numPages
        currentPageRef.current = initial

        setPdfDoc(doc)
        setTotalPages(doc.numPages)
        setCurrentPage(initial)
        setLoading(false)

        if (!saved) {
          libraryService.updateProgress(item.id, 1 / doc.numPages)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF.')
          setLoading(false)
        }
      }
    }

    load()
    // Capture the stable render-task Map so cleanup doesn't read a changed ref.
    const scrollTasks = scrollRenderTasks.current
    return () => {
      cancelled = true
      pdfWorker?.destroy()
      leftRenderTaskRef.current?.cancel()
      rightRenderTaskRef.current?.cancel()
      scrollTasks.forEach((t) => t.cancel())
      scrollTasks.clear()
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 1b. Lazy cover extraction — render page 1 as JPEG on first open ─
  useEffect(() => {
    const doc = pdfDocRef.current
    if (!doc || item.cover_path) return
    let cancelled = false

    async function extractCover() {
      const page = await doc!.getPage(1)
      const base = page.getViewport({ scale: 1 })
      const scale = 180 / base.width
      const vp = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(vp.width)
      canvas.height = Math.round(vp.height)
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp }).promise
      if (cancelled) return
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.82))
      if (!blob || cancelled) return
      const buf = await blob.arrayBuffer()
      if (!cancelled) await libraryService.setCover(item.id, buf, 'jpg')
    }

    extractCover().catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pdfDoc]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 1c. Pre-fetch page dimensions for scroll mode layout ────────
  // Metadata-only — getViewport() never renders canvas. Fast (~5–20ms for 300p).
  useEffect(() => {
    const doc = pdfDocRef.current
    if (!doc || loading) return
    let cancelled = false
    async function fetchDims() {
      const dims: PageDim[] = []
      for (let i = 1; i <= doc!.numPages; i++) {
        if (cancelled) return
        const page = await doc!.getPage(i)
        const vp = page.getViewport({ scale: 1 })
        dims.push({ width: vp.width, height: vp.height })
      }
      if (!cancelled) setPageDims(dims)
    }
    fetchDims().catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pdfDoc]) // eslint-disable-line react-hooks/exhaustive-deps

  // Build the selectable, transparent pdf.js text layer over a page canvas, and
  // record the render scale (drives highlight-overlay sizing). Cancels any prior
  // layer for the page first. pdf.js needs --scale-factor on the container.
  const buildTextLayer = useCallback(
    async (
      pageNum: number,
      page: PdfPage,
      container: HTMLDivElement | null,
      viewport: PdfViewport,
    ) => {
      if (!container) return
      textLayerInstances.current.get(pageNum)?.cancel()
      container.innerHTML = ''
      // pdf.js v5 positions text spans from these CSS vars; set both since we
      // don't import pdf.js's own stylesheet (which normally derives one).
      container.style.setProperty('--scale-factor', String(viewport.scale))
      container.style.setProperty('--total-scale-factor', String(viewport.scale))
      container.style.width = `${Math.round(viewport.width)}px`
      container.style.height = `${Math.round(viewport.height)}px`
      const tl = new pdfjsLib.TextLayer({
        // streamTextContent yields the same items getTextContent does, streamed.
        textContentSource: page.streamTextContent(),
        container,
        viewport,
      })
      textLayerInstances.current.set(pageNum, tl)
      try {
        await tl.render()
      } catch {
        /* cancelled — a newer render superseded this one */
      }
      setPageScales((prev) =>
        prev[pageNum] === viewport.scale ? prev : { ...prev, [pageNum]: viewport.scale },
      )
    },
    [],
  )

  // ── 2. Render the current spread (left + right canvases) ────────
  // Both pages are rendered in parallel onto two separate canvases.
  // Each canvas gets half the viewport width for its fit-to-screen scale.

  useEffect(() => {
    const doc = pdfDocRef.current
    const leftC = leftCanvasRef.current
    const outer = outerRef.current
    if (!doc || !leftC || !outer || loading) return

    let cancelled = false
    leftRenderTaskRef.current?.cancel()
    rightRenderTaskRef.current?.cancel()

    const avW = outer.clientWidth
    const avH = outer.clientHeight
    if (avW === 0 || avH === 0) return

    // Determine whether to show a right page in this spread
    const showRight = currentPage + 1 <= totalPages
    const gap = showRight ? 8 : 0
    const colW = Math.floor((avW - gap) / (showRight ? 2 : 1))
    const z = zoomRef.current

    async function renderOnePage(
      pageNum: number,
      canvas: HTMLCanvasElement,
      textContainer: HTMLDivElement | null,
      setTask: (t: RenderTask | null) => void,
    ) {
      const page = await doc!.getPage(pageNum)
      if (cancelled) return
      const base = page.getViewport({ scale: 1 })
      const fitScale = Math.min(colW / base.width, avH / base.height)
      const scale = Math.min(fitScale * z, fitScale * 2.5) // cap at 2.5× fit
      const vp = page.getViewport({ scale })
      canvas.width = Math.round(vp.width)
      canvas.height = Math.round(vp.height)
      const task = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp })
      setTask(task)
      try {
        await task.promise
        if (!cancelled) setTask(null)
        if (!cancelled) await buildTextLayer(pageNum, page, textContainer, vp)
      } catch (err: unknown) {
        const name = err instanceof Error ? err.name : ''
        if (name !== 'RenderingCancelledException') {
          console.error('[PdfReader] render error on page', pageNum, err)
        }
      }
    }

    renderOnePage(currentPage, leftC, leftTextLayerRef.current, (t) => {
      leftRenderTaskRef.current = t
    })
    const rightC = rightCanvasRef.current
    if (showRight && rightC) {
      renderOnePage(currentPage + 1, rightC, rightTextLayerRef.current, (t) => {
        rightRenderTaskRef.current = t
      })
    }

    return () => {
      cancelled = true
      leftRenderTaskRef.current?.cancel()
      rightRenderTaskRef.current?.cancel()
    }
  }, [currentPage, pdfDoc, zoom, renderKey, loading, totalPages, buildTextLayer])

  // ── 3. ResizeObserver — re-render when the container resizes ────

  useEffect(() => {
    const outer = outerRef.current
    if (!outer) return
    const ro = new ResizeObserver(() => setRenderKey((k) => k + 1))
    ro.observe(outer)
    return () => ro.disconnect()
  }, [])

  // ── 3b. Scroll mode: lazy canvas rendering via IntersectionObserver ──
  useEffect(() => {
    if (viewMode !== 'scroll' || pageDims.length === 0) return
    const container = scrollContainerRef.current
    const doc = pdfDocRef.current
    if (!container || !doc) return

    scrollRenderTasks.current.forEach((t) => t.cancel())
    scrollRenderTasks.current.clear()

    async function renderScrollPage(pageNum: number) {
      const canvas = scrollCanvasRefs.current.get(pageNum)
      const outer = outerRef.current
      if (!canvas || !outer || !doc) return
      scrollRenderTasks.current.get(pageNum)?.cancel()
      scrollRenderTasks.current.delete(pageNum)

      const page = await doc.getPage(pageNum)
      const contW = outer.clientWidth - 48
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min((contW / base.width) * zoomRef.current, (contW / base.width) * 2.5)
      const vp = page.getViewport({ scale })
      canvas.width = Math.round(vp.width)
      canvas.height = Math.round(vp.height)

      const task = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp })
      scrollRenderTasks.current.set(pageNum, task)
      try {
        await task.promise
        scrollRenderTasks.current.delete(pageNum)
        await buildTextLayer(pageNum, page, scrollTextLayerRefs.current.get(pageNum) ?? null, vp)
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== 'RenderingCancelledException') {
          console.error('[PdfReader] scroll render error p', pageNum, err)
        }
      }
    }

    function clearScrollPage(pageNum: number) {
      scrollRenderTasks.current.get(pageNum)?.cancel()
      scrollRenderTasks.current.delete(pageNum)
      const canvas = scrollCanvasRefs.current.get(pageNum)
      if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
      // Tear down the text layer too; overlays stay in the DOM but are off-screen.
      textLayerInstances.current.get(pageNum)?.cancel()
      textLayerInstances.current.delete(pageNum)
      const tl = scrollTextLayerRefs.current.get(pageNum)
      if (tl) tl.innerHTML = ''
    }

    const renderIO = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page)
          if (!page) continue
          if (entry.isIntersecting) renderScrollPage(page)
          else clearScrollPage(page)
        }
      },
      { root: container, rootMargin: '400px 0px', threshold: 0 },
    )
    scrollPageDivRefs.current.forEach((div) => renderIO.observe(div))

    // Capture the stable render-task Map so cleanup doesn't read a changed ref.
    const scrollTasks = scrollRenderTasks.current
    const textLayers = textLayerInstances.current
    return () => {
      renderIO.disconnect()
      scrollTasks.forEach((t) => t.cancel())
      scrollTasks.clear()
      textLayers.forEach((t) => t.cancel())
      textLayers.clear()
    }
  }, [viewMode, pageDims, renderKey, buildTextLayer])

  // ── 4. Navigation ───────────────────────────────────────────────

  const scheduleSave = useCallback(
    (page: number, total: number) => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        libraryService.updateProgress(item.id, page / total)
      }, SAVE_DEBOUNCE_MS)
    },
    [item.id],
  )

  // ── 3c. Scroll mode: current-page tracking via IntersectionObserver ──
  useEffect(() => {
    if (viewMode !== 'scroll' || pageDims.length === 0) return
    const container = scrollContainerRef.current
    if (!container) return

    const ratioMap = new Map<number, number>()

    const trackIO = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page)
          if (page) ratioMap.set(page, entry.intersectionRatio)
        }
        let bestPage = currentPageRef.current
        let bestRatio = -1
        ratioMap.forEach((r, p) => {
          if (r > bestRatio) {
            bestRatio = r
            bestPage = p
          }
        })
        if (bestPage !== currentPageRef.current) {
          currentPageRef.current = bestPage
          setCurrentPage(bestPage)
          scheduleSave(bestPage, totalPagesRef.current)
        }
      },
      { root: container, threshold: [0, 0.1, 0.5, 1.0] },
    )
    scrollPageDivRefs.current.forEach((div) => trackIO.observe(div))

    return () => trackIO.disconnect()
  }, [viewMode, pageDims, scheduleSave])

  // ── 3d. Scroll mode: restore position once pageDims are ready ────
  useEffect(() => {
    if (viewMode !== 'scroll' || pageDims.length === 0) return
    if (scrollRestoredRef.current) return
    scrollRestoredRef.current = true
    requestAnimationFrame(() => {
      scrollPageDivRefs.current
        .get(currentPageRef.current)
        ?.scrollIntoView({ behavior: 'instant', block: 'start' })
    })
  }, [viewMode, pageDims])

  // goTo: clamps to valid range. In spread mode, snaps to spread-start (odd page).
  // In scroll mode, goes directly to the exact page and scrolls to its div.
  const goTo = useCallback(
    (n: number) => {
      const doc = pdfDocRef.current
      if (!doc) return
      const clamped = Math.max(1, Math.min(n, doc.numPages))
      recordActivity()
      if (viewModeRef.current === 'scroll') {
        currentPageRef.current = clamped
        setCurrentPage(clamped)
        scheduleSave(clamped, doc.numPages)
        scrollPageDivRefs.current
          .get(clamped)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } else {
        const page = Math.max(1, toSpreadStart(clamped))
        currentPageRef.current = page
        setCurrentPage(page)
        scheduleSave(page, doc.numPages)
      }
    },
    [scheduleSave, recordActivity],
  )

  // Drive PDF search navigation: whenever targetPage changes, jump to it.
  // We skip page 0 (means no match selected) and only act when ready.
  useEffect(() => {
    if (pdfSearch.targetPage > 0 && !loading) goTo(pdfSearch.targetPage)
  }, [pdfSearch.targetPage]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run search whenever the query changes (after index is built).
  useEffect(() => {
    if (pdfSearch.indexBuilt) pdfSearch.search(searchQuery)
  }, [searchQuery, pdfSearch.indexBuilt]) // eslint-disable-line react-hooks/exhaustive-deps

  function openSearch() {
    setShowSearch(true)
    setShowSettings(false)
    // Build index lazily on first open
    if (pdfDocRef.current && !pdfSearch.indexBuilt && !pdfSearch.indexing) {
      pdfSearch.buildIndex(pdfDocRef.current)
    }
  }

  function closeSearch() {
    setShowSearch(false)
    setSearchQuery('')
  }

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName

      // Cmd+F / Ctrl+F — open search
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(true)
        setShowSettings(false)
        if (pdfDocRef.current && !pdfSearch.indexBuilt && !pdfSearch.indexing) {
          pdfSearch.buildIndex(pdfDocRef.current)
        }
        return
      }

      if (tag === 'INPUT') return

      // f — toggle fullscreen
      if (e.key === 'f') {
        if (!document.fullscreenElement)
          document.documentElement.requestFullscreen().catch(() => {})
        else document.exitFullscreen().catch(() => {})
        return
      }

      if (viewModeRef.current === 'scroll') {
        const container = scrollContainerRef.current
        if (!container) return
        const vh = container.clientHeight
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault()
            container.scrollBy({ top: 80, behavior: 'smooth' })
            break
          case 'ArrowUp':
            e.preventDefault()
            container.scrollBy({ top: -80, behavior: 'smooth' })
            break
          case 'PageDown':
          case ' ':
            e.preventDefault()
            container.scrollBy({ top: vh, behavior: 'smooth' })
            break
          case 'PageUp':
            e.preventDefault()
            container.scrollBy({ top: -vh, behavior: 'smooth' })
            break
          case 'Home':
            e.preventDefault()
            goTo(1)
            break
          case 'End':
            e.preventDefault()
            goTo(totalPagesRef.current)
            break
        }
      } else {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault()
          goTo(currentPageRef.current + 2)
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault()
          goTo(currentPageRef.current - 2)
        }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [goTo]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Page-jump editing ───────────────────────────────────────────

  function startEditing() {
    setPageInput(String(currentPageRef.current))
    setEditing(true)
  }

  function commitEdit() {
    const n = parseInt(pageInput, 10)
    if (!isNaN(n)) goTo(n)
    setEditing(false)
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEdit()
    }
    if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  // ── Zoom ────────────────────────────────────────────────────────

  function setZoomAndSave(z: ZoomLevel) {
    zoomRef.current = z
    setZoom(z)
    localStorage.setItem(LS_PDF_ZOOM, String(z))
    if (viewModeRef.current === 'scroll') {
      // Cancel all in-flight scroll renders; renderKey change re-triggers the IO effect
      scrollRenderTasks.current.forEach((t) => t.cancel())
      scrollRenderTasks.current.clear()
      setRenderKey((k) => k + 1)
    }
  }

  // ── PDF → EPUB conversion ───────────────────────────────────────

  async function handleConvert() {
    const doc = pdfDocRef.current
    if (!doc) return

    const numPages = doc.numPages
    setConverting(true)
    setConvertError(null)
    setConvertedId(null)
    setConvertPct(0)
    convertCancelledRef.current = false

    try {
      const chapters: ConvertChapter[] = []

      // ── Pre-pass: detect running headers/footers ────────────────
      setConvertStep('Analyzing page layout…')
      const excluded = await detectRunningText(doc, numPages)
      if (convertCancelledRef.current) return

      // ── Stage 1: PDF embedded outline (bookmarks / TOC links) ──
      setConvertStep('Reading table of contents…')
      const outlineBoundaries = await tryOutlineChapters(doc)

      if (outlineBoundaries) {
        // Prepend a Front Matter section if the first outline entry doesn't start at page 1
        const boundaries: ChapterBoundary[] =
          outlineBoundaries[0].startPage > 1
            ? [{ title: 'Front Matter', startPage: 1 }, ...outlineBoundaries]
            : outlineBoundaries

        for (let ci = 0; ci < boundaries.length; ci++) {
          if (convertCancelledRef.current) return

          const start = boundaries[ci].startPage
          const end = ci + 1 < boundaries.length ? boundaries[ci + 1].startPage - 1 : numPages

          const pageHtmls: string[] = []
          for (let pageNum = start; pageNum <= end; pageNum++) {
            if (convertCancelledRef.current) return
            setConvertStep(`Extracting "${boundaries[ci].title}" (page ${pageNum} of ${numPages})…`)
            setConvertPct(Math.round((pageNum / numPages) * 88))

            const page = await doc.getPage(pageNum)
            const vh = page.getViewport({ scale: 1 }).height
            const tc = await page.getTextContent()
            const hasText = tc.items.some(
              (it): it is TextItem => 'str' in it && (it as TextItem).str.trim().length > 0,
            )
            if (pageNum === start && !hasText) {
              // Image-only chapter start (e.g. a decorative number graphic) — inject a
              // heading and skip the placeholder that textItemsToHtml would emit.
              pageHtmls.push(`<h1>${escapeHtml(boundaries[ci].title)}</h1>`)
              await new Promise<void>((r) => setTimeout(r, 0))
              continue
            }
            pageHtmls.push(textItemsToHtml(tc.items, pageNum, vh, excluded))
            await new Promise<void>((r) => setTimeout(r, 0))
          }

          chapters.push({ title: boundaries[ci].title, content: pageHtmls.join('\n') })
        }
      } else {
        // ── Stages 1.5 + 2 + 3: single scan pass ────────────────────
        // One pass collects page HTML (needed by all stages), checks text
        // patterns (Stage 2), and tracks the page with the most internal
        // link annotations (Stage 1.5 TOC candidate).
        // Annotations are fetched in parallel with text — they are metadata
        // already parsed from the PDF binary, so the added latency is minimal.

        type PageScan = { html: string; matchedTitle: string | null; imageOnly: boolean }
        const pages: PageScan[] = []
        let tocCandidate: TocCandidate | null = null

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
          if (convertCancelledRef.current) return
          setConvertStep(`Scanning page ${pageNum} of ${numPages}…`)
          setConvertPct(Math.round((pageNum / numPages) * 88))

          const page = await doc.getPage(pageNum)
          const vh = page.getViewport({ scale: 1 }).height
          const [tc, rawAnnotations] = await Promise.all([
            page.getTextContent(),

            page.getAnnotations() as Promise<any[]>,
          ])

          const textItems = tc.items.filter(
            (it): it is TextItem => 'str' in it && it.str.length > 0,
          )
          const html = textItemsToHtml(tc.items, pageNum, vh, excluded)
          const firstLines = getFirstLines(tc.items, 3, excluded, vh)
          const matched =
            firstLines.find((l) => CHAPTER_HEADING_RE.test(l) && l.length < 80) ?? null
          const imageOnly = textItems.length === 0 // true when the page is graphics-only

          // Internal nav links: Link annotations that point inside the document
          const internalLinks: TocCandidate['links'] = rawAnnotations
            .filter((a) => a.subtype === 'Link' && a.dest != null && !a.url)
            .map((a) => ({
              dest: a.dest as unknown,
              rect: a.rect as [number, number, number, number],
            }))

          // Track the page with the most internal links — almost certainly the TOC.
          // We only keep textItems for this candidate to avoid storing entire books in memory.
          if (internalLinks.length > (tocCandidate?.links.length ?? 0)) {
            tocCandidate = { textItems, links: internalLinks }
          }

          pages.push({ html, matchedTitle: matched, imageOnly })
          await new Promise<void>((r) => setTimeout(r, 0))
        }

        if (convertCancelledRef.current) return

        // ── Stage 1.5: TOC link annotations ─────────────────────────
        const annotationBoundaries = await tryAnnotationChapters(doc, tocCandidate)
        if (annotationBoundaries) {
          const boundaries: ChapterBoundary[] =
            annotationBoundaries[0].startPage > 1
              ? [{ title: 'Front Matter', startPage: 1 }, ...annotationBoundaries]
              : annotationBoundaries

          for (let ci = 0; ci < boundaries.length; ci++) {
            const start = boundaries[ci].startPage
            const end = ci + 1 < boundaries.length ? boundaries[ci + 1].startPage - 1 : numPages
            const firstPage = pages[start - 1]
            // Only inject a heading when the chapter's first page is image-only
            // (e.g. a decorative chapter-number graphic). For text-based chapter
            // starts the extracted text already contains the heading — injecting
            // would cause it to appear twice.
            const chapterHtml = firstPage.imageOnly
              ? [
                  `<h1>${escapeHtml(boundaries[ci].title)}</h1>`,
                  ...pages.slice(start, end).map((p) => p.html),
                ]
              : pages.slice(start - 1, end).map((p) => p.html)
            chapters.push({ title: boundaries[ci].title, content: chapterHtml.join('\n') })
          }

          // ── Stage 2: text-pattern split ─────────────────────────────
        } else if (pages.filter((p) => p.matchedTitle !== null).length >= 2) {
          let curTitle = 'Front Matter'
          let curContent: string[] = []

          for (const { html, matchedTitle } of pages) {
            if (matchedTitle !== null && curContent.length > 0) {
              chapters.push({ title: curTitle, content: curContent.join('\n') })
              curContent = []
              curTitle = matchedTitle
            } else if (matchedTitle !== null) {
              curTitle = matchedTitle
            }
            curContent.push(html)
          }
          if (curContent.length) chapters.push({ title: curTitle, content: curContent.join('\n') })
        } else {
          // ── Stage 3: fixed-size chunking (fallback) ─────────────────
          let chapterStart = 1
          let pageBuffer: string[] = []

          for (let i = 0; i < pages.length; i++) {
            pageBuffer.push(pages[i].html)
            const pageNum = i + 1
            const isLastPage = pageNum === numPages
            if (pageBuffer.length === PAGES_PER_CHAPTER || isLastPage) {
              chapters.push({
                title:
                  numPages <= PAGES_PER_CHAPTER ? 'Content' : `Pages ${chapterStart}–${pageNum}`,
                content: pageBuffer.join('\n'),
              })
              pageBuffer = []
              chapterStart = pageNum + 1
            }
          }
        }
      }

      if (convertCancelledRef.current) return

      setConvertStep('Building EPUB…')
      setConvertPct(92)

      const result = await convertService.pdfToEpub({ itemId: item.id, chapters })

      setConvertPct(100)
      setConvertStep('Done')
      setConvertedId(result.id)
    } catch (err) {
      setConvertError(err instanceof Error ? err.message : 'Conversion failed.')
    }
  }

  function handleCancelConvert() {
    convertCancelledRef.current = true
    setConverting(false)
    setConvertError(null)
    setConvertedId(null)
  }

  // ── Render ──────────────────────────────────────────────────────

  const ready = !loading && !error
  const showRight = ready && currentPage + 1 <= totalPages
  // Navigate spreads: prev = two pages back, next = two pages forward
  const canPrev = ready && currentPage > 1
  const canNext = ready && currentPage + 2 <= totalPages

  // Page indicator strings
  const rightPage = showRight ? currentPage + 1 : null
  const pageShort = String(currentPage)
  const pageLong = rightPage
    ? `${currentPage}–${rightPage} / ${totalPages}`
    : `${currentPage} / ${totalPages}`

  return (
    <div className="pdf-reader">
      {/* ── Header ───────────────────────────────────────────── */}
      <header className="reader-header">
        <div className="reader-header-left">
          <button className="epub-back-btn" onClick={onBack}>
            ← Library
          </button>

          {/* Page jump — hidden while search bar is open */}
          {ready && !showSearch && (
            <div className="epub-chapter-nav" style={{ maxWidth: 180 }}>
              <div className="pdf-page-jump">
                {editing ? (
                  <input
                    className="pdf-page-input"
                    type="text"
                    inputMode="numeric"
                    value={pageInput}
                    autoFocus
                    onChange={(e) => setPageInput(e.target.value)}
                    onKeyDown={handleInputKeyDown}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={commitEdit}
                  />
                ) : (
                  <span
                    className="pdf-page-display"
                    onClick={startEditing}
                    title="Click to jump to a page"
                  >
                    {viewMode === 'scroll'
                      ? currentPage
                      : rightPage
                        ? `${currentPage}–${rightPage}`
                        : currentPage}
                  </span>
                )}
                <span className="pdf-page-sep">/ {totalPages}</span>
              </div>
            </div>
          )}
        </div>

        {showSearch ? (
          <SearchBar
            query={searchQuery}
            onQueryChange={setSearchQuery}
            matchCount={pdfSearch.matchCount}
            currentMatch={pdfSearch.currentMatch}
            onNext={pdfSearch.goNext}
            onPrev={pdfSearch.goPrev}
            onClose={closeSearch}
            statusOverride={pdfSearch.indexing ? 'Indexing…' : undefined}
          />
        ) : (
          <span className="reader-header-title">{item.title}</span>
        )}

        <div className="reader-header-right">
          {/* Convert to EPUB — hidden once a derived EPUB exists or search is open */}
          {ready && !hasEpub && !convertedId && !showSearch && (
            <button
              className="epub-top-btn"
              onClick={handleConvert}
              disabled={converting}
              title="Convert this PDF to EPUB for better reading"
            >
              ⇄ EPUB
            </button>
          )}

          {/* Search button */}
          {ready && !showSearch && (
            <button
              className="epub-top-btn reader-search-btn"
              onClick={openSearch}
              aria-label="Search in content"
              title="Search (⌘F)"
            >
              <svg
                viewBox="0 0 16 16"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="6.5" cy="6.5" r="4.5" />
                <line x1="10.5" y1="10.5" x2="14" y2="14" />
              </svg>
            </button>
          )}

          {/* Bookmark toggle */}
          {ready && !showSearch && (
            <button
              className={`epub-top-btn${isBookmarked ? ' active' : ''}`}
              onClick={handleBookmarkToggle}
              title={isBookmarked ? 'Remove bookmark' : 'Bookmark this page'}
              aria-label={isBookmarked ? 'Remove bookmark' : 'Bookmark this page'}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
                <path
                  d="M3 2h10v13l-5-3-5 3V2z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  fill={isBookmarked ? 'currentColor' : 'none'}
                />
              </svg>
            </button>
          )}

          {/* Bookmarks panel toggle */}
          {ready && !showSearch && (
            <button
              className={`epub-top-btn${showBookmarks ? ' active' : ''}`}
              onClick={() => {
                setShowBookmarks((s) => !s)
                setShowPanel(false)
              }}
              aria-label="Bookmarks"
              title="Bookmarks"
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
                <path d="M2 2h12v12l-4-2.5L6 14V2z" stroke="currentColor" strokeWidth="1.5" />
                <line x1="5" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.2" />
                <line x1="5" y1="9" x2="9" y2="9" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
          )}

          {/* Add note at current page */}
          {ready && !showSearch && (
            <button
              className="epub-top-btn"
              onClick={handleAddNote}
              title="Add note at this page"
              aria-label="Add note"
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
                <path
                  d="M2 3h12v8H9l-3 3V11H2V3z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  fill="none"
                />
              </svg>
            </button>
          )}

          {/* Annotations panel toggle */}
          {ready && !showSearch && (
            <button
              className={`epub-top-btn${showPanel ? ' active' : ''}`}
              onClick={() => {
                setShowPanel((s) => !s)
                setShowBookmarks(false)
              }}
              aria-label="Annotations"
              title="Annotations"
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
                <rect x="1" y="3" width="14" height="2" rx="1" fill="currentColor" opacity="0.5" />
                <rect x="1" y="7" width="10" height="2" rx="1" fill="currentColor" opacity="0.5" />
                <rect x="1" y="11" width="7" height="2" rx="1" fill="currentColor" opacity="0.5" />
              </svg>
            </button>
          )}

          {/* Scroll / Spread mode toggle */}
          {ready && !showSearch && (
            <button
              className={`epub-top-btn${viewMode === 'scroll' ? ' active' : ''}`}
              title={viewMode === 'scroll' ? 'Spread view' : 'Scroll view'}
              aria-label={viewMode === 'scroll' ? 'Switch to spread view' : 'Switch to scroll view'}
              onClick={() => {
                const next: ViewMode = viewMode === 'spread' ? 'scroll' : 'spread'
                localStorage.setItem(LS_PDF_VIEW_MODE, next)
                viewModeRef.current = next
                setViewMode(next)
                requestAnimationFrame(() => {
                  if (next === 'scroll') {
                    scrollPageDivRefs.current
                      .get(currentPageRef.current)
                      ?.scrollIntoView({ behavior: 'instant', block: 'start' })
                  } else {
                    goTo(currentPageRef.current) // re-snap to spread start
                  }
                })
              }}
            >
              {viewMode === 'scroll' ? (
                <svg
                  viewBox="0 0 16 16"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <rect x="1" y="2" width="6" height="12" rx="1" />
                  <rect x="9" y="2" width="6" height="12" rx="1" />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 16 16"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <rect x="3" y="1" width="10" height="14" rx="1" />
                  <line x1="5" y1="5" x2="11" y2="5" />
                  <line x1="5" y1="8" x2="11" y2="8" />
                  <line x1="5" y1="11" x2="9" y2="11" />
                </svg>
              )}
            </button>
          )}

          {/* Aa zoom settings */}
          <div className="epub-settings-wrapper">
            <button
              className={`epub-top-btn${showSettings ? ' active' : ''}`}
              onClick={() => {
                setShowSettings((s) => !s)
                setShowSearch(false)
              }}
              aria-label="Zoom settings"
            >
              Aa
            </button>

            {showSettings && (
              <>
                <div className="epub-settings-overlay" onClick={() => setShowSettings(false)} />
                <div className="epub-settings-panel">
                  <div className="epub-settings-row">
                    <span className="epub-settings-label">Zoom</span>
                    <div className="epub-settings-group">
                      {ZOOM_LEVELS.map((z) => (
                        <button
                          key={z}
                          className={`epub-settings-btn${zoom === z ? ' active' : ''}`}
                          onClick={() => setZoomAndSave(z)}
                        >
                          {Math.round(z * 100)}%
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ── Page viewport + annotations panel ───────────────── */}
      <div className="reader-with-panel">
        <div ref={outerRef} className="pdf-page-outer" style={{ flex: 1, minWidth: 0 }}>
          {loading && <div className="pdf-loading-msg">Loading PDF…</div>}
          {error && <div className="pdf-loading-msg">{error}</div>}

          {/* Two-page spread — left canvas always present, right only when there's a page */}
          {ready && viewMode === 'spread' && (
            <div className="pdf-spread">
              <div
                className="pdf-page-canvas-wrap"
                data-page={currentPage}
                onContextMenu={(e) => handlePageContextMenu(e, currentPage)}
                onClick={(e) => handlePageClick(e, currentPage)}
              >
                <canvas ref={leftCanvasRef} />
                <div className="textLayer" ref={leftTextLayerRef} />
                <div className="pdf-highlight-layer">{pageOverlays(currentPage)}</div>
              </div>
              {showRight && (
                <div
                  className="pdf-page-canvas-wrap"
                  data-page={currentPage + 1}
                  onContextMenu={(e) => handlePageContextMenu(e, currentPage + 1)}
                  onClick={(e) => handlePageClick(e, currentPage + 1)}
                >
                  <canvas ref={rightCanvasRef} />
                  <div className="textLayer" ref={rightTextLayerRef} />
                  <div className="pdf-highlight-layer">{pageOverlays(currentPage + 1)}</div>
                </div>
              )}
            </div>
          )}

          {/* Vertical scroll mode — stacked pages, lazy canvas rendering */}
          {ready && viewMode === 'scroll' && pageDims.length > 0 && (
            <div ref={scrollContainerRef} className="pdf-scroll-container">
              {pageDims.map((dim, idx) => {
                const pageNum = idx + 1
                const contW = (outerRef.current?.clientWidth ?? 800) - 48
                const fitScale = contW / dim.width
                const dispH = Math.round(dim.height * fitScale * zoomRef.current)
                const dispW = Math.round(dim.width * fitScale * zoomRef.current)
                return (
                  <div
                    key={pageNum}
                    ref={setScrollPageDiv(pageNum)}
                    className="pdf-scroll-page"
                    style={{ height: dispH, width: dispW }}
                    data-page={pageNum}
                    onContextMenu={(e) => handlePageContextMenu(e, pageNum)}
                    onClick={(e) => handlePageClick(e, pageNum)}
                  >
                    <canvas ref={setScrollCanvas(pageNum)} />
                    <div className="textLayer" ref={setScrollTextLayer(pageNum)} />
                    <div className="pdf-highlight-layer">{pageOverlays(pageNum)}</div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Click zones — spread mode only */}
          {canPrev && viewMode === 'spread' && (
            <div
              className="epub-click-prev"
              onClick={() => goTo(currentPage - 2)}
              aria-label="Previous spread"
              role="button"
            />
          )}
          {canNext && viewMode === 'spread' && (
            <div
              className="epub-click-next"
              onClick={() => goTo(currentPage + 2)}
              aria-label="Next spread"
              role="button"
            />
          )}

          {/* Page indicator — hover reveals full range */}
          {ready && (
            <div className="epub-page-footer">
              <span className="epub-page-short epub-page-indicator">{pageShort}</span>
              <span className="epub-page-long epub-page-indicator">{pageLong}</span>
            </div>
          )}
        </div>

        {showBookmarks && (
          <BookmarksPanel
            bookmarks={annot.annotations.filter((a) => a.type === 'bookmark')}
            contentType={item.content_type}
            onJump={handleJumpToAnnotation}
            onDelete={annot.deleteAnnotation}
            onClose={() => setShowBookmarks(false)}
          />
        )}
        {showPanel && (
          <AnnotationsPanel
            annotations={annot.annotations}
            contentType={item.content_type}
            onJump={handleJumpToAnnotation}
            onDelete={annot.deleteAnnotation}
            onUpdateNote={annot.updateNote}
            onMove={annot.swapAnnotationOrder}
            onClose={() => setShowPanel(false)}
          />
        )}
      </div>

      {/* Note editor modal */}
      {noteEditorState && (
        <div className="note-editor-overlay" onClick={closeNoteEditor}>
          <div className="note-editor-modal" onClick={(e) => e.stopPropagation()}>
            <div className="note-editor-header">
              {noteEditorState.existingId
                ? 'Edit note'
                : `Add note — Page ${currentPageRef.current}`}
            </div>
            <textarea
              className="note-editor-textarea"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  savePdfNote()
                }
                if (e.key === 'Escape') {
                  closeNoteEditor()
                }
              }}
              autoFocus
              rows={4}
              placeholder="Write a note…"
            />
            <div className="note-editor-themes">
              <label className="note-editor-themes-label">Themes</label>
              <ThemePicker
                value={noteThemes}
                onChange={setNoteThemes}
                allThemes={annot.allThemes}
                onVocabChange={annot.refreshThemes}
                idSuffix="note"
              />
            </div>
            <div className="note-editor-actions">
              <button className="annot-save-btn" onClick={savePdfNote}>
                Save
              </button>
              <button className="annot-cancel-btn" onClick={closeNoteEditor}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Text-selection popup (highlight swatches + Note) over the text layer */}
      {ready && (
        <TextSelectionPopup
          containerRef={outerRef}
          clearTrigger={`${currentPage}-${renderKey}-${zoom}-${viewMode}`}
          onHighlight={handleSelectionHighlight}
          onNote={handleSelectionNote}
        />
      )}

      {/* Right-click an existing highlight → recolor / themes / edit / delete */}
      {contextMenu && (
        <AnnotationContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          annotation={contextMenu.annotation}
          onDelete={(id) => {
            annot.deleteAnnotation(id)
            setContextMenu(null)
          }}
          onUpdate={(id, text) => annot.updateNote(id, text ?? '')}
          onSetColor={annot.setHighlightColor}
          allThemes={annot.allThemes}
          onSetThemes={annot.setAnnotationThemes}
          onVocabChange={annot.refreshThemes}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Click a note highlight → read its note */}
      {notePopup && (
        <NotePopover
          x={notePopup.x}
          y={notePopup.y}
          annotation={notePopup.annotation}
          onClose={() => setNotePopup(null)}
        />
      )}

      {/* ── Conversion progress modal ─────────────────────────── */}
      {converting && (
        <ConvertProgress
          step={convertStep}
          pct={convertPct}
          error={convertError}
          onCancel={handleCancelConvert}
          onOpenEpub={convertedId ? () => navigate(`/read/${convertedId}`) : undefined}
        />
      )}
    </div>
  )
}
