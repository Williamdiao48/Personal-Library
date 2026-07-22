import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  AnnotationTheme,
  AnnotationWithSource,
  ExportQuoteRow,
  HighlightColor,
} from '../../types'
import { annotationsService, annotationThemesService } from '../../services/annotationsService'
import { useSettings } from '../../contexts/SettingsContext'
import { DEFAULT_HIGHLIGHT_COLOR, HIGHLIGHT_COLORS } from '../../constants/highlightColors'
import AnnotationFilterBar from './AnnotationFilterBar'
import ThemeEditor from './ThemeEditor'
import { matchesAnnotationFilter } from './filterAnnotations'
import '../../styles/annotations.css'

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
  const { settings } = useSettings()
  const labelsEnabled = settings.highlightLabelsEnabled
  const labels = settings.highlightLabels
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

  const filtered = useMemo(
    () =>
      annotations.filter((a) => matchesAnnotationFilter(a, { query, colorFilter, themeFilter })),
    [annotations, query, colorFilter, themeFilter],
  )

  // Group filtered annotations by source book, preserving getAll's ordering.
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { title: string; author: string | null; rows: AnnotationWithSource[] }
    >()
    for (const a of filtered) {
      const g = map.get(a.item_id) ?? { title: a.item_title, author: a.item_author, rows: [] }
      g.rows.push(a)
      map.set(a.item_id, g)
    }
    return [...map.values()]
  }, [filtered])

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

      <AnnotationFilterBar
        query={query}
        onQuery={setQuery}
        colorFilter={colorFilter}
        onColorFilter={setColorFilter}
        themeFilter={themeFilter}
        onThemeFilter={setThemeFilter}
        allThemes={allThemes}
        labels={filterLabels}
      />

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
            <section key={g.rows[0].item_id} className="annotations-group">
              <h2
                className="annotations-group-title"
                onClick={() => navigate(`/read/${g.rows[0].item_id}`)}
              >
                {g.title}
                {g.author && <span className="annotations-group-author"> — {g.author}</span>}
              </h2>
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
