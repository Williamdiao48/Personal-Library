import { useEffect } from 'react'
import type { RefObject } from 'react'
import type { Annotation } from '../types'

/** Popup anchor + the annotation it belongs to (screen coords). */
export interface MarkPopup {
  x: number
  y: number
  annotation: Annotation
}

interface MarkInteractionHandlers {
  /** Open the read-only note popover (left-click on a note mark). */
  setNotePopup: (popup: MarkPopup | null) => void
  /** Open the edit/recolor/delete context menu (right-click on any mark). */
  setContextMenu: (popup: MarkPopup | null) => void
}

/**
 * Wires left-click (note popover) and right-click (context menu) interactions
 * on annotation `<mark data-annotation-id>` elements inside `containerRef`.
 *
 * Shared by the DOM-rendered readers (HTML + EPUB); the PDF reader draws its
 * text on canvas and has no `<mark>` elements, so it does not use this hook.
 *
 * Listeners are re-bound whenever `annotations` changes so the closures see the
 * current list when resolving `data-annotation-id` → annotation.
 */
export function useMarkInteractions(
  containerRef: RefObject<HTMLElement | null>,
  annotations: Annotation[],
  { setNotePopup, setContextMenu }: MarkInteractionHandlers,
): void {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleMarkClick = (e: MouseEvent) => {
      const mark = (e.target as HTMLElement).closest(
        'mark[data-annotation-id]',
      ) as HTMLElement | null
      if (!mark || mark.dataset.type !== 'note') return
      const annotation = annotations.find((a) => a.id === mark.dataset.annotationId)
      if (!annotation?.note_text) return
      const rect = mark.getBoundingClientRect()
      setNotePopup({ x: rect.left + rect.width / 2, y: rect.top, annotation })
    }

    const handleContextMenu = (e: MouseEvent) => {
      const mark = (e.target as HTMLElement).closest(
        'mark[data-annotation-id]',
      ) as HTMLElement | null
      if (!mark) return
      e.preventDefault()
      const annotation = annotations.find((a) => a.id === mark.dataset.annotationId)
      if (!annotation) return
      const rect = mark.getBoundingClientRect()
      setNotePopup(null)
      setContextMenu({ x: rect.left + rect.width / 2, y: rect.top, annotation })
    }

    container.addEventListener('click', handleMarkClick)
    container.addEventListener('contextmenu', handleContextMenu)
    return () => {
      container.removeEventListener('click', handleMarkClick)
      container.removeEventListener('contextmenu', handleContextMenu)
    }
  }, [containerRef, annotations, setNotePopup, setContextMenu])
}
