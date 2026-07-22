import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  AnnotationTheme,
  AnnotationWithSource,
  ExportQuoteRow,
  HighlightColor,
} from '../../types'
import { annotationsService, annotationThemesService } from '../../services/annotationsService'
import {
  useSettings,
  type AnnotationSortBy,
  type AnnotationGroupBy,
} from '../../contexts/SettingsContext'
import { DEFAULT_HIGHLIGHT_COLOR, HIGHLIGHT_COLORS } from '../../constants/highlightColors'
import AnnotationFilterBar from './AnnotationFilterBar'
import ThemeEditor from './ThemeEditor'
import {
  matchesAnnotationFilter,
  groupAnnotations,
  type AnnotationGroup,
} from './filterAnnotations'
import CustomSelect from '../ui/CustomSelect'
import '../../styles/annotations.css'

const GROUP_OPTIONS = [
  { value: 'book', label: 'Group: Book' },
  { value: 'color', label: 'Group: Color' },
  { value: 'type', label: 'Group: Type' },
  { value: 'none', label: 'Group: None' },
]

// Sort values are stable (title|newest|oldest); the labels reflect what the sort
// orders at the current grouping level — book sections vs. individual annotations.
const SORT_OPTIONS_BY_BOOK = [
  { value: 'title', label: 'Sort: A–Z' },
  { value: 'newest', label: 'Sort: Recently annotated' },
  { value: 'oldest', label: 'Sort: Oldest annotated' },
]
const SORT_OPTIONS_FLAT = [
  { value: 'title', label: 'Sort: Book A–Z' },
  { value: 'newest', label: 'Sort: Newest' },
  { value: 'oldest', label: 'Sort: Oldest' },
]

function chapterLabel(a: AnnotationWithSource): string | null {
  if (a.content_type === 'pdf') return `Page ${Math.round(a.position)}`
  if (a.chapter_index !== null) return `Ch. ${a.chapter_index + 1}`
  return null
}

/** Distinct swatch for standalone notes so they don't collide with the yellow
 *  highlight color. Notes carry no highlight color, so the bar signals "note". */
const NOTE_SWATCH = '#a78bfa' // violet

function swatchFor(a: AnnotationWithSource): string {
  if (a.type === 'note') return NOTE_SWATCH
  const key = a.color ?? DEFAULT_HIGHLIGHT_COLOR
  return HIGHLIGHT_COLORS.find((c) => c.key === key)?.swatch ?? HIGHLIGHT_COLORS[0].swatch
}

