import { useState, useEffect, useRef, useCallback } from 'react'

interface Props {
  containerRef: React.RefObject<HTMLElement | null>
  onHighlight:  (range: Range) => void
  onNote:       (range: Range) => void
  disabled?:    boolean
}

interface PopupState {
  x:    number
  y:    number
  range: Range
}

export default function TextSelectionPopup({ containerRef, onHighlight, onNote, disabled }: Props) {
  const [popup, setPopup] = useState<PopupState | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)

  const handleMouseUp = useCallback(() => {
    if (disabled) return
    // Small delay so the selection is settled after the mouseup
    requestAnimationFrame(() => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setPopup(null)
        return
      }
      const text = sel.toString().trim()
      if (text.length < 1) {
        setPopup(null)
        return
      }
      // Verify the selection is inside our container
      const container = containerRef.current
      if (!container) { setPopup(null); return }
      const range = sel.getRangeAt(0)
      if (!container.contains(range.commonAncestorContainer)) {
        setPopup(null)
        return
      }

      const rect = range.getBoundingClientRect()
      if (!rect || rect.width === 0) { setPopup(null); return }

      // Clamp within the container's visible bounds so the popup never
      // overlaps the toolbar above or a side panel to the right.
      const contRect = container.getBoundingClientRect()
      const POPUP_W  = 112
      const POPUP_H  = 44

      const x = Math.min(
        Math.max(rect.left + rect.width / 2 - POPUP_W / 2, contRect.left + 4),
        contRect.right - POPUP_W - 4
      )
      // Prefer above the selection; fall back to below if too close to the top.
      const yAbove = rect.top - POPUP_H - 4
      const yBelow = rect.bottom + 4
      const y = yAbove >= contRect.top + 4 ? yAbove : yBelow

      setPopup({ x, y, range })
    })
  }, [disabled, containerRef])

  // Dismiss on outside mousedown
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!popup) return
      if (popupRef.current && popupRef.current.contains(e.target as Node)) return
      setPopup(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [popup])

  // Attach mouseup at document level so click zones inside the container
  // (e.g. EPUB page-flip hit areas) don't swallow the event before we see it.
  // The container check inside handleMouseUp still filters foreign selections.
  useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp)
    return () => document.removeEventListener('mouseup', handleMouseUp)
  }, [handleMouseUp])

  // Dismiss when selection is cleared (e.g. user clicks elsewhere in content)
  useEffect(() => {
    const onSelChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) setPopup(null)
    }
    document.addEventListener('selectionchange', onSelChange)
    return () => document.removeEventListener('selectionchange', onSelChange)
  }, [])

  if (!popup) return null

  const handleHighlight = () => {
    const { range } = popup
    setPopup(null)
    window.getSelection()?.removeAllRanges()
    onHighlight(range)
  }

  const handleNote = () => {
    const { range } = popup
    setPopup(null)
    // Keep selection for range context; caller will clear it after extracting
    onNote(range)
  }

  return (
    <div
      ref={popupRef}
      className="text-selection-popup"
      style={{ left: popup.x, top: popup.y }}
      // Prevent mousedown from clearing selection before we process it
      onMouseDown={e => e.preventDefault()}
    >
      <button className="sel-popup-btn" onClick={handleHighlight} title="Highlight">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1" y="10" width="14" height="4" rx="1" fill="currentColor" opacity="0.6"/>
          <rect x="3" y="2" width="10" height="8" rx="1" fill="currentColor"/>
        </svg>
        Highlight
      </button>
      <button className="sel-popup-btn" onClick={handleNote} title="Add note">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 3h12v8H9l-3 3V11H2V3z" stroke="currentColor" strokeWidth="1.5" fill="none"/>
          <line x1="5" y1="7" x2="11" y2="7" stroke="currentColor" strokeWidth="1.5"/>
          <line x1="5" y1="10" x2="9" y2="10" stroke="currentColor" strokeWidth="1.5"/>
        </svg>
        Note
      </button>
    </div>
  )
}
