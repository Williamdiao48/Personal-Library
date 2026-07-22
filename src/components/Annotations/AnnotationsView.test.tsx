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

// Mutable so individual tests can flip the color-meaning toggle.
const settingsState = vi.hoisted(() => ({ labelsEnabled: true }))
vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    settings: {
      highlightLabels: {
        yellow: 'Key quote',
        green: 'Theme',
        blue: 'Vocabulary',
        pink: 'Question',
      },
      highlightLabelsEnabled: settingsState.labelsEnabled,
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
