import { useState, useCallback, useRef } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

// Queries shorter than this are treated as no-op — a 1-char query in a novel can
// match tens of thousands of times, and every occurrence becomes an overlay div.
const MIN_QUERY_LEN = 2

/** The pieces of a pdfjs text item this hook needs (a structural subset of TextItem). */
export interface SearchTextItem {
  str: string
  transform: number[] // [a, b, c, d, e, f] — text matrix in PDF space (y-up, baseline origin)
  width: number // advance width in scale-1 device px
  hasEOL: boolean // pdfjs marks the last item on a visual line
}

/** One search hit — a page and its highlight rect(s) in scale-1 viewport px. A
 *  single occurrence usually yields one rect, but 2–3 when the matched text
 *  straddles pdfjs item boundaries (style runs, ligature splits, line breaks). */
export interface PdfSearchMatch {
  page: number // 1-based
  rects: number[][] // [x, y, w, h] in scale-1 viewport px (top-left origin)
}

/** Per-page search index: the folded text plus the mapping back to item rects. */
export interface PageSearchIndex {
  folded: string // diacritic-folded, lowercased concatenation of item text (+ EOL spaces)
  itemStarts: number[] // folded offset where item i's text begins
  itemLens: number[] // folded length of item i's text
  rects: number[][] // scale-1 [x, y, w, h] for item i
}

interface UsePdfSearchResult {
  /** Build the text+geometry index from all pages. Call once when search opens. */
  buildIndex: (doc: PDFDocumentProxy) => Promise<void>
  indexBuilt: boolean
  indexing: boolean
  /** Run the search against the built index. */
  search: (query: string) => void
  /** Every occurrence across the document, in reading order. */
  matches: PdfSearchMatch[]
  matchCount: number
  currentMatch: number // 1-based; 0 = no matches
  /** The currently-selected match (page + rects), or null. */
  activeMatch: PdfSearchMatch | null
  /** Bumped on every navigation-worthy change (search / goNext / goPrev) so the
   *  reader can drive "jump to + center on the active match" from one effect,
   *  even when the target page is unchanged. */
  navNonce: number
  goNext: () => void
  goPrev: () => void
}

// ── Pure helpers (exported for unit testing) ────────────────────────────────

/** Diacritic-fold + lowercase: café → cafe, NAÏVE → naive. NFD decomposes
 *  accented letters into base + combining mark, which the range strip removes. */
const COMBINING_MARKS = /[̀-ͯ]/g
export function foldText(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase()
}

/** 2-D affine matrix multiply (m1 × m2), matching pdfjs `Util.transform`.
 *  Inlined so this module needs no pdfjs runtime import (keeps it pure + testable). */
export function mulTransform(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

// pdfjs derives per-font ascent; without the font metrics we use its default.
// A highlight box only needs to cover the glyphs, so an approximate ascent is fine.
const DEFAULT_ASCENT = 0.8

/** Scale-1, top-left-origin rect [x, y, w, h] for one text item, computed the
 *  same way pdfjs positions its text-layer spans: tx = viewportTransform × item
 *  transform; left = tx[4]; top = tx[5] − fontAscent; height = |(tx[2],tx[3])|. */
export function itemToRect(item: SearchTextItem, viewportTransform: number[]): number[] {
  const tx = mulTransform(viewportTransform, item.transform)
  const angle = Math.atan2(tx[1], tx[0])
  const fontHeight = Math.hypot(tx[2], tx[3])
  const ascent = fontHeight * DEFAULT_ASCENT
  let left: number
  let top: number
  if (angle === 0) {
    left = tx[4]
    top = tx[5] - ascent
  } else {
    left = tx[4] + ascent * Math.sin(angle)
    top = tx[5] - ascent * Math.cos(angle)
  }
  return [left, top, item.width, fontHeight]
}

/** Build one page's search index from its text items + scale-1 viewport transform. */
export function buildPageIndex(
  items: SearchTextItem[],
  viewportTransform: number[],
): PageSearchIndex {
  let folded = ''
  const itemStarts: number[] = []
  const itemLens: number[] = []
  const rects: number[][] = []
  for (const item of items) {
    const f = foldText(item.str)
    itemStarts.push(folded.length)
    itemLens.push(f.length)
    rects.push(itemToRect(item, viewportTransform))
    folded += f
    // A line break in the source has no whitespace item of its own, so insert a
    // space to keep words on adjacent lines from merging into a false match.
    if (item.hasEOL && !/\s$/.test(f)) folded += ' '
  }
  return { folded, itemStarts, itemLens, rects }
}

/** Last item index whose text starts at or before `offset` (or 0). */
function firstItemAtOrBefore(itemStarts: number[], offset: number): number {
  let lo = 0
  let hi = itemStarts.length // first index with itemStarts[index] > offset
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (itemStarts[mid] <= offset) lo = mid + 1
    else hi = mid
  }
  return Math.max(0, lo - 1)
}