export default function AnnotationsView() {
  const navigate = useNavigate()
  const { settings, updateSettings } = useSettings()
  const labelsEnabled = settings.highlightLabelsEnabled
  const labels = settings.highlightLabels
  const groupBy = settings.annotationGroupBy
  // Coerce any stale/unknown persisted value (e.g. an old 'location') to 'title'.
  const sortBy: AnnotationSortBy =
    settings.annotationSortBy === 'newest' || settings.annotationSortBy === 'oldest'
      ? settings.annotationSortBy
      : 'title'
  const sortOptions = groupBy === 'book' ? SORT_OPTIONS_BY_BOOK : SORT_OPTIONS_FLAT
  // When meanings are off, the color filter falls back to plain color names.
  const filterLabels = labelsEnabled
    ? labels
    : (Object.fromEntries(HIGHLIGHT_COLORS.map((c) => [c.key, c.label])) as Record<
        HighlightColor,
        string
      >)

  const [annotations, setAnnotations] = useState<AnnotationWithSource[]>([])
  const [allThemes, setAllThemes] = useState<AnnotationTheme[]>([])
  const [loading, setLoading] = useState(true)

  const [query, setQuery] = useState('')
  const [colorFilter, setColorFilter] = useState('all')
  const [themeFilter, setThemeFilter] = useState<string[]>([])
  const [bookFilter, setBookFilter] = useState('all')
  const [dateFilter, setDateFilter] = useState('all')

  useEffect(() => {
    Promise.all([annotationsService.getAll(), annotationThemesService.list()]).then(
      ([anns, themes]) => {
        setAnnotations(anns)
        setAllThemes(themes)
        setLoading(false)
      },
    )
  }, [])

  const refreshThemes = () => annotationThemesService.list().then(setAllThemes)

  // Books present in the loaded set, for the Book filter dropdown (title-sorted).
  const books = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of annotations) if (!map.has(a.item_id)) map.set(a.item_id, a.item_title)
    return [...map.entries()]
      .map(([id, title]) => ({ id, title }))
      .sort((a, b) => a.title.localeCompare(b.title))
  }, [annotations])

  const filtered = useMemo(
    () =>
      annotations.filter((a) =>
        matchesAnnotationFilter(a, { query, colorFilter, themeFilter, bookFilter, dateFilter }),
      ),
    [annotations, query, colorFilter, themeFilter, bookFilter, dateFilter],
  )

  // Sort + bucket per the persisted sort/group prefs.
  const groups = useMemo(
    () => groupAnnotations(filtered, groupBy, sortBy),
    [filtered, groupBy, sortBy],
  )

  function patchThemes(id: string, themes: AnnotationTheme[]) {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, themes } : a)))
  }

  function toExportRows(rows: AnnotationWithSource[]): ExportQuoteRow[] {
    return rows.map((a) => ({
      text: a.selected_text ?? '',
      note: a.note_text,
      title: a.item_title,
      author: a.item_author,
      chapterLabel: chapterLabel(a),
      category: labelsEnabled && a.color ? labels[a.color] : null,
      themes: a.themes.map((t) => t.name),
    }))
  }

  async function exportAll(format: 'md' | 'txt') {
    if (filtered.length === 0) return
    await annotationsService.exportQuotes(toExportRows(filtered), format)
  }

  /** Header for a group, per the active grouping. `none` renders no header;
   *  `book` stays clickable (opens the book), the rest are static labels. */
  function groupHeader(g: AnnotationGroup<AnnotationWithSource>) {
    if (groupBy === 'none') return null
    if (groupBy === 'book') {
      const first = g.rows[0]
      return (
        <h2 className="annotations-group-title" onClick={() => navigate(`/read/${first.item_id}`)}>
          {first.item_title}
          {first.item_author && (
            <span className="annotations-group-author"> — {first.item_author}</span>
          )}
        </h2>
      )
    }
    if (groupBy === 'type') {
      return (
        <h2 className="annotations-group-title annotations-group-static">
          {g.key === 'highlight' ? 'Highlights' : 'Notes'}
        </h2>
      )
    }
    // color grouping
    const isNote = g.key === 'note'
    const def = HIGHLIGHT_COLORS.find((c) => c.key === g.key)
    const swatch = isNote ? NOTE_SWATCH : (def?.swatch ?? NOTE_SWATCH)
    const label = isNote
      ? 'Notes'
      : labelsEnabled
        ? labels[g.key as HighlightColor]
        : (def?.label ?? g.key)
    return (
      <h2 className="annotations-group-title annotations-group-static">
        <span
          className="annotations-group-swatch"
          style={{ background: swatch }}
          aria-hidden="true"
        />
        {label}
      </h2>
    )
  }

  return (
    <div className="annotations-view">
      <header className="annotations-view-header">
        <button className="annotations-back-btn" onClick={() => navigate('/')}>
          ← Library
        </button>
        <h1 className="annotations-view-title">Annotations</h1>
        <span className="annotations-view-count">
          {filtered.length} of {annotations.length}
        </span>
        <div className="annotations-export">
          <button
            onClick={() => exportAll('md')}
            disabled={filtered.length === 0}
            title="Export Markdown"
          >
            Export .md
          </button>
          <button
            onClick={() => exportAll('txt')}
            disabled={filtered.length === 0}
            title="Export text"
          >
            .txt
          </button>
        </div>
      </header>

      <div className="annotations-toolbar">
        <AnnotationFilterBar
          query={query}
          onQuery={setQuery}
          colorFilter={colorFilter}
          onColorFilter={setColorFilter}
          themeFilter={themeFilter}
          onThemeFilter={setThemeFilter}
          allThemes={allThemes}
          labels={filterLabels}
          bookFilter={bookFilter}
          onBookFilter={setBookFilter}
          books={books}
          dateFilter={dateFilter}
          onDateFilter={setDateFilter}
        />
        <div className="annotation-sort-bar">
          <CustomSelect
            label=""
            includePlaceholder={false}
            options={GROUP_OPTIONS}
            value={groupBy}
            onChange={(v) => updateSettings({ annotationGroupBy: v as AnnotationGroupBy })}
          />
          <CustomSelect
            label=""
            includePlaceholder={false}
            options={sortOptions}
            value={sortBy}
            onChange={(v) => updateSettings({ annotationSortBy: v as AnnotationSortBy })}
          />
        </div>
      </div>

      {loading ? (
        <p className="annotations-empty">Loading…</p>
      ) : annotations.length === 0 ? (
        <p className="annotations-empty">
          No annotations yet. Highlight passages while reading and they’ll gather here.
        </p>
      ) : filtered.length === 0 ? (
        <p className="annotations-empty">No annotations match these filters.</p>
      ) : (
        <div className="annotations-groups">
          {groups.map((g) => (
            <section key={g.key} className="annotations-group">
              {groupHeader(g)}
              {g.rows.map((a) => (
                <article key={a.id} className="quote-card">
                  <span
                    className="quote-color"
                    style={{ background: swatchFor(a) }}
                    aria-hidden="true"
                  />
                  <div className="quote-body">
                    {a.selected_text && (
                      <blockquote className="quote-text">{a.selected_text}</blockquote>
                    )}
                    {a.note_text && <p className="quote-note">{a.note_text}</p>}
                    <div className="quote-meta">
                      {a.color && labelsEnabled && (
                        <span className="quote-category">{labels[a.color]}</span>
                      )}
                      {chapterLabel(a) && <span className="quote-chapter">{chapterLabel(a)}</span>}
                    </div>
                    <ThemeEditor
                      annotationId={a.id}
                      themes={a.themes}
                      allThemes={allThemes}
                      onChange={(t) => patchThemes(a.id, t)}
                      onVocabChange={refreshThemes}
                    />
                    <div className="quote-actions">
                      <button
                        onClick={() =>
                          a.selected_text && navigator.clipboard.writeText(a.selected_text)
                        }
                        disabled={!a.selected_text}
                      >
                        Copy
                      </button>
                      <button onClick={() => navigate(`/read/${a.item_id}`)}>Open book</button>
                    </div>
                  </div>
                </article>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
