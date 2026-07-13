import { useState } from 'react'
import { Combobox, ComboboxInput, ComboboxOptions, ComboboxOption } from '@headlessui/react'
import type { AnnotationTheme } from '../../types'
import { annotationThemesService } from '../../services/annotationsService'

interface Props {
  /** Currently-selected themes. */
  value: AnnotationTheme[]
  /** Called with the new theme list on every add/remove. Persistence is the caller's job. */
  onChange: (themes: AnnotationTheme[]) => void
  /** Existing theme vocabulary, shown in the dropdown. */
  allThemes: AnnotationTheme[]
  /** Called when a brand-new theme is created, so the parent can refresh the vocab. */
  onVocabChange?: () => void
  /** Disambiguates the input id when several pickers render at once
   *  (e.g. the note modal + a context menu, or no annotation id exists yet). */
  idSuffix?: string
  autoFocus?: boolean
}

/** Sentinel option meaning "create a new theme named `name`". */
type CreateOption = { create: string }
type PickedOption = AnnotationTheme | CreateOption

function isCreate(o: PickedOption): o is CreateOption {
  return (o as CreateOption).create !== undefined
}

/** Controlled chips + a real dropdown to select themes. The dropdown lists the
 *  existing global vocabulary (click to toggle), filters as you type, and offers a
 *  "Create …" row for a novel name (create-or-reuse). It does NOT link a theme to
 *  any annotation — the caller decides when/how to persist the link (via
 *  useAnnotations.setAnnotationThemes or the annotations:setThemes service). */
export default function ThemePicker({
  value,
  onChange,
  allThemes,
  onVocabChange,
  idSuffix,
  autoFocus,
}: Props) {
  const [query, setQuery] = useState('')

  const isSelected = (t: AnnotationTheme) => value.some((s) => s.id === t.id)

  const q = query.trim().toLowerCase()
  const filtered = q ? allThemes.filter((t) => t.name.toLowerCase().includes(q)) : allThemes
  const exactExists = allThemes.some((t) => t.name.toLowerCase() === q)
  const showCreate = q.length > 0 && !exactExists

  async function pick(picked: PickedOption | null) {
    setQuery('')
    if (!picked) return
    if (isCreate(picked)) {
      const name = picked.create.trim()
      if (!name) return
      // Guard against creating a name that's already selected (case-insensitive).
      if (value.some((t) => t.name.toLowerCase() === name.toLowerCase())) return
      const theme = await annotationThemesService.create(name)
      onVocabChange?.()
      onChange([...value, theme])
      return
    }
    // Existing theme: toggle in/out of the selection.
    if (isSelected(picked)) onChange(value.filter((t) => t.id !== picked.id))
    else onChange([...value, picked])
  }

  function remove(id: string) {
    onChange(value.filter((t) => t.id !== id))
  }

  const optionClass = ({ focus }: { focus: boolean }) =>
    ['custom-select-option', focus ? 'focused' : ''].filter(Boolean).join(' ')

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

      <Combobox<PickedOption | null>
        value={null}
        onChange={(o) => void pick(o)}
        immediate
        onClose={() => setQuery('')}
      >
        <ComboboxInput
          id={`theme-picker-${idSuffix ?? 'input'}`}
          className="theme-editor-input"
          placeholder="Add theme…"
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ComboboxOptions
          anchor="bottom start"
          className="custom-select-options theme-combobox-options"
        >
          {filtered.map((t) => (
            <ComboboxOption key={t.id} value={t} className={optionClass}>
              <span className="custom-select-option-label">{t.name}</span>
              {isSelected(t) && (
                <svg
                  className="custom-select-check"
                  aria-hidden="true"
                  viewBox="0 0 12 12"
                  width="12"
                  height="12"
                >
                  <path
                    d="M2 6l3 3 5-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </ComboboxOption>
          ))}

          {showCreate && (
            <ComboboxOption value={{ create: query.trim() }} className={optionClass}>
              <span className="custom-select-option-label theme-create-label">
                Create “{query.trim()}”
              </span>
            </ComboboxOption>
          )}

          {filtered.length === 0 && !showCreate && (
            <div className="custom-select-option theme-options-empty">No themes yet</div>
          )}
        </ComboboxOptions>
      </Combobox>
    </div>
  )
}
