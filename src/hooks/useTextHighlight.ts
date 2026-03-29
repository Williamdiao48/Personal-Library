import { useEffect, useRef, useState, useCallback } from 'react'

const MARK_CLASS        = 'search-mark'
const MARK_ACTIVE_CLASS = 'search-mark-active'

/**
 * Highlights all occurrences of `query` inside `containerRef` by wrapping
 * matching text nodes in `<mark class="search-mark">` elements.
 *
 * Dependencies:
 *  - `query`      — triggers a full re-highlight
 *  - `contentKey` — pass the current chapter/page index so highlights
 *                   are reapplied after React updates innerHTML for a new chapter.
 *
 * Limitations: only works with DOM-rendered text (not canvas / PDF).
 */
/**
 * @param onActivate  Optional callback invoked with the active mark element on
 *                    each navigation step. Use to implement custom scrolling or
 *                    page-flipping (e.g. EPUB column pagination). Defaults to
 *                    `mark.scrollIntoView({ block: 'center', behavior: 'smooth' })`.
 */
export function useTextHighlight(
  containerRef: React.RefObject<HTMLElement | null>,
  query: string,
  contentKey?: string | number,
  onActivate?: (mark: HTMLElement) => void,
) {
  const [matchCount,    setMatchCount]    = useState(0)
  const [currentMatch,  setCurrentMatch]  = useState(0)
  const marksRef    = useRef<HTMLElement[]>([])
  const currentRef  = useRef(0)
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate  // keep ref in sync without adding it to effect deps

  // Re-highlight whenever query or content changes
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    clearMarks(container)
    marksRef.current = []

    const trimmed = query.trim()
    if (!trimmed) {
      setMatchCount(0)
      setCurrentMatch(0)
      return
    }

    const marks = applyHighlights(container, trimmed)
    marksRef.current = marks
    const total = marks.length
    setMatchCount(total)

    if (total > 0) {
      currentRef.current = 0
      setCurrentMatch(1)
      activateMark(marks, 0, onActivateRef.current)
    } else {
      currentRef.current = 0
      setCurrentMatch(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, contentKey])

  // Clear marks when the hook unmounts
  useEffect(() => {
    return () => {
      const container = containerRef.current
      if (container) clearMarks(container)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const goNext = useCallback(() => {
    const marks = marksRef.current
    if (marks.length === 0) return
    const next = (currentRef.current + 1) % marks.length
    currentRef.current = next
    setCurrentMatch(next + 1)
    activateMark(marks, next, onActivateRef.current)
  }, [])

  const goPrev = useCallback(() => {
    const marks = marksRef.current
    if (marks.length === 0) return
    const prev = (currentRef.current - 1 + marks.length) % marks.length
    currentRef.current = prev
    setCurrentMatch(prev + 1)
    activateMark(marks, prev, onActivateRef.current)
  }, [])

  return { matchCount, currentMatch, goNext, goPrev }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function activateMark(
  marks: HTMLElement[],
  index: number,
  onActivate?: (mark: HTMLElement) => void,
) {
  marks.forEach((m, i) => {
    if (i === index) {
      m.classList.add(MARK_ACTIVE_CLASS)
      if (onActivate) {
        onActivate(m)
      } else {
        m.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    } else {
      m.classList.remove(MARK_ACTIVE_CLASS)
    }
  })
}

/** Walk all text nodes inside `container` and wrap matches in <mark> elements. */
function applyHighlights(container: HTMLElement, query: string): HTMLElement[] {
  const marks: HTMLElement[] = []
  const lower = query.toLowerCase()

  // Collect text nodes first to avoid modifying the tree while walking it
  const textNodes: Text[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      // Skip existing mark elements (shouldn't be any, but defensive)
      if (parent.classList.contains(MARK_CLASS)) return NodeFilter.FILTER_REJECT
      // Skip script / style text
      const tag = parent.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT
      // Skip UI chrome: navigation bars, dropdowns, buttons.
      // Without this, chapter-nav <select> options and button labels match
      // the search query but are not scrollable/navigable in the reader.
      if (parent.closest('nav, select, option, button')) return NodeFilter.FILTER_SKIP
      return NodeFilter.FILTER_ACCEPT
    },
  })

  let node: Node | null
  while ((node = walker.nextNode())) textNodes.push(node as Text)

  for (const textNode of textNodes) {
    const text  = textNode.textContent ?? ''
    const found = findAll(text, lower)
    if (found.length === 0) continue

    // Replace this text node with a fragment of alternating text + <mark> nodes
    const frag = document.createDocumentFragment()
    let last = 0
    for (const [start, end] of found) {
      if (start > last) {
        frag.appendChild(document.createTextNode(text.slice(last, start)))
      }
      const mark = document.createElement('mark')
      mark.className = MARK_CLASS
      mark.textContent = text.slice(start, end)
      frag.appendChild(mark)
      marks.push(mark)
      last = end
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)))
    }
    textNode.parentNode?.replaceChild(frag, textNode)
  }

  return marks
}

/** Return all [start, end) index pairs where `lower` appears in `text` (case-insensitive). */
function findAll(text: string, lower: string): [number, number][] {
  const results: [number, number][] = []
  const textLow = text.toLowerCase()
  let pos = 0
  while (pos < textLow.length) {
    const idx = textLow.indexOf(lower, pos)
    if (idx === -1) break
    results.push([idx, idx + lower.length])
    pos = idx + lower.length
  }
  return results
}

/** Remove all <mark class="search-mark"> wrappers, restoring original text nodes. */
function clearMarks(container: HTMLElement) {
  const marks = container.querySelectorAll<HTMLElement>(`.${MARK_CLASS}`)
  for (const mark of marks) {
    const parent = mark.parentNode
    if (!parent) continue
    // Replace the mark with its text content
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
    parent.normalize()
  }
}
