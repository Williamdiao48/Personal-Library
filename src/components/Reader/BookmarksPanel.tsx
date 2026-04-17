import type { Annotation, ContentType } from '../../types'

interface Props {
  bookmarks:   Annotation[]
  contentType: ContentType
  onJump:      (annotation: Annotation) => void
  onDelete:    (id: string) => void
  onMove:      (id1: string, id2: string) => void
  onClose:     () => void
}

function formatPosition(annotation: Annotation, contentType: ContentType): string {
  if (contentType === 'pdf') return `Page ${Math.round(annotation.position)}`
  if (annotation.chapter_index !== null) return `Ch. ${annotation.chapter_index + 1} · ${Math.round(annotation.position * 100)}%`
  return `${Math.round(annotation.position * 100)}%`
}

export default function BookmarksPanel({ bookmarks, contentType, onJump, onDelete, onMove, onClose }: Props) {
  return (
    <div className="annotations-panel">
      <div className="annotations-panel-header">
        <span className="annotations-panel-title">Bookmarks</span>
        <button className="annot-close-btn" onClick={onClose} aria-label="Close bookmarks panel">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" strokeWidth="1.5"/>
            <line x1="13" y1="3" x2="3" y2="13" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
        </button>
      </div>

      <div className="annotations-panel-list">
        {bookmarks.length === 0 ? (
          <p className="annotations-empty">No bookmarks yet.</p>
        ) : (
          bookmarks.map((bm, i) => (
            <div key={bm.id} className="annotation-row">
              <div className="annotation-row-header">
                <button
                  className="annotation-row-pos annotation-row-pos-link"
                  onClick={() => onJump(bm)}
                  title="Jump to bookmark"
                >
                  {formatPosition(bm, contentType)}
                </button>
                <div className="annotation-row-actions">
                  <button
                    className="annot-action-btn"
                    onClick={() => onMove(bm.id, bookmarks[i - 1].id)}
                    disabled={i === 0}
                    title="Move up"
                    aria-label="Move up"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M8 13V3M3 8l5-5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                  </button>
                  <button
                    className="annot-action-btn"
                    onClick={() => onMove(bm.id, bookmarks[i + 1].id)}
                    disabled={i === bookmarks.length - 1}
                    title="Move down"
                    aria-label="Move down"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M8 3v10M3 8l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                  </button>
                  <button
                    className="annot-action-btn annot-delete-btn"
                    onClick={() => onDelete(bm.id)}
                    title="Delete"
                    aria-label="Delete bookmark"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" strokeWidth="1.5"/>
                      <line x1="13" y1="3" x2="3" y2="13" stroke="currentColor" strokeWidth="1.5"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
