import { useState } from 'react'
import type { AnnotationTheme } from '../../types'
import { annotationThemesService } from '../../services/annotationsService'

interface Props {
  /** Currently-selected themes. */
  value: AnnotationTheme[]
  /** Called with the new theme list on every add/remove. Persistence is the caller's job. */
  onChange: (themes: AnnotationTheme[]) => void
  /** Existing theme vocabulary, for autocomplete. */
  allThemes: AnnotationTheme[]
  /** Called when a brand-new theme is created, so the parent can refresh the vocab. */
  onVocabChange?: () => void
  /** Disambiguates the <datalist> id when several pickers render at once
   *  (e.g. the note modal + a context menu, or no annotation id exists yet). */
  idSuffix?: string
  autoFocus?: boolean
}

/** Controlled chips + input to select themes. Adds create-or-reuse a theme by
 *  name to the global vocabulary, but does NOT link it to any annotation — the
 *  caller decides when/how to persist the link (via useAnnotations.setAnnotationThemes
 *  or the annotations:setThemes service). */
export default function ThemePicker({
  value,
  onChange,
  allThemes,
  onVocabChange,
  idSuffix,
  autoFocus,
}: Props) {
  const [text, setText] = useState('')
  const listId = `theme-suggestions-${idSuffix ?? 'picker'}`

  async function add(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    setText('')
    if (value.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) return
    const theme = await annotationThemesService.create(trimmed)
    onVocabChange?.()
    onChange([...value, theme])
  }

  function remove(id: string) {
    onChange(value.filter((t) => t.id !== id))
  }

  const suggestions = allThemes.filter((t) => !value.some((s) => s.id === t.id))

  return (
    <div className="theme-editor" onClick={(e) => e.stopPropagation()}>
      <div className="theme-chips">
        {value.map((t) => (
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
        list={listId}
        value={text}
        placeholder="Add theme…"
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void add(text)
          }
        }}
      />
      <datalist id={listId}>
        {suggestions.map((t) => (
          <option key={t.id} value={t.name} />
        ))}
      </datalist>
    </div>
  )
}
