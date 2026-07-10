import { useState } from 'react'
import type { AnnotationTheme } from '../../types'
import { annotationsService, annotationThemesService } from '../../services/annotationsService'

interface Props {
  annotationId: string
  themes: AnnotationTheme[]
  /** Existing theme vocabulary, for autocomplete. */
  allThemes: AnnotationTheme[]
  /** Called with the annotation's new theme list after a change is persisted. */
  onChange: (themes: AnnotationTheme[]) => void
  /** Called when a brand-new theme is created, so the parent can refresh the vocab. */
  onVocabChange?: () => void
}

/** Inline chips + input to attach/detach themes on one annotation. Persists via
 *  the service (create-or-reuse a theme by name, then replace the link set). */
export default function ThemeEditor({
  annotationId,
  themes,
  allThemes,
  onChange,
  onVocabChange,
}: Props) {
  const [text, setText] = useState('')

  async function persist(next: AnnotationTheme[]) {
    onChange(next)
    await annotationsService.setThemes(
      annotationId,
      next.map((t) => t.id),
    )
  }

  async function add(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    setText('')
    if (themes.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) return
    const theme = await annotationThemesService.create(trimmed)
    onVocabChange?.()
    await persist([...themes, theme])
  }

  function remove(id: string) {
    void persist(themes.filter((t) => t.id !== id))
  }

  const suggestions = allThemes.filter((t) => !themes.some((s) => s.id === t.id))

  return (
    <div className="theme-editor" onClick={(e) => e.stopPropagation()}>
      <div className="theme-chips">
        {themes.map((t) => (
          <span key={t.id} className="theme-chip">
            {t.name}
            <button
              type="button"
              className="theme-chip-remove"
              onClick={() => remove(t.id)}
              aria-label={`Remove theme ${t.name}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        className="theme-editor-input"
        list={`theme-suggestions-${annotationId}`}
        value={text}
        placeholder="Add theme…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void add(text)
          }
        }}
      />
      <datalist id={`theme-suggestions-${annotationId}`}>
        {suggestions.map((t) => (
          <option key={t.id} value={t.name} />
        ))}
      </datalist>
    </div>
  )
}
