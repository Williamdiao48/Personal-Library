import { useState, useEffect, useRef, useCallback } from 'react'
import type { HighlightColor } from '../../types'
import { HIGHLIGHT_COLORS } from '../../constants/highlightColors'
import DefinitionPopover from './DefinitionPopover'

// A selection is "definable" when it's a single word (letters, with inner
// apostrophes/hyphens) — the dictionary is single-word, so we hide "Define" for
// phrases rather than showing a lookup that always misses.
const SINGLE_WORD = /^[\p{L}][\p{L}'-]*$/u

interface DefineState {
  word: string
  x: number
  y: number
}

interface Props {
  containerRef: React.RefObject<HTMLElement | null>
  onHighlight: (range: Range, color: HighlightColor) => void
  onNote: (range: Range) => void
  disabled?: boolean
  clearTrigger?: string | number
}

interface PopupState {
  x: number
  y: number
  range: Range
}

export default function TextSelectionPopup({
  containerRef,
  onHighlight,
  onNote,
  disabled,
  clearTrigger,
}: Props) {
  const [popup, setPopup] = useState<PopupState | null>(null)
  const [define, setDefine] = useState<DefineState | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)

  // Clear whenever the parent signals a navigation (page or chapter changed).
  // This catches all navigation paths: keyboard, click zones, animated transitions.
  useEffect(() => {
    setPopup(null)
    setDefine(null)
    window.getSelection()?.removeAllRanges()
  }, [clearTrigger])

  const handleMouseUp = useCallback(
    (e: MouseEvent) => {
      if (disabled) return
      // Defer to a macrotask so the click handler (which may clear the selection
      // or navigate) fires before we decide whether to show the popup.
      setTimeout(() => {
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
        if (!container) {
          setPopup(null)
          return
        }

        // If the mouseup landed outside the reading area (e.g. a nav button or
        // toolbar), dismiss rather than re-showing the popup. This prevents the
        // popup from flashing back after the user clicks away to flip a page.
        if (e.target && !container.contains(e.target as Node)) {
          setPopup(null)
          return
        }

        const range = sel.getRangeAt(0)
        if (!container.contains(range.commonAncestorContainer)) {
          setPopup(null)
          return
        }

        const rect = range.getBoundingClientRect()
        if (!rect || rect.width === 0) {
          setPopup(null)
          return
        }

        // Clamp to viewport edges (popup is position:fixed so window coords are
        // always correct, even when the content div has a CSS translateX applied).
        const POPUP_W = 120
        const POPUP_H = 44
        const MARGIN = 8
        const MIN_TOP = 52 // keep below the reader toolbar

        const x = Math.min(
          Math.max(rect.left + rect.width / 2 - POPUP_W / 2, MARGIN),
          window.innerWidth - POPUP_W - MARGIN,
        )
        // Prefer above the selection; fall back to below if too close to the top.
        const yAbove = rect.top - POPUP_H - 6
        const yBelow = rect.bottom + 6
        const y = yAbove >= MIN_TOP ? yAbove : yBelow

        setPopup({ x, y, range })
      })
    },
    [disabled, containerRef],
  )

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

  const handleHighlight = (color: HighlightColor) => {
    if (!popup) return
    const { range } = popup
    setPopup(null)
    window.getSelection()?.removeAllRanges()
    onHighlight(range, color)
  }

  const handleNote = () => {
    if (!popup) return
    const { range } = popup
    setPopup(null)
    // Keep selection for range context; caller will clear it after extracting
    onNote(range)
  }

  const handleDefine = () => {
    if (!popup) return
    const { range } = popup
    const word = range.toString().trim()
    const rect = range.getBoundingClientRect()
    setPopup(null)
    window.getSelection()?.removeAllRanges()
    setDefine({ word, x: rect.left + rect.width / 2, y: rect.bottom })
  }

  const definable = popup ? SINGLE_WORD.test(popup.range.toString().trim()) : false

  return (
    <>
      {popup && (
        <div
          ref={popupRef}
          className="text-selection-popup"
          style={{ left: popup.x, top: popup.y }}
          // Prevent mousedown from clearing selection before we process it
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="sel-popup-swatches" role="group" aria-label="Highlight color">
            {HIGHLIGHT_COLORS.map(({ key, label, swatch }) => (
              <button
                key={key}
                className="sel-popup-swatch"
                style={{ background: swatch }}
                onClick={() => handleHighlight(key)}
                title={`Highlight ${label.toLowerCase()}`}
                aria-label={`Highlight ${label.toLowerCase()}`}
              />
            ))}
          </div>
          <span className="sel-popup-divider" aria-hidden="true" />
          <button className="sel-popup-btn" onClick={handleNote} title="Add note">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2 3h12v8H9l-3 3V11H2V3z"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
              />
              <line x1="5" y1="7" x2="11" y2="7" stroke="currentColor" strokeWidth="1.5" />
              <line x1="5" y1="10" x2="9" y2="10" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            Note
          </button>
          {definable && (
            <button className="sel-popup-btn" onClick={handleDefine} title="Define word">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M4 2h6l3 3v9H4V2z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  fill="none"
                  strokeLinejoin="round"
                />
                <line x1="6" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.5" />
                <line x1="6" y1="11" x2="9" y2="11" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              Define
            </button>
          )}
        </div>
      )}
      {define && (
        <DefinitionPopover
          word={define.word}
          x={define.x}
          y={define.y}
          onClose={() => setDefine(null)}
        />
      )}
    </>
  )
}
