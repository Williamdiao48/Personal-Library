import { useRef, useEffect } from 'react'

interface Props {
  query: string
  onQueryChange: (q: string) => void
  matchCount: number
  currentMatch: number   // 1-based; 0 = no matches
  onNext: () => void
  onPrev: () => void
  onClose: () => void
  /** Optional override for the count label (e.g. "Indexing…" during PDF index build). */
  statusOverride?: string
}

/** Inline search bar that lives in the reader header. */
export default function SearchBar({
  query, onQueryChange, matchCount, currentMatch, onNext, onPrev, onClose, statusOverride,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const hasQuery   = query.length > 0
  const noResults  = hasQuery && matchCount === 0 && !statusOverride
  const countLabel = statusOverride
    ?? (hasQuery ? (matchCount === 0 ? 'No results' : `${currentMatch} / ${matchCount}`) : '')

  return (
    <div className="reader-search-bar">
      <input
        ref={inputRef}
        className={`reader-search-input${noResults ? ' no-results' : ''}`}
        placeholder="Search in content…"
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.shiftKey ? onPrev() : onNext() }
          if (e.key === 'Escape') onClose()
        }}
        spellCheck={false}
      />
      {countLabel && (
        <span className="reader-search-count">{countLabel}</span>
      )}
      <button
        className="reader-search-nav"
        onClick={onPrev}
        disabled={matchCount === 0}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >↑</button>
      <button
        className="reader-search-nav"
        onClick={onNext}
        disabled={matchCount === 0}
        title="Next match (Enter)"
        aria-label="Next match"
      >↓</button>
      <button
        className="reader-search-close"
        onClick={onClose}
        title="Close search (Escape)"
        aria-label="Close search"
      >✕</button>
    </div>
  )
}
