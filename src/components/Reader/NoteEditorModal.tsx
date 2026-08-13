import ThemePicker from '../Annotations/ThemePicker'
import type { AnnotationTheme } from '../../types'

interface NoteEditorModalProps {
  /** Header text — caller builds 'Edit note' | 'Add note' | 'Add note — Page N'. */
  title: string
  /** Selected-text quote shown above the textarea. Omit for readers with no
   *  range (PDF) or when editing an existing note → no blockquote rendered. */
  quote?: string
  noteText: string
  onNoteTextChange: (value: string) => void
  themes: AnnotationTheme[]
  onThemesChange: (themes: AnnotationTheme[]) => void
  allThemes: AnnotationTheme[]
  /** Refresh the theme vocabulary after inline edits (wired to annot.refreshThemes). */
  onVocabChange: () => void
  onSave: () => void
  onCancel: () => void
}

/**
 * The shared note-editor modal used by all three readers (HTML/EPUB/PDF).
 * Presentational only — the divergent per-reader note-editor state is read by
 * the caller, which passes in primitives (title/quote) plus the shared
 * noteText/themes state and save/cancel callbacks.
 */
export default function NoteEditorModal({
  title,
  quote,
  noteText,
  onNoteTextChange,
  themes,
  onThemesChange,
  allThemes,
  onVocabChange,
  onSave,
  onCancel,
}: NoteEditorModalProps) {
  return (
    <div className="note-editor-overlay" onClick={onCancel}>
      <div className="note-editor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="note-editor-header">{title}</div>
        {quote && <blockquote className="note-editor-quote">{quote}</blockquote>}
        <textarea
          className="note-editor-textarea"
          value={noteText}
          onChange={(e) => onNoteTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSave()
            }
            if (e.key === 'Escape') {
              onCancel()
            }
          }}
          autoFocus
          rows={4}
          placeholder="Write a note…"
        />
        <div className="note-editor-themes">
          <label className="note-editor-themes-label">Themes</label>
          <ThemePicker
            value={themes}
            onChange={onThemesChange}
            allThemes={allThemes}
            onVocabChange={onVocabChange}
            idSuffix="note"
          />
        </div>
        <div className="note-editor-actions">
          <button className="annot-save-btn" onClick={onSave}>
            Save
          </button>
          <button className="annot-cancel-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
