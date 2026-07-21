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
      {...over}
    />,
  )
  return { onQuery, onColorFilter, onThemeFilter }
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

  it('renders only the color select when there are no themes', () => {
    setup({ allThemes: [] })
    // Single listbox trigger (color); the theme MultiSelect is suppressed.
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('renders the theme MultiSelect when themes exist', () => {
    setup({ allThemes: themes })
    // Two listbox triggers: color + theme.
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
})
