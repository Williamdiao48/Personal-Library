import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ConvertProgress from './ConvertProgress'

function renderProgress(over: Partial<React.ComponentProps<typeof ConvertProgress>> = {}) {
  const props = { step: 'Parsing…', pct: 40, error: null, onCancel: vi.fn(), ...over }
  render(<ConvertProgress {...props} />)
  return props
}

beforeEach(() => vi.clearAllMocks())

describe('ConvertProgress', () => {
  it('shows the step and progress bar while running', () => {
    renderProgress({ step: 'Parsing…', pct: 40 })
    expect(screen.getByText('Parsing…')).toBeInTheDocument()
    expect(document.querySelector('.convert-bar-fill')).toHaveStyle({ width: '40%' })
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('shows the error and a Close button', () => {
    renderProgress({ error: 'Conversion failed', pct: 40 })
    expect(screen.getByText('Conversion failed')).toBeInTheDocument()
    expect(screen.queryByText('Parsing…')).toBeNull()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('offers "Open EPUB" and "Stay here" when done', () => {
    const onOpenEpub = vi.fn()
    const onCancel = vi.fn()
    renderProgress({ pct: 100, onOpenEpub, onCancel })
    fireEvent.click(screen.getByRole('button', { name: 'Open EPUB' }))
    expect(onOpenEpub).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Stay here' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('omits "Open EPUB" when no handler is given', () => {
    renderProgress({ pct: 100 })
    expect(screen.queryByRole('button', { name: 'Open EPUB' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Stay here' })).toBeInTheDocument()
  })

  it('cancels while running', () => {
    const { onCancel } = renderProgress({ pct: 40 })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
