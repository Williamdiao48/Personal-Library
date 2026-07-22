import { useState, useEffect, useRef } from 'react'
import type { Annotation, AnnotationTheme, HighlightColor } from '../../types'
import { HIGHLIGHT_COLORS, DEFAULT_HIGHLIGHT_COLOR } from '../../constants/highlightColors'
import { useSettingsSafe } from '../../contexts/SettingsContext'
import ThemePicker from '../Annotations/ThemePicker'

interface Props {
  x: number
  y: number
  annotation: Annotation
  onDelete: (id: string) => void
  onUpdate: (id: string, noteText: string | null) => void
  onSetColor: (id: string, color: HighlightColor) => void
  onClose: () => void
  /** Theme vocabulary + persist hook. When onSetThemes is omitted the Themes… entry is hidden. */
  allThemes?: AnnotationTheme[]
  onSetThemes?: (id: string, themes: AnnotationTheme[]) => void
  onVocabChange?: () => void
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

export default function AnnotationContextMenu({
  x,
  y,
  annotation,
  onDelete,
  onUpdate,
  onSetColor,
  onClose,
  allThemes,
  onSetThemes,
  onVocabChange,
}: Props) {
  const settings = useSettingsSafe()
  const labelsEnabled = settings.highlightLabelsEnabled
  const highlightLabels = settings.highlightLabels
  const ref = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const [themeEditing, setThemeEditing] = useState(false)
  const [editText, setEditText] = useState(annotation.note_text ?? '')
  // Local copy of the theme set for instant feedback; persisted via onSetThemes.
  const [themes, setThemes] = useState<AnnotationTheme[]>(annotation.themes ?? [])

  // Position: center on mark, prefer above, fall back to below near top
  const left = Math.min(Math.max(x - 80, 8), window.innerWidth - 176)
  const above = y - 8 >= 160
  const top = above ? y - 8 : y + 24

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editing) setEditing(false)
        else if (themeEditing) setThemeEditing(false)
        else onClose()
      }
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
  }, [onClose, editing, themeEditing])

  function saveEdit() {
    const trimmed = editText.trim() || null
    onUpdate(annotation.id, trimmed)
    onClose()
  }

  return (
    <div
      ref={ref}
      className={`note-popover annot-ctx-menu${editing || themeEditing ? ' annot-ctx-editing' : ''}`}
      style={{
        left,
        top,
        transform: above ? 'translateY(-100%)' : undefined,
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {editing ? (
        <div className="annot-ctx-edit">
          {annotation.selected_text && (
            <p className="note-popover-quote" style={{ marginBottom: 8 }}>
              {truncate(annotation.selected_text, 80)}
            </p>
          )}
          <textarea
            className="annotation-note-textarea"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                saveEdit()
              }
              if (e.key === 'Escape') {
                e.stopPropagation()
                setEditing(false)
              }
            }}
            autoFocus
            rows={3}
            placeholder="Write a note…"
          />
          <div className="annotation-note-actions" style={{ marginTop: 6 }}>
            <button className="annot-save-btn" onClick={saveEdit}>
              Save
            </button>
            <button className="annot-cancel-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : themeEditing ? (
        <div className="annot-ctx-edit annot-ctx-themes">
          <p className="annot-ctx-themes-label">Themes</p>
          <ThemePicker
            value={themes}
            allThemes={allThemes ?? []}
            onVocabChange={onVocabChange}
            idSuffix={annotation.id}
            autoFocus
            onChange={(next) => {
              setThemes(next)
              onSetThemes?.(annotation.id, next)
            }}
          />
          <div className="annotation-note-actions" style={{ marginTop: 6 }}>
            <button className="annot-save-btn" onClick={() => setThemeEditing(false)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          {annotation.type === 'highlight' && (
            <>
              <div className="annot-ctx-swatches" role="group" aria-label="Highlight color">
                {HIGHLIGHT_COLORS.map(({ key, label, swatch }) => {
                  const active = (annotation.color ?? DEFAULT_HIGHLIGHT_COLOR) === key
                  const tip = labelsEnabled ? `${label}: ${highlightLabels[key]}` : label
                  return (
                    <button
                      key={key}
                      className={`annot-ctx-swatch${active ? ' active' : ''}`}
                      style={{ background: swatch }}
                      onClick={() => {
                        onSetColor(annotation.id, key)
                        onClose()
                      }}
                      title={tip}
                      aria-label={tip}
                    />
                  )
                })}
              </div>
              <div className="annot-ctx-divider" />
            </>
          )}
          {annotation.type === 'note' && (
            <button
              className="annot-ctx-btn"
              onClick={() => {
                setEditText(annotation.note_text ?? '')
                setEditing(true)
              }}
            >
              Edit note
            </button>
          )}
          {annotation.selected_text && (
            <button
              className="annot-ctx-btn"
              onClick={() => {
                navigator.clipboard.writeText(annotation.selected_text!)
                onClose()
              }}
            >
              Copy text
            </button>
          )}
          {onSetThemes && (
            <button
              className="annot-ctx-btn"
              onClick={() => {
                setThemes(annotation.themes ?? [])
                setThemeEditing(true)
              }}
            >
              Themes{themes.length > 0 ? ` (${themes.length})` : '…'}
            </button>
          )}
          {(annotation.type === 'note' || annotation.selected_text || onSetThemes) && (
            <div className="annot-ctx-divider" />
          )}
          <button
            className="annot-ctx-btn danger"
            onClick={() => {
              onDelete(annotation.id)
              onClose()
            }}
          >
            Delete
          </button>
        </>
      )}
    </div>
  )
}
