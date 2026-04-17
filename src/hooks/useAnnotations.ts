import { useState, useEffect, useCallback, useRef } from 'react'
import { annotationsService } from '../services/annotationsService'
import type { Annotation, ContentType, CreateAnnotationPayload } from '../types'

interface UseAnnotationsOptions {
  itemId:       string
  contentRef:   React.RefObject<HTMLElement | null>
  /** null for single-page articles and PDF (no chapter concept).
   *  0-based chapter index for EPUB and multi-chapter HTML. */
  chapterIndex: number | null
}

export interface UseAnnotationsReturn {
  annotations:          Annotation[]
  createBookmark:       (position: number) => Promise<void>
  createHighlight:      (range: Range, position: number) => Promise<void>
  createNote:           (position: number, noteText: string, range?: Range) => Promise<void>
  updateNote:           (id: string, noteText: string | null) => Promise<void>
  deleteAnnotation:     (id: string) => Promise<void>
  swapAnnotationOrder:  (id1: string, id2: string) => Promise<void>
  applyHighlightsToDOM: (chapterIndex: number | null) => void
}

// ── DOM helpers ────────────────────────────────────────────────────────────

/** Build a text-node offset map for the container, skipping SCRIPT/STYLE and
 *  existing annotation marks (so we don't double-wrap). */
function buildTextMap(container: HTMLElement): Array<{ node: Text; start: number; end: number }> {
  const map: Array<{ node: Text; start: number; end: number }> = []
  let offset = 0
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT
      // Skip text inside existing marks so re-anchoring doesn't nest them
      if (parent.closest('mark[data-annotation-id]')) return NodeFilter.FILTER_SKIP
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node as Text
    const len = text.data.length
    map.push({ node: text, start: offset, end: offset + len })
    offset += len
  }
  return map
}

/** Extract contextBefore / contextAfter (up to 40 chars each) from a Range. */
function extractContext(range: Range): { contextBefore: string; contextAfter: string } {
  const container = range.commonAncestorContainer.parentElement
  if (!container) return { contextBefore: '', contextAfter: '' }

  // Build full text of the container element
  const fullText = container.textContent ?? ''
  const selected = range.toString()

  // Find the offset of the range within the container's text
  // Use a temporary range to get character offset
  const preRange = document.createRange()
  preRange.selectNodeContents(container)
  preRange.setEnd(range.startContainer, range.startOffset)
  const beforeText = preRange.toString()
  const rangeStart = beforeText.length

  const contextBefore = fullText.slice(Math.max(0, rangeStart - 40), rangeStart)
  const contextAfter  = fullText.slice(rangeStart + selected.length, rangeStart + selected.length + 40)
  return { contextBefore, contextAfter }
}

/** Score how well a candidate match position aligns with stored context. */
function contextScore(flat: string, pos: number, len: number, before: string, after: string): number {
  let score = 0
  if (before) {
    const actual = flat.slice(Math.max(0, pos - before.length), pos)
    for (let i = 0; i < Math.min(actual.length, before.length); i++) {
      if (actual[actual.length - 1 - i] === before[before.length - 1 - i]) score++
    }
  }
  if (after) {
    const actual = flat.slice(pos + len, pos + len + after.length)
    for (let i = 0; i < Math.min(actual.length, after.length); i++) {
      if (actual[i] === after[i]) score++
    }
  }
  return score
}

/** Remove all annotation marks from the container, restoring text nodes. */
export function clearAnnotationMarks(container: HTMLElement): void {
  const marks = container.querySelectorAll('mark[data-annotation-id]')
  marks.forEach(mark => {
    const parent = mark.parentNode
    if (!parent) return
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    parent.normalize()
  })
}

/** Wrap the given Range in a <mark data-annotation-id="..." data-type="..."> element. */
function applyMarkToRange(range: Range, annotationId: string, type: AnnotationType): void {
  try {
    const mark = document.createElement('mark')
    mark.className = 'annotation-mark'
    mark.dataset.annotationId = annotationId
    mark.dataset.type = type
    range.surroundContents(mark)
  } catch {
    // surroundContents throws if range crosses element boundaries;
    // fall back to extractContents + wrap
    try {
      const mark = document.createElement('mark')
      mark.className = 'annotation-mark'
      mark.dataset.annotationId = annotationId
      mark.dataset.type = type
      mark.appendChild(range.extractContents())
      range.insertNode(mark)
    } catch {
      // Give up silently — annotation stays in panel as text only
    }
  }
}

