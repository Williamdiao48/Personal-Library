import { useState } from 'react'
import type { Item } from '../../types'
import { libraryService } from '../../services/library'
import StarRating from '../ui/StarRating'

interface Props {
  item: Item
  onClose: () => void
  onSave: (review: string | null, rating: number | null) => void
}

export default function ReviewModal({ item, onClose, onSave }: Props) {
  const [editing, setEditing] = useState(!item.review)
  const [text, setText] = useState(item.review ?? '')
  const [rating, setRating] = useState<number | null>(item.rating ?? null)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    const trimmed = text.trim() || null
    await Promise.all([
      libraryService.setReview(item.id, trimmed),
      libraryService.setRating(item.id, rating),
    ])
    onSave(trimmed, rating)
    if (trimmed) setEditing(false)
    else onClose()
    setSaving(false)
  }

  function cancel() {
    if (item.review) {
      setText(item.review)
      setRating(item.rating ?? null)
      setEditing(false)
    } else {
      onClose()
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal review-modal" onClick={(e) => e.stopPropagation()}>
        <div className="review-modal-header">
          <div className="review-modal-header-row">
            <div>
              <h2>Review</h2>
              <p className="review-modal-subtitle">{item.title}</p>
              {!editing && rating != null && (
                <div className="review-modal-stars">
                  <StarRating value={rating} size={16} />
                </div>
              )}
            </div>
            {!editing && (
              <button
                className="review-modal-edit-btn"
                onClick={() => setEditing(true)}
                title="Edit review"
              >
                <svg
                  viewBox="0 0 12 12"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M8.5 1.5l2 2-6 6H2.5v-2l6-6z" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {editing ? (
          <>
            <div className="review-modal-edit-stars">
              <span className="review-modal-edit-stars-label">Rating</span>
              <StarRating value={rating} onChange={setRating} size={18} />
            </div>
            <textarea
              className="review-modal-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Write your thoughts…"
              autoFocus
            />
            <div className="modal-actions">
              <button onClick={cancel} disabled={saving}>
                Cancel
              </button>
              <button className="btn-primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="review-modal-body">{item.review}</p>
            <div className="modal-actions">
              <button onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
