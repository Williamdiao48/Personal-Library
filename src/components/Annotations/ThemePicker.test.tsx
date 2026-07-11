import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { AnnotationTheme } from '../../types'

const createTheme = vi.fn()
const setThemes = vi.fn().mockResolvedValue(undefined)

vi.mock('../../services/annotationsService', () => ({
  annotationsService: { setThemes: (id: string, ids: string[]) => setThemes(id, ids) },
  annotationThemesService: { create: (name: string) => createTheme(name) },
}))

import ThemePicker from './ThemePicker'

const themes: AnnotationTheme[] = [
  { id: 't1', name: 'symbolism', created_at: 0 },
  { id: 't2', name: 'time', created_at: 0 },
]

beforeEach(() => vi.clearAllMocks())

describe('ThemePicker (controlled)', () => {
  it('renders a chip per selected theme', () => {
    render(<ThemePicker value={themes} allThemes={themes} onChange={vi.fn()} />)
    expect(screen.getByText('symbolism')).toBeInTheDocument()
    expect(screen.getByText('time')).toBeInTheDocument()
  })

  it('removes a theme via onChange without persisting (caller owns persistence)', () => {
    const onChange = vi.fn()
    render(<ThemePicker value={themes} allThemes={themes} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Remove theme symbolism'))
    expect(onChange).toHaveBeenCalledWith([themes[1]])
    // The controlled picker never persists on its own.
    expect(setThemes).not.toHaveBeenCalled()
  })

  it('creates-or-reuses a theme on Enter and emits it via onChange + onVocabChange', async () => {
    createTheme.mockResolvedValue({ id: 't3', name: 'imagery', created_at: 0 })
    const onChange = vi.fn()
    const onVocabChange = vi.fn()
    render(
      <ThemePicker
        value={themes}
        allThemes={themes}
        onChange={onChange}
        onVocabChange={onVocabChange}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('Add theme…'), { target: { value: 'imagery' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Add theme…'), { key: 'Enter' })

    await waitFor(() => expect(createTheme).toHaveBeenCalledWith('imagery'))
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith([
        ...themes,
        { id: 't3', name: 'imagery', created_at: 0 },
      ]),
    )
    expect(onVocabChange).toHaveBeenCalled()
  })

  it('ignores a duplicate theme name (case-insensitive)', () => {
    const onChange = vi.fn()
    render(<ThemePicker value={themes} allThemes={themes} onChange={onChange} />)
    fireEvent.change(screen.getByPlaceholderText('Add theme…'), { target: { value: 'Symbolism' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Add theme…'), { key: 'Enter' })
    expect(createTheme).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('suggests only vocabulary not already selected', () => {
    const extra: AnnotationTheme = { id: 't9', name: 'motif', created_at: 0 }
    const { container } = render(
      <ThemePicker value={[themes[0]]} allThemes={[...themes, extra]} onChange={vi.fn()} />,
    )
    const options = Array.from(container.querySelectorAll('datalist option')).map(
      (o) => (o as HTMLOptionElement).value,
    )
    expect(options).toEqual(['time', 'motif']) // 'symbolism' already selected, excluded
  })
})
