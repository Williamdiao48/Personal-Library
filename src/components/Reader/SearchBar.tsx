import { useRef, useEffect } from 'react'
import { readerService } from '../../services/reader'

interface Props {
  query: string
  onQueryChange: (q: string) => void
  matchCount: number
  currentMatch: number // 1-based; 0 = no matches
  onNext: () => void
  onPrev: () => void
  onClose: () => void
  /** Optional override for the count label (e.g. "Indexing…" during PDF index build). */
  statusOverride?: string
  /** PDF reader only. On macOS, focusing this input programmatically doesn't sync
   *  its text-input state to the OS — keydowns arrive but no text is inserted until
   *  the window's key status changes (a click or an app-switch). When set, the bar
   *  asks the main process to bounce key status on open so the field is immediately
   *  typeable. EPUB/HTML readers get an active text-input context for free and don't
   *  need it. See reader.ts `reader:resyncFocus`. */
  resyncFocusOnOpen?: boolean
}

/** Inline search bar that lives in the reader header. */
export default function SearchBar({
  query,
  onQueryChange,
  matchCount,
  currentMatch,
  onNext,
  onPrev,
  onClose,
  statusOverride,
  resyncFocusOnOpen,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    if (resyncFocusOnOpen) readerService.resyncFocus()
  }, [resyncFocusOnOpen])

  const hasQuery = query.length > 0
  const noResults = hasQuery && matchCount === 0 && !statusOverride
  const countLabel =
    statusOverride ??
    (hasQuery ? (matchCount === 0 ? 'No results' : `${currentMatch} / ${matchCount}`) : '')

  return (
    <div className="reader-search-bar">
      <input
        ref={inputRef}
        autoFocus
        className={`reader-search-input${noResults ? ' no-results' : ''}`}
        placeholder="Search in content…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.shiftKey ? onPrev() : onNext()
          }
          if (e.key === 'Escape') onClose()
        }}
        spellCheck={false}
      />
      {countLabel && <span className="reader-search-count">{countLabel}</span>}
      <button
        className="reader-search-nav"
        onClick={onPrev}
        disabled={matchCount === 0}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        ↑
      </button>
      <button
        className="reader-search-nav"
        onClick={onNext}
        disabled={matchCount === 0}
        title="Next match (Enter)"
        aria-label="Next match"
      >
        ↓
      </button>
      <button
        className="reader-search-close"
        onClick={onClose}
        title="Close search (Escape)"
        aria-label="Close search"
      >
        ✕
      </button>
    </div>
  )
}
