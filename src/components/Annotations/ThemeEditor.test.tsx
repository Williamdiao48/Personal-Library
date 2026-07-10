import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { AnnotationTheme } from '../../types'

const setThemes = vi.fn().mockResolvedValue(undefined)
const createTheme = vi.fn()

vi.mock('../../services/annotationsService', () => ({
  annotationsService: { setThemes: (id: string, ids: string[]) => setThemes(id, ids) },
  annotationThemesService: { create: (name: string) => createTheme(name) },
}))

import ThemeEditor from './ThemeEditor'

const themes: AnnotationTheme[] = [
  { id: 't1', name: 'symbolism', created_at: 0 },
  { id: 't2', name: 'time', created_at: 0 },
]

beforeEach(() => vi.clearAllMocks())

describe('ThemeEditor', () => {
  it('renders a chip per theme and removes one (persist + onChange)', async () => {
    const onChange = vi.fn()
    render(<ThemeEditor annotationId="a1" themes={themes} allThemes={themes} onChange={onChange} />)
    expect(screen.getByText('symbolism')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Remove theme symbolism'))
    expect(onChange).toHaveBeenCalledWith([themes[1]]) // symbolism dropped
    await waitFor(() => expect(setThemes).toHaveBeenCalledWith('a1', ['t2']))
  })

  it('creates + attaches a new theme on Enter', async () => {
    createTheme.mockResolvedValue({ id: 't3', name: 'imagery', created_at: 0 })
    const onChange = vi.fn()
    render(<ThemeEditor annotationId="a1" themes={themes} allThemes={themes} onChange={onChange} />)

    fireEvent.change(screen.getByPlaceholderText('Add theme…'), { target: { value: 'imagery' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Add theme…'), { key: 'Enter' })

    await waitFor(() => expect(createTheme).toHaveBeenCalledWith('imagery'))
    await waitFor(() => expect(setThemes).toHaveBeenCalledWith('a1', ['t1', 't2', 't3']))
  })

  it('ignores a duplicate theme name (case-insensitive)', async () => {
    const onChange = vi.fn()
    render(<ThemeEditor annotationId="a1" themes={themes} allThemes={themes} onChange={onChange} />)
    fireEvent.change(screen.getByPlaceholderText('Add theme…'), { target: { value: 'Symbolism' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Add theme…'), { key: 'Enter' })
    expect(createTheme).not.toHaveBeenCalled()
  })
})
