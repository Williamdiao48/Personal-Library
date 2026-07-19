import { useEffect, useRef, useState } from 'react'
import type { DictionaryResult } from '../../types'
import { dictionaryService } from '../../services/dictionary'

interface Props {
  word: string // the selected word to define
  x: number // center-x of the selection (clientX)
  y: number // bottom of the selection (clientY)
  onClose: () => void
}

// Offline dictionary popover. Owns its own fetch + dismissal so it can outlive
// the selection popup that spawned it. Rendered by TextSelectionPopup, so every
// reader (HTML/EPUB/PDF) gets it for free.
export default function DefinitionPopover({ word, x, y, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [result, setResult] = useState<DictionaryResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    dictionaryService
      .lookup(word)
      .then((r) => {
        if (live) setResult(r)
      })
      .catch(() => {
        if (live) setResult({ word, found: false, entries: [] })
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [word])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [onClose])

  // Center on the selection; flip above when too close to the viewport bottom.
  const PANEL_W = 320
  const left = Math.min(Math.max(x - PANEL_W / 2, 8), window.innerWidth - PANEL_W - 8)
  const flipAbove = y + 260 > window.innerHeight && y > window.innerHeight / 2
  const top = flipAbove ? y - 24 : y + 8

  const headword = result?.found ? result.word : word

  return (
    <div
      ref={ref}
      className="definition-popover"
      style={{ left, top, transform: flipAbove ? 'translateY(-100%)' : undefined }}
      onMouseDown={(e) => e.preventDefault()}
      role="dialog"
      aria-label={`Definition of ${headword}`}
    >
      <div className="definition-popover-head">
        <span className="definition-popover-word">{headword}</span>
        <button className="definition-popover-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {loading ? (
        <p className="definition-popover-status">Looking up…</p>
      ) : result && result.found ? (
        <div className="definition-popover-body">
          {result.entries.map((entry) => (
            <div key={entry.pos} className="definition-pos-group">
              <span className="definition-pos-label">{entry.pos}</span>
              <ol className="definition-sense-list">
                {entry.senses.map((sense, i) => (
                  <li key={i} className="definition-sense">
                    <span className="definition-sense-text">{sense.definition}</span>
                    {sense.example && (
                      <span className="definition-sense-example">“{sense.example}”</span>
                    )}
                    {sense.synonyms.length > 0 && (
                      <span className="definition-sense-synonyms">
                        Synonyms: {sense.synonyms.join(', ')}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      ) : (
        <p className="definition-popover-status">No definition found for “{word}”.</p>
      )}
    </div>
  )
}
