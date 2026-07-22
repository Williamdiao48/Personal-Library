import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AnnotationFilterBar from './AnnotationFilterBar'
import type { AnnotationTheme, HighlightColor } from '../../types'

const labels: Record<HighlightColor, string> = {
  yellow: 'Key quote',
  green: 'Theme / motif',
  blue: 'Vocabulary / craft',
  pink: 'Question',
}

const themes: AnnotationTheme[] = [
  { id: 't1', name: 'Isolation' } as AnnotationTheme,
  { id: 't2', name: 'Power' } as AnnotationTheme,
]

function setup(over: Partial<Parameters<typeof AnnotationFilterBar>[0]> = {}) {
  const onQuery = vi.fn()
  const onColorFilter = vi.fn()
  const onThemeFilter = vi.fn()
  const onBookFilter = vi.fn()
  const onDateFilter = vi.fn()
  render(
    <AnnotationFilterBar
      query=""
      onQuery={onQuery}
      colorFilter="all"
      onColorFilter={onColorFilter}
      themeFilter={[]}
      onThemeFilter={onThemeFilter}
      allThemes={[]}
      labels={labels}
      bookFilter="all"
      onBookFilter={onBookFilter}
      books={[]}
      dateFilter="all"
      onDateFilter={onDateFilter}
      {...over}
    />,
  )
  return { onQuery, onColorFilter, onThemeFilter, onBookFilter, onDateFilter }
}

describe('AnnotationFilterBar', () => {
  it('forwards search input to onQuery', async () => {
    const { onQuery } = setup()
    await userEvent.type(screen.getByRole('searchbox'), 'a')
    expect(onQuery).toHaveBeenCalledWith('a')
  })

  it('shows the current color filter label in the color select', () => {
    setup({ colorFilter: 'all' })
    expect(screen.getByText('All colors')).toBeInTheDocument()
  })

  it('renders color + date selects when there are no themes or books', () => {
    setup({ allThemes: [], books: [] })
    // Color + date triggers; theme MultiSelect and book select are suppressed.
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('renders the theme MultiSelect when themes exist', () => {
    setup({ allThemes: themes })
    // Color + theme + date triggers.
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('labels the empty theme filter "All themes" instead of a bare "All"', () => {
    setup({ allThemes: themes })
    expect(screen.getByText('All themes')).toBeInTheDocument()
    expect(screen.queryByText('All')).toBeNull()
  })

  it('date select drops the redundant bare "All" placeholder', async () => {
    setup()
    // Open the date dropdown; its options render into a portal.
    await userEvent.click(screen.getByText('All time'))
    expect(screen.getByText('Last 7 days')).toBeInTheDocument()
    // Only the informative "All time" remains — no bare "All" option.
    expect(screen.queryByText('All')).toBeNull()
  })

  it('shows the Book select only when more than one book is present', () => {
    setup({ books: [{ id: 'b1', title: 'Gatsby' }] })
    // One book → no book select (color + date only).
    expect(screen.getAllByRole('button')).toHaveLength(2)
    setup({
      books: [
        { id: 'b1', title: 'Gatsby' },
        { id: 'b2', title: '1984' },
      ],
    })
    // Two books adds the book select (2 from the first render + 3 here = 5).
    expect(screen.getAllByRole('button')).toHaveLength(5)
  })

  it('forwards a date-range choice to onDateFilter', async () => {
    const { onDateFilter } = setup()
    await userEvent.click(screen.getByText('All time'))
    await userEvent.click(screen.getByText('Last 7 days'))
    expect(onDateFilter).toHaveBeenCalledWith('7d')
  })
})
