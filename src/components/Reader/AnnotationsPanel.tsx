import { useState } from 'react'
import type { Annotation, ContentType } from '../../types'

interface Props {
  annotations:  Annotation[]
  contentType:  ContentType
  onJump:       (annotation: Annotation) => void
  onDelete:     (id: string) => void
  onUpdateNote: (id: string, text: string | null) => void
  onClose:      () => void
}

function formatPosition(annotation: Annotation, contentType: ContentType): string {
  if (contentType === 'pdf') {
    return `Page ${Math.round(annotation.position)}`
  }
  if (annotation.chapter_index !== null) {
    return `Ch. ${annotation.chapter_index + 1} · ${Math.round(annotation.position * 100)}%`
  }
  return `${Math.round(annotation.position * 100)}%`
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

function BookmarkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 2h10v13l-5-3-5 3V2z" stroke="currentColor" strokeWidth="1.5" fill="none"/>
    </svg>
  )
}

function HighlightIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1" y="10" width="14" height="4" rx="1" fill="currentColor" opacity="0.5"/>
      <rect x="3" y="2" width="10" height="8" rx="1" fill="currentColor"/>
    </svg>
  )
}

function NoteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 3h12v8H9l-3 3V11H2V3z" stroke="currentColor" strokeWidth="1.5" fill="none"/>
    </svg>
  )
}

interface ItemRowProps {
  annotation:   Annotation
  contentType:  ContentType
  onJump:       (a: Annotation) => void
  onDelete:     (id: string) => void
  onUpdateNote: (id: string, text: string | null) => void
}

function AnnotationRow({ annotation, contentType, onJump, onDelete, onUpdateNote }: ItemRowProps) {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(annotation.note_text ?? '')

  const saveEdit = () => {
    const trimmed = editText.trim() || null
    onUpdateNote(annotation.id, trimmed)
    setEditing(false)
  }

  const icon = annotation.type === 'bookmark'
    ? <BookmarkIcon />
    : annotation.type === 'highlight'
    ? <HighlightIcon />
    : <NoteIcon />

  return (
    <div className="annotation-row">
      <div className="annotation-row-header">
        <span className="annotation-row-icon">{icon}</span>
        <span className="annotation-row-pos">{formatPosition(annotation, contentType)}</span>
        <div className="annotation-row-actions">
          <button
            className="annot-action-btn"
            onClick={() => onJump(annotation)}
            title="Jump to"
            aria-label="Jump to annotation"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 2v12M2 8l6-6 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
          {annotation.type !== 'bookmark' && (
            <button
              className="annot-action-btn"
              onClick={() => { setEditing(e => !e); setEditText(annotation.note_text ?? '') }}
              title={editing ? 'Cancel' : 'Edit note'}
              aria-label="Edit note"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M11 2l3 3-9 9H2v-3L11 2z" stroke="currentColor" strokeWidth="1.5" fill="none"/>
              </svg>
            </button>
          )}
          <button
            className="annot-action-btn annot-delete-btn"
            onClick={() => onDelete(annotation.id)}
            title="Delete"
            aria-label="Delete annotation"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" strokeWidth="1.5"/>
              <line x1="13" y1="3" x2="3" y2="13" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
          </button>
        </div>
      </div>

      {annotation.selected_text && (
        <blockquote className="annotation-quote">
          {truncate(annotation.selected_text, 120)}
        </blockquote>
      )}

      {editing ? (
        <div className="annotation-note-editor">
          <textarea
            className="annotation-note-textarea"
            value={editText}
            onChange={e => setEditText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit() }
              if (e.key === 'Escape') { setEditing(false); setEditText(annotation.note_text ?? '') }
            }}
            autoFocus
            rows={3}
            placeholder="Add a note…"
          />
          <div className="annotation-note-actions">
            <button className="annot-save-btn" onClick={saveEdit}>Save</button>
            <button className="annot-cancel-btn" onClick={() => { setEditing(false); setEditText(annotation.note_text ?? '') }}>Cancel</button>
          </div>
        </div>
      ) : (
        annotation.note_text && (
          <p className="annotation-note-text">{truncate(annotation.note_text, 160)}</p>
        )
      )}
    </div>
  )
}

export default function AnnotationsPanel({ annotations, contentType, onJump, onDelete, onUpdateNote, onClose }: Props) {
  const isEmpty = annotations.length === 0

  // Sort: chapter_index NULLS FIRST, then position, then created_at
  const sorted = [...annotations].sort((a, b) => {
    const ca = a.chapter_index ?? -1
    const cb = b.chapter_index ?? -1
    if (ca !== cb) return ca - cb
    if (a.position !== b.position) return a.position - b.position
    return a.created_at - b.created_at
  })

  return (
    <div className="annotations-panel">
      <div className="annotations-panel-header">
        <span className="annotations-panel-title">Annotations</span>
        <button className="annot-close-btn" onClick={onClose} aria-label="Close annotations panel">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" strokeWidth="1.5"/>
            <line x1="13" y1="3" x2="3" y2="13" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
        </button>
      </div>

      <div className="annotations-panel-list">
        {isEmpty ? (
          <p className="annotations-empty">
            No annotations yet.{'\n'}Select text to highlight or add a note.
          </p>
        ) : (
          sorted.map(annotation => (
            <AnnotationRow
              key={annotation.id}
              annotation={annotation}
              contentType={contentType}
              onJump={onJump}
              onDelete={onDelete}
              onUpdateNote={onUpdateNote}
            />
          ))
        )}
      </div>
    </div>
  )
}
