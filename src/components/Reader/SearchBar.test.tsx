import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SearchBar from './SearchBar'

function renderBar(over: Partial<React.ComponentProps<typeof SearchBar>> = {}) {
  const props = {
    query: '',
    onQueryChange: vi.fn(),
    matchCount: 0,
    currentMatch: 0,
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  render(<SearchBar {...props} />)
  return props
}

beforeEach(() => vi.clearAllMocks())

describe('SearchBar', () => {
  it('emits query changes', () => {
    const props = renderBar()
    fireEvent.change(screen.getByPlaceholderText('Search in content…'), {
      target: { value: 'foo' },
    })
    expect(props.onQueryChange).toHaveBeenCalledWith('foo')
  })

  it('shows the current/total count when there are matches', () => {
    renderBar({ query: 'foo', matchCount: 5, currentMatch: 2 })
    expect(screen.getByText('2 / 5')).toBeInTheDocument()
  })

  it('shows "No results" and disables nav when a query has no matches', () => {
    renderBar({ query: 'foo', matchCount: 0 })
    expect(screen.getByText('No results')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous match' })).toBeDisabled()
  })

  it('prefers the status override for the count label', () => {
    renderBar({ query: 'foo', matchCount: 0, statusOverride: 'Indexing…' })
    expect(screen.getByText('Indexing…')).toBeInTheDocument()
    expect(screen.queryByText('No results')).toBeNull()
  })

  it('navigates with Enter (next) and Shift+Enter (prev)', () => {
    const props = renderBar({ query: 'foo', matchCount: 3, currentMatch: 1 })
    const input = screen.getByPlaceholderText('Search in content…')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onNext).toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(props.onPrev).toHaveBeenCalled()
  })

  it('closes on Escape and via the close button', () => {
    const props = renderBar()
    fireEvent.keyDown(screen.getByPlaceholderText('Search in content…'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }))
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })

  it('clicking the nav arrows moves between matches', () => {
    const props = renderBar({ query: 'foo', matchCount: 3, currentMatch: 2 })
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    expect(props.onNext).toHaveBeenCalledTimes(1)
    expect(props.onPrev).toHaveBeenCalledTimes(1)
  })
})
