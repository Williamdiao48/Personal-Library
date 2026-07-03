import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StarRating from './StarRating'

describe('StarRating', () => {
  it('renders five stars with half-step rating buttons when editable', () => {
    render(<StarRating value={0} onChange={() => {}} />)
    // 5 stars × 2 halves = 10 buttons.
    expect(screen.getAllByRole('button')).toHaveLength(10)
    expect(screen.getByLabelText('Rate 3.5 stars')).toBeInTheDocument()
    expect(screen.getByLabelText('Rate 5 stars')).toBeInTheDocument()
  })

  it('calls onChange with the clicked whole-star value', async () => {
    const onChange = vi.fn()
    render(<StarRating value={0} onChange={onChange} />)
    await userEvent.click(screen.getByLabelText('Rate 4 stars'))
    expect(onChange).toHaveBeenCalledWith(4)
  })

  it('calls onChange with a half-star value', async () => {
    const onChange = vi.fn()
    render(<StarRating value={0} onChange={onChange} />)
    await userEvent.click(screen.getByLabelText('Rate 3.5 stars'))
    expect(onChange).toHaveBeenCalledWith(3.5)
  })

  it('toggles the rating off (null) when clicking the current value', async () => {
    const onChange = vi.fn()
    render(<StarRating value={4} onChange={onChange} />)
    await userEvent.click(screen.getByLabelText('Rate 4 stars'))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('renders read-only (no buttons) when onChange is omitted', () => {
    render(<StarRating value={3} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('fills the correct number of stars for the value', () => {
    const { container } = render(<StarRating value={3} />)
    // 3 full stars → 3 filled paths (no half at value=3).
    expect(container.querySelectorAll('.star-path-filled')).toHaveLength(3)
  })
})
