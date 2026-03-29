import { useState, useCallback, useRef } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist'

/** One search hit — the (1-based) page number that contains the query. */
interface PdfMatch {
  page: number
}

interface UsePdfSearchResult {
  /** Build the text index from all pages. Call once when search opens. */
  buildIndex:   (doc: PDFDocumentProxy) => Promise<void>
  indexBuilt:   boolean
  indexing:     boolean
  /** Run the search against the built index. */
  search:       (query: string) => void
  matchCount:   number
  currentMatch: number    // 1-based; 0 = no matches
  /** The page the reader should navigate to (1-based, 0 = none). Changes on
   *  every `search`, `goNext`, and `goPrev` call. Caller drives navigation. */
  targetPage:   number
  goNext:       () => void
  goPrev:       () => void
}

/**
 * Full-text search over a PDF document.
 *
 * Since PDF pages are rendered as canvas elements, text highlights are not
 * possible in the DOM. Instead, we build a plain-text index, find matching
 * pages, and expose a `targetPage` that the reader can navigate to.
 */
export function usePdfSearch(): UsePdfSearchResult {
  const pageTextsRef = useRef<string[]>([])

  const [indexBuilt,   setIndexBuilt]   = useState(false)
  const [indexing,     setIndexing]     = useState(false)
  const [matchCount,   setMatchCount]   = useState(0)
  const [currentMatch, setCurrentMatch] = useState(0)
  const [targetPage,   setTargetPage]   = useState(0)
  const matchesRef = useRef<PdfMatch[]>([])
  const currentRef = useRef(0)

  const buildIndex = useCallback(async (doc: PDFDocumentProxy) => {
    if (pageTextsRef.current.length > 0) return  // already built
    setIndexing(true)
    const texts: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const tc   = await page.getTextContent()
      const text = tc.items
        .filter((it): it is TextItem => 'str' in it)
        .map(it => it.str)
        .join(' ')
      texts.push(text.toLowerCase())
    }
    pageTextsRef.current = texts
    setIndexBuilt(true)
    setIndexing(false)
  }, [])

  const search = useCallback((query: string) => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed || pageTextsRef.current.length === 0) {
      matchesRef.current = []
      setMatchCount(0)
      setCurrentMatch(0)
      setTargetPage(0)
      return
    }
    const found: PdfMatch[] = []
    for (let i = 0; i < pageTextsRef.current.length; i++) {
      if (pageTextsRef.current[i].includes(trimmed)) {
        found.push({ page: i + 1 })
      }
    }
    matchesRef.current = found
    setMatchCount(found.length)
    if (found.length > 0) {
      currentRef.current = 0
      setCurrentMatch(1)
      setTargetPage(found[0].page)
    } else {
      currentRef.current = 0
      setCurrentMatch(0)
      setTargetPage(0)
    }
  }, [])

  const goNext = useCallback(() => {
    const matches = matchesRef.current
    if (matches.length === 0) return
    const next = (currentRef.current + 1) % matches.length
    currentRef.current = next
    setCurrentMatch(next + 1)
    setTargetPage(matches[next].page)
  }, [])

  const goPrev = useCallback(() => {
    const matches = matchesRef.current
    if (matches.length === 0) return
    const prev = (currentRef.current - 1 + matches.length) % matches.length
    currentRef.current = prev
    setCurrentMatch(prev + 1)
    setTargetPage(matches[prev].page)
  }, [])

  return { buildIndex, indexBuilt, indexing, search, matchCount, currentMatch, targetPage, goNext, goPrev }
}
