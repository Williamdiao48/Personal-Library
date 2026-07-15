import { useState } from 'react'
import type { Recommendation, RecommendationSource } from '../../types'

// Deterministic per-card cover color (mirrors ItemCard) for the no-cover / broken
// -image fallback.
const COVER_COLORS = [
  '#4a6fa8',
  '#7a5a9e',
  '#a05060',
  '#8a7040',
  '#3a8a6e',
  '#3a7a9e',
  '#8a5040',
  '#5a7a3a',
]
function coverColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0
  return COVER_COLORS[Math.abs(h) % COVER_COLORS.length]
}

/** Human label for the source badge. */
export function sourceLabel(source: RecommendationSource): string {
  switch (source) {
    case 'ao3':
      return 'AO3'
    case 'ffn':
      return 'FFN'
    case 'book':
      return 'Book'
  }
}

/** Chips + heading: matched taste tags when we have them, else the fic's own tags. */
export function cardChips(rec: Recommendation): { heading: string | null; chips: string[] } {
  if (rec.matchedTags.length > 0) return { heading: "Why you'll like this", chips: rec.matchedTags }
  if (rec.subjects.length > 0) return { heading: null, chips: rec.subjects.slice(0, 3) }
  return { heading: null, chips: [] }
}

interface Props {
  rec: Recommendation
  onAdd: (rec: Recommendation) => void
  onDismiss: (rec: Recommendation, reason: 'not-interested' | 'already-read') => void
  onOpen: (rec: Recommendation) => void
}

export default function RecommendationCard({ rec, onAdd, onDismiss, onOpen }: Props) {
  const [imgOk, setImgOk] = useState(true)
  const showImg = rec.coverUrl && imgOk
  const { heading, chips } = cardChips(rec)

  return (
    <div className="rec-card">
      <div
        className="rec-card-cover"
        style={!showImg ? { background: coverColor(rec.sourceId) } : undefined}
      >
        {showImg ? (
          <img src={rec.coverUrl!} alt={rec.title} loading="lazy" onError={() => setImgOk(false)} />
        ) : (
          <span>{rec.title[0]?.toUpperCase() ?? '?'}</span>
        )}
      </div>

      <div className="rec-card-body">
        <span className="rec-card-badge">{sourceLabel(rec.source)}</span>
        <div className="rec-card-title" title={rec.title}>
          {rec.title}
        </div>
        {rec.author && <div className="rec-card-author">by {rec.author}</div>}

        {rec.description && (
          <p className="rec-card-desc" title={rec.description}>
            {rec.description}
          </p>
        )}

        {chips.length > 0 && (
          <>
            {heading && <div className="rec-card-why">{heading}</div>}
            <div className="rec-card-chips">
              {chips.map((c) => (
                <span key={c} className="rec-card-chip">
                  {c}
                </span>
              ))}
            </div>
          </>
        )}

        <div className="rec-card-actions">
          <button className="rec-card-action rec-card-action--primary" onClick={() => onAdd(rec)}>
            + Add to Library
          </button>
          <button className="rec-card-action" onClick={() => onOpen(rec)}>
            Open
          </button>
          <button className="rec-card-action" onClick={() => onDismiss(rec, 'not-interested')}>
            Not interested
          </button>
          <button className="rec-card-action" onClick={() => onDismiss(rec, 'already-read')}>
            Already read
          </button>
        </div>
      </div>
    </div>
  )
}
