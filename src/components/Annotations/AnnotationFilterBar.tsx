import type { AnnotationTheme, HighlightColor } from '../../types'
import CustomSelect from '../ui/CustomSelect'
import MultiSelect from '../ui/MultiSelect'
import { HIGHLIGHT_COLORS } from '../../constants/highlightColors'

export interface BookOption {
  id: string
  title: string
}

const DATE_OPTIONS = [
  { value: 'all', label: 'All time' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '365d', label: 'Last year' },
]

interface Props {
  query: string
  onQuery: (q: string) => void
  colorFilter: string // 'all' | HighlightColor
  onColorFilter: (c: string) => void
  themeFilter: string[] // theme ids
  onThemeFilter: (ids: string[]) => void
  allThemes: AnnotationTheme[]
  labels: Record<HighlightColor, string>
  bookFilter: string // 'all' | item_id
  onBookFilter: (id: string) => void
  books: BookOption[] // books present in the current annotation set
  dateFilter: string // 'all' | '7d' | '30d' | '365d'
  onDateFilter: (d: string) => void
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
  bookFilter,
  onBookFilter,
  books,
  dateFilter,
  onDateFilter,
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
  const bookOptions = [
    { value: 'all', label: 'All books' },
    ...books.map((b) => ({ value: b.id, label: b.title })),
  ]

  return (
    <div className="annotation-filter-bar">
      <input
        className="annotation-filter-search"
        type="search"
        value={query}
        placeholder="Search quotes & notes…"
        onChange={(e) => onQuery(e.target.value)}
      />
      <CustomSelect
        label=""
        includePlaceholder={false}
        options={colorOptions}
        value={colorFilter}
        onChange={onColorFilter}
      />
      {themeOptions.length > 0 && (
        <MultiSelect
          label=""
          emptyLabel="All themes"
          options={themeOptions}
          values={themeFilter}
          onChange={onThemeFilter}
        />
      )}
      {books.length > 1 && (
        <CustomSelect
          label=""
          includePlaceholder={false}
          options={bookOptions}
          value={bookFilter}
          onChange={onBookFilter}
        />
      )}
      <CustomSelect
        label=""
        includePlaceholder={false}
        options={DATE_OPTIONS}
        value={dateFilter}
        onChange={onDateFilter}
      />
    </div>
  )
}