/** Horizontally slice an item rect to the character span [fracStart, fracEnd] of
 *  its width. pdf.js often emits a whole line as one item, so a match inside it
 *  must be narrowed to the matched glyphs — otherwise the entire line highlights.
 *  Assumes uniform per-character advance within the item (a close approximation
 *  without per-glyph metrics). */
export function sliceRect(rect: number[], fracStart: number, fracEnd: number): number[] {
  const [x, y, w, h] = rect
  return [x + w * fracStart, y, w * (fracEnd - fracStart), h]
}

/** All non-overlapping occurrences of `foldedQuery` on one page, each as the
 *  rect(s) covering exactly the matched glyphs. Empty query / no hits → []. */
export function findMatchesInPage(idx: PageSearchIndex, foldedQuery: string): number[][][] {
  if (!foldedQuery) return []
  const out: number[][][] = []
  let from = 0
  for (;;) {
    const s = idx.folded.indexOf(foldedQuery, from)
    if (s === -1) break
    const e = s + foldedQuery.length
    const rects: number[][] = []
    for (let i = firstItemAtOrBefore(idx.itemStarts, s); i < idx.itemStarts.length; i++) {
      const is = idx.itemStarts[i]
      if (is >= e) break
      const len = idx.itemLens[i]
      const ie = is + len
      if (len > 0 && ie > s) {
        // Clip the match span to this item, then take that sub-slice of its rect.
        const fracStart = Math.max(0, s - is) / len
        const fracEnd = Math.min(len, e - is) / len
        rects.push(sliceRect(idx.rects[i], fracStart, fracEnd))
      }
    }
    if (rects.length > 0) out.push(rects)
    from = e // non-overlapping, left-to-right
  }
  return out
}

/**
 * Full-text search over a PDF with geometry-anchored highlights.
 *
 * Each occurrence carries scale-1 viewport rects (derived from the text items,
 * so no page needs to be rendered), which the reader draws through the same
 * percentage-overlay mechanism as annotations. Matching is case-insensitive and
 * diacritic-folded; every occurrence is individually navigable.
 */
export function usePdfSearch(): UsePdfSearchResult {
  const pageIndexRef = useRef<PageSearchIndex[]>([])

  const [indexBuilt, setIndexBuilt] = useState(false)
  const [indexing, setIndexing] = useState(false)
  const [matches, setMatches] = useState<PdfSearchMatch[]>([])
  const [matchCount, setMatchCount] = useState(0)
  const [currentMatch, setCurrentMatch] = useState(0)
  const [activeMatch, setActiveMatch] = useState<PdfSearchMatch | null>(null)
  const [navNonce, setNavNonce] = useState(0)
  const matchesRef = useRef<PdfSearchMatch[]>([])
  const currentRef = useRef(0)

  const buildIndex = useCallback(async (doc: PDFDocumentProxy) => {
    if (pageIndexRef.current.length > 0) return // already built
    setIndexing(true)
    const indices: PageSearchIndex[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const viewport = page.getViewport({ scale: 1 })
      const tc = await page.getTextContent()
      // TextItem is a structural superset of SearchTextItem; TextMarkedContent
      // entries (no `str`) are filtered out.
      const items = tc.items.filter((it) => 'str' in it) as unknown as SearchTextItem[]
      indices.push(buildPageIndex(items, viewport.transform))
    }
    pageIndexRef.current = indices
    setIndexBuilt(true)
    setIndexing(false)
  }, [])

  const activate = useCallback((list: PdfSearchMatch[], idx: number) => {
    currentRef.current = idx
    setCurrentMatch(list.length > 0 ? idx + 1 : 0)
    setActiveMatch(list[idx] ?? null)
    setNavNonce((n) => n + 1)
  }, [])

  const search = useCallback(
    (query: string) => {
      const folded = foldText(query.trim())
      if (folded.length < MIN_QUERY_LEN || pageIndexRef.current.length === 0) {
        matchesRef.current = []
        setMatches([])
        setMatchCount(0)
        activate([], 0)
        return
      }
      const found: PdfSearchMatch[] = []
      for (let p = 0; p < pageIndexRef.current.length; p++) {
        for (const rects of findMatchesInPage(pageIndexRef.current[p], folded)) {
          found.push({ page: p + 1, rects })
        }
      }
      matchesRef.current = found
      setMatches(found)
      setMatchCount(found.length)
      activate(found, 0)
    },
    [activate],
  )

  const goNext = useCallback(() => {
    const list = matchesRef.current
    if (list.length === 0) return
    activate(list, (currentRef.current + 1) % list.length)
  }, [activate])

  const goPrev = useCallback(() => {
    const list = matchesRef.current
    if (list.length === 0) return
    activate(list, (currentRef.current - 1 + list.length) % list.length)
  }, [activate])

  return {
    buildIndex,
    indexBuilt,
    indexing,
    search,
    matches,
    matchCount,
    currentMatch,
    activeMatch,
    navNonce,
    goNext,
    goPrev,
  }
}
