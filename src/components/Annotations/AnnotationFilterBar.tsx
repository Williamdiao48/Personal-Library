import type { AnnotationTheme, HighlightColor } from '../../types'
import CustomSelect from '../ui/CustomSelect'
import MultiSelect from '../ui/MultiSelect'
import { HIGHLIGHT_COLORS } from '../../constants/highlightColors'

interface Props {
  query: string
  onQuery: (q: string) => void
  colorFilter: string // 'all' | HighlightColor
  onColorFilter: (c: string) => void
  themeFilter: string[] // theme ids
  onThemeFilter: (ids: string[]) => void
  allThemes: AnnotationTheme[]
  labels: Record<HighlightColor, string>
}

/** Search + color-category + theme filters, shared by the in-reader panel and
 *  the global Annotations hub. */
export default function AnnotationFilterBar({
  query,
  onQuery,
  colorFilter,
  onColorFilter,
  themeFilter,
  onThemeFilter,
  allThemes,
  labels,
}: Props) {
  const colorOptions = [
    { value: 'all', label: 'All colors' },
    ...HIGHLIGHT_COLORS.map((c) => ({
      value: c.key as string,
      label: labels[c.key] || c.label,
      color: c.swatch,
    })),
  ]
  const themeOptions = allThemes.map((t) => ({ value: t.id, label: t.name }))

  return (
    <div className="annotation-filter-bar">
      <input
        className="annotation-filter-search"
        type="search"
        value={query}
        placeholder="Search quotes & notes…"
        onChange={(e) => onQuery(e.target.value)}
      />
      <CustomSelect label="" options={colorOptions} value={colorFilter} onChange={onColorFilter} />
      {themeOptions.length > 0 && (
        <MultiSelect
          label=""
          options={themeOptions}
          values={themeFilter}
          onChange={onThemeFilter}
        />
      )}
    </div>
  )
}
