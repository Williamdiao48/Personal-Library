import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  it('lists the existing vocabulary in the dropdown and adds one on click', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ThemePicker value={[]} allThemes={themes} onChange={onChange} />)
    await user.click(screen.getByPlaceholderText('Add theme…'))
    // Both existing themes are offered without any typing.
    expect(await screen.findByRole('option', { name: 'symbolism' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'time' }))
    expect(onChange).toHaveBeenCalledWith([themes[1]])
  })

  it('toggles an already-selected theme off when picked again', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ThemePicker value={themes} allThemes={themes} onChange={onChange} />)
    await user.click(screen.getByPlaceholderText('Add theme…'))
    await user.click(screen.getByRole('option', { name: 'symbolism' }))
    expect(onChange).toHaveBeenCalledWith([themes[1]]) // symbolism removed
  })

  it('offers a Create row for a novel name and creates-or-reuses it on pick', async () => {
    createTheme.mockResolvedValue({ id: 't3', name: 'imagery', created_at: 0 })
    const onChange = vi.fn()
    const onVocabChange = vi.fn()
    const user = userEvent.setup()
    render(
      <ThemePicker
        value={themes}
        allThemes={themes}
        onChange={onChange}
        onVocabChange={onVocabChange}
      />,
    )
    await user.click(screen.getByPlaceholderText('Add theme…'))
    await user.type(screen.getByPlaceholderText('Add theme…'), 'imagery')
    await user.click(await screen.findByRole('option', { name: /Create/ }))

    await waitFor(() => expect(createTheme).toHaveBeenCalledWith('imagery'))
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith([
        ...themes,
        { id: 't3', name: 'imagery', created_at: 0 },
      ]),
    )
    expect(onVocabChange).toHaveBeenCalled()
  })

  it('shows no Create row for a name that already exists (reuse, no duplicate)', async () => {
    const user = userEvent.setup()
    render(<ThemePicker value={[]} allThemes={themes} onChange={vi.fn()} />)
    await user.click(screen.getByPlaceholderText('Add theme…'))
    await user.type(screen.getByPlaceholderText('Add theme…'), 'Symbolism')
    // The existing option is offered; no "Create" row, so no duplicate can be made.
    expect(await screen.findByRole('option', { name: 'symbolism' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull()
    expect(createTheme).not.toHaveBeenCalled()
  })
})
