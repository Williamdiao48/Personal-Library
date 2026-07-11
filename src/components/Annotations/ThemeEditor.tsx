import type { AnnotationTheme } from '../../types'
import { annotationsService } from '../../services/annotationsService'
import ThemePicker from './ThemePicker'

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

/** Attach/detach themes on one existing annotation. Wraps the controlled
 *  ThemePicker and persists the link set via the service on every change. */
export default function ThemeEditor({
  annotationId,
  themes,
  allThemes,
  onChange,
  onVocabChange,
}: Props) {
  return (
    <ThemePicker
      value={themes}
      allThemes={allThemes}
      onVocabChange={onVocabChange}
      idSuffix={annotationId}
      onChange={(next) => {
        onChange(next)
        void annotationsService.setThemes(
          annotationId,
          next.map((t) => t.id),
        )
      }}
    />
  )
}
