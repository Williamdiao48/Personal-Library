import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MultiSelect from './MultiSelect'
import type { SelectOption } from './CustomSelect'

const opts: SelectOption[] = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana', color: '#ffff00' },
  { value: 'c', label: 'Cherry' },
]

describe('MultiSelect — trigger-text state machine', () => {
  it('shows "All" when nothing is selected', () => {
    render(<MultiSelect label="Tags" options={opts} values={[]} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Tags: All' })).toBeInTheDocument()
  })

  it('shows the single option label when exactly one is selected', () => {
    render(<MultiSelect label="Tags" options={opts} values={['a']} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Tags: Apple' })).toBeInTheDocument()
  })

  it('shows "N selected" when more than one is selected', () => {
    render(<MultiSelect label="Tags" options={opts} values={['a', 'b']} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Tags: 2 selected' })).toBeInTheDocument()
  })

  it('falls back to "All" if the single selected value is unknown', () => {
    render(<MultiSelect label="Tags" options={opts} values={['gone']} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Tags: All' })).toBeInTheDocument()
  })

  it('renders the color dot when the single selected option has a color', () => {
    const { container } = render(
      <MultiSelect label="Tags" options={opts} values={['b']} onChange={() => {}} />,
    )
    expect(screen.getByRole('button', { name: 'Tags: Banana' })).toBeInTheDocument()
    expect(container.querySelector('.custom-select-trigger .custom-select-dot')).not.toBeNull()
  })
})

describe('MultiSelect — selection', () => {
  it('adds a value to the array when an option is toggled on', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MultiSelect label="Tags" options={opts} values={['a']} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Tags: Apple' }))
    await user.click(screen.getByRole('option', { name: 'Banana' }))
    expect(onChange).toHaveBeenCalledWith(['a', 'b'])
  })

  it('handles Escape on the trigger without changing selection', () => {
    const onChange = vi.fn()
    render(<MultiSelect label="Tags" options={opts} values={[]} onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Tags: All' }), { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders a click-outside backdrop while open and closes on it', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { container } = render(
      <MultiSelect label="Tags" options={opts} values={[]} onChange={onChange} />,
    )
    await user.click(screen.getByRole('button', { name: 'Tags: All' }))
    const backdrop = container.querySelector('.custom-select-backdrop') as HTMLElement
    expect(backdrop).not.toBeNull()
    fireEvent.mouseDown(backdrop)
    expect(onChange).not.toHaveBeenCalled()
  })
})
