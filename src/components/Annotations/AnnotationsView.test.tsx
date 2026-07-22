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

// Mutable so individual tests can flip the color-meaning toggle + sort/group.
const settingsState = vi.hoisted(() => ({
  labelsEnabled: true,
  sortBy: 'title' as string,
  groupBy: 'book' as string,
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
      annotationGroupBy: settingsState.groupBy,
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
  settingsState.groupBy = 'book'
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

  it('group by None renders a flat list with no book headers', async () => {
    settingsState.groupBy = 'none'
    const { container } = renderView()
    await waitFor(() => expect(screen.getByText('So we beat on')).toBeInTheDocument())
    expect(screen.getByText('Big Brother is watching')).toBeInTheDocument()
    expect(container.querySelectorAll('.annotations-group-title')).toHaveLength(0)
    expect(screen.queryByText('Gatsby')).toBeNull()
  })

  it('group by Type buckets highlights and notes under labeled headers', async () => {
    settingsState.groupBy = 'type'
    getAll.mockResolvedValue([
      ann({ id: 'h1', type: 'highlight', selected_text: 'a highlight' }),
      ann({ id: 'n1', type: 'note', color: null, note_text: 'a note', selected_text: null }),
    ])
    renderView()
    await waitFor(() => expect(screen.getByText('a highlight')).toBeInTheDocument())
    expect(screen.getByText('Highlights')).toBeInTheDocument()
    expect(screen.getByText('Notes')).toBeInTheDocument()
  })

  it('group by Color orders sections in palette order with headers', async () => {
    settingsState.groupBy = 'color'
    getAll.mockResolvedValue([
      ann({ id: 'c1', color: 'blue', selected_text: 'blue one' }),
      ann({ id: 'c2', color: 'yellow', selected_text: 'yellow one' }),
    ])
    const { container } = renderView()
    await waitFor(() => expect(screen.getByText('blue one')).toBeInTheDocument())
    const headers = [...container.querySelectorAll('.annotations-group-title')].map(
      (h) => h.textContent,
    )
    // Yellow ("Key quote") before Blue ("Vocabulary") per palette order.
    expect(headers).toEqual(['Key quote', 'Vocabulary'])
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

  it('labels the Sort control for book sections when grouped by book', async () => {
    renderView() // default: group by book, sort 'title'
    await waitFor(() => expect(screen.getByText('So we beat on')).toBeInTheDocument())
    expect(screen.getByText('Sort: A–Z')).toBeInTheDocument()
  })

  it('labels the Sort control for annotations when not grouped by book', async () => {
    settingsState.groupBy = 'none'
    renderView()
    await waitFor(() => expect(screen.getByText('So we beat on')).toBeInTheDocument())
    expect(screen.getByText('Sort: Book A–Z')).toBeInTheDocument()
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