/** Re-anchor a stored highlight annotation into the live DOM. */
function reanchorHighlight(annotation: Annotation, container: HTMLElement): void {
  if (!annotation.selected_text) return

  const map = buildTextMap(container)
  if (map.length === 0) return

  // Build flat string
  let flat = ''
  for (const entry of map) flat += entry.node.data

  const needle = annotation.selected_text
  const before  = annotation.context_before ?? ''
  const after   = annotation.context_after  ?? ''

  // Find all occurrences
  const matches: number[] = []
  let searchFrom = 0
  while (true) {
    const idx = flat.indexOf(needle, searchFrom)
    if (idx === -1) break
    matches.push(idx)
    searchFrom = idx + 1
  }

  if (matches.length === 0) return   // not found — leave annotation in panel with indicator

  // Pick best match by context score
  let bestPos = matches[0]
  if (matches.length > 1) {
    let bestScore = -1
    for (const pos of matches) {
      const score = contextScore(flat, pos, needle.length, before, after)
      if (score > bestScore) { bestScore = score; bestPos = pos }
    }
  }

  const matchStart = bestPos
  const matchEnd   = bestPos + needle.length

  // Map flat offsets back to text nodes
  let startNode: Text | null = null, startOffset = 0
  let endNode:   Text | null = null, endOffset   = 0

  for (const entry of map) {
    if (startNode === null && matchStart >= entry.start && matchStart < entry.end) {
      startNode   = entry.node
      startOffset = matchStart - entry.start
    }
    if (endNode === null && matchEnd > entry.start && matchEnd <= entry.end) {
      endNode   = entry.node
      endOffset = matchEnd - entry.start
    }
    if (startNode && endNode) break
  }

  if (!startNode || !endNode) return

  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  applyMarkToRange(range, annotation.id, annotation.type)
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useAnnotations(opts: UseAnnotationsOptions): UseAnnotationsReturn {
  const { itemId, contentRef, chapterIndex } = opts
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  // Track the last chapter we applied highlights for, to avoid redundant work
  const appliedChapterRef = useRef<number | null>(undefined as unknown as number | null)

  useEffect(() => {
    setAnnotations([])
    appliedChapterRef.current = undefined as unknown as number | null
    annotationsService.getForItem(itemId).then(setAnnotations)
  }, [itemId])

  const createBookmark = useCallback(async (position: number) => {
    const payload: CreateAnnotationPayload = {
      item_id:       itemId,
      type:          'bookmark',
      chapter_index: chapterIndex,
      position,
    }
    const created = await annotationsService.create(payload)
    setAnnotations(prev => [...prev, created])
  }, [itemId, chapterIndex])

  const createHighlight = useCallback(async (range: Range, position: number) => {
    const text = range.toString().trim()
    if (text.length < 1) return

    const { contextBefore, contextAfter } = extractContext(range)
    const payload: CreateAnnotationPayload = {
      item_id:        itemId,
      type:           'highlight',
      chapter_index:  chapterIndex,
      position,
      selected_text:  text,
      context_before: contextBefore || null,
      context_after:  contextAfter  || null,
    }
    const created = await annotationsService.create(payload)
    setAnnotations(prev => [...prev, created])
    // Immediately paint the mark so it appears without waiting for applyHighlightsToDOM
    applyMarkToRange(range, created.id, 'highlight')
  }, [itemId, chapterIndex])

  const createNote = useCallback(async (position: number, noteText: string, range?: Range) => {
    let text: string | null = null
    let contextBefore: string | null = null
    let contextAfter: string | null  = null

    if (range) {
      text = range.toString().trim() || null
      if (text) {
        const ctx = extractContext(range)
        contextBefore = ctx.contextBefore || null
        contextAfter  = ctx.contextAfter  || null
      }
    }

    const payload: CreateAnnotationPayload = {
      item_id:        itemId,
      type:           'note',
      chapter_index:  chapterIndex,
      position,
      selected_text:  text,
      context_before: contextBefore,
      context_after:  contextAfter,
      note_text:      noteText,
    }
    const created = await annotationsService.create(payload)
    setAnnotations(prev => [...prev, created])
    // If anchored to text, immediately paint the mark
    if (range && text) applyMarkToRange(range, created.id, 'note')
  }, [itemId, chapterIndex])

  const updateNote = useCallback(async (id: string, noteText: string | null) => {
    await annotationsService.updateNote(id, noteText)
    setAnnotations(prev => prev.map(a => a.id === id ? { ...a, note_text: noteText } : a))
  }, [])

  const deleteAnnotation = useCallback(async (id: string) => {
    await annotationsService.delete(id)
    setAnnotations(prev => prev.filter(a => a.id !== id))
    // Remove mark from DOM if present
    const container = contentRef.current
    if (container) {
      const mark = container.querySelector(`mark[data-annotation-id="${id}"]`)
      if (mark) {
        const parent = mark.parentNode!
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
        parent.removeChild(mark)
        parent.normalize()
      }
    }
  }, [contentRef])

  const swapAnnotationOrder = useCallback(async (id1: string, id2: string) => {
    setAnnotations(prev => {
      const arr = [...prev]
      const i = arr.findIndex(a => a.id === id1)
      const j = arr.findIndex(a => a.id === id2)
      if (i === -1 || j === -1) return prev
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
      return arr
    })
    await annotationsService.swapSortOrder(id1, id2)
  }, [])

  const applyHighlightsToDOM = useCallback((targetChapter: number | null) => {
    const container = contentRef.current
    if (!container) return

    // Clear previous marks first
    clearAnnotationMarks(container)
    appliedChapterRef.current = targetChapter

    // Filter to text-anchored annotations for this chapter
    const toApply = annotations.filter(a =>
      (a.type === 'highlight' || (a.type === 'note' && a.selected_text)) &&
      a.chapter_index === targetChapter
    )

    for (const annotation of toApply) {
      reanchorHighlight(annotation, container)
    }
  }, [annotations, contentRef])

  return {
    annotations,
    createBookmark,
    createHighlight,
    createNote,
    updateNote,
    deleteAnnotation,
    swapAnnotationOrder,
    applyHighlightsToDOM,
  }
}
