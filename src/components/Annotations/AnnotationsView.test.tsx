import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { AnnotationWithSource } from '../../types'

const getAll = vi.fn()
const exportQuotes = vi.fn().mockResolvedValue('/tmp/out.md')
const listThemes = vi.fn().mockResolvedValue([])

vi.mock('../../services/annotationsService', () => ({
  annotationsService: {
    getAll: () => getAll(),
    exportQuotes: (rows: unknown, fmt: string) => exportQuotes(rows, fmt),
    setThemes: vi.fn().mockResolvedValue(undefined),
  },
  annotationThemesService: {
    list: () => listThemes(),
    create: vi.fn(),
  },
}))

// Mutable so individual tests can flip the color-meaning toggle + sort.
const settingsState = vi.hoisted(() => ({
  labelsEnabled: true,
  sortBy: 'title' as string,
}))
const updateSettings = vi.fn()
vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    updateSettings,
    settings: {
      highlightLabels: {
        yellow: 'Key quote',
        green: 'Theme',
        blue: 'Vocabulary',
        pink: 'Question',
      },
      highlightLabelsEnabled: settingsState.labelsEnabled,
      annotationSortBy: settingsState.sortBy,
    },
  }),
}))

import AnnotationsView from './AnnotationsView'

function ann(over: Partial<AnnotationWithSource>): AnnotationWithSource {
  return {
    id: 'a1',
    item_id: 'b1',
    type: 'highlight',
    chapter_index: 2,
    position: 0.3,
    selected_text: 'So we beat on',
    context_before: null,
    context_after: null,
    note_text: null,
    color: 'green',
    themes: [],
    book_fraction: null,
    created_at: 0,
    sort_order: null,
    item_title: 'Gatsby',
    item_author: 'Fitzgerald',
    content_type: 'epub',
    ...over,
  }
}

function renderView() {
  return render(
    <MemoryRouter>
      <AnnotationsView />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  settingsState.labelsEnabled = true
  settingsState.sortBy = 'title'
  getAll.mockResolvedValue([
    ann({ id: 'a1', selected_text: 'So we beat on', item_title: 'Gatsby' }),
    ann({ id: 'a2', selected_text: 'Big Brother is watching', item_title: '1984', item_id: 'b2' }),
  ])
})

describe('AnnotationsView', () => {
  it('loads annotations, groups by book, and shows the color category', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('So we beat on')).toBeInTheDocument())
    expect(screen.getByText('Gatsby')).toBeInTheDocument()
    expect(screen.getByText('1984')).toBeInTheDocument()
    // color category label from settings
    expect(screen.getAllByText('Theme').length).toBeGreaterThan(0)
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
  })

  it('gives a standalone note a distinct violet swatch, not the yellow default', async () => {
    getAll.mockResolvedValue([
      ann({ id: 'n1', type: 'note', color: null, note_text: 'my note', selected_text: null }),
    ])
    const { container } = renderView()
    await waitFor(() => expect(screen.getByText('my note')).toBeInTheDocument())
    const bar = container.querySelector('.quote-color') as HTMLElement
    expect(bar).toHaveStyle({ background: '#a78bfa' })
  })

  it('sort Newest ranks book sections by their most-recent annotation', async () => {
    settingsState.sortBy = 'newest'
    getAll.mockResolvedValue([
      ann({ id: 'g', item_id: 'b1', item_title: 'Gatsby', created_at: 10, selected_text: 'g' }),
      ann({ id: 'o', item_id: 'b2', item_title: '1984', created_at: 99, selected_text: 'o' }),
    ])
    const { container } = renderView()
    await waitFor(() => expect(screen.getByText('g')).toBeInTheDocument())
    const titles = [...container.querySelectorAll('.annotations-group-title')].map((h) =>
      h.textContent?.replace(/ —.*/, ''),
    )
    expect(titles).toEqual(['1984', 'Gatsby'])
  })

  it('labels the Sort control for book sections', async () => {
    renderView() // default sort 'title'
    await waitFor(() => expect(screen.getByText('So we beat on')).toBeInTheDocument())
    expect(screen.getByText('Sort: A–Z')).toBeInTheDocument()
  })

  it('hides category chips and drops export categories when meanings are disabled', async () => {
    settingsState.labelsEnabled = false
    renderView()
    await waitFor(() => expect(screen.getByText('So we beat on')).toBeInTheDocument())
    // No color-category chip renders
    expect(screen.queryByText('Theme')).toBeNull()
    // Export rows carry a null category
    fireEvent.click(screen.getByText('Export .md'))
    await waitFor(() => expect(exportQuotes).toHaveBeenCalled())
    const [rows] = exportQuotes.mock.calls[0]
    expect(rows[0]).toMatchObject({ title: 'Gatsby', category: null })
  })

  it('shows a normalized "% · native" location for chaptered and PDF annotations', async () => {
    getAll.mockResolvedValue([
      ann({
        id: 'e1',
        content_type: 'epub',
        chapter_index: 2,
        book_fraction: 0.42,
        selected_text: 'epub one',
        item_title: 'Gatsby',
      }),
      ann({
        id: 'p1',
        content_type: 'pdf',
        chapter_index: null,
        position: 12,
        book_fraction: 0.63,
        selected_text: 'pdf one',
        item_title: 'Manual',
        item_id: 'b2',
      }),
    ])
    renderView()
    await waitFor(() => expect(screen.getByText('epub one')).toBeInTheDocument())
    expect(screen.getByText('42% · Ch. 3')).toBeInTheDocument()
    expect(screen.getByText('63% · p. 12')).toBeInTheDocument()
  })

  it('falls back to the native chapter/page label when book_fraction is null', async () => {
    getAll.mockResolvedValue([
      ann({ id: 'old', chapter_index: 4, book_fraction: null, selected_text: 'legacy' }),
    ])
    renderView()
    await waitFor(() => expect(screen.getByText('legacy')).toBeInTheDocument())
    expect(screen.getByText('Ch. 5')).toBeInTheDocument()
    expect(screen.queryByText(/%/)).toBeNull()
  })

  it('filters by the search box', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('So we beat on')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Search quotes & notes…'), {
      target: { value: 'brother' },
    })
    expect(screen.queryByText('So we beat on')).toBeNull()
    expect(screen.getByText('Big Brother is watching')).toBeInTheDocument()
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
  })

  it('exports the filtered set to markdown', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('So we beat on')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Export .md'))
    await waitFor(() => expect(exportQuotes).toHaveBeenCalled())
    const [rows, fmt] = exportQuotes.mock.calls[0]
    expect(fmt).toBe('md')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ title: 'Gatsby', category: 'Theme', chapterLabel: 'Ch. 3' })
  })

  it('shows an empty state when there are no annotations', async () => {
    getAll.mockResolvedValue([])
    renderView()
    await waitFor(() => expect(screen.getByText(/No annotations yet/)).toBeInTheDocument())
  })
})
