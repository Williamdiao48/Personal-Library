import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CustomSelect, { type SelectOption } from './CustomSelect'

const opts: SelectOption[] = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana', color: '#ffff00' },
]

describe('CustomSelect', () => {
  it('shows the injected placeholder as the selection when value is empty', () => {
    render(<CustomSelect label="Fruit" options={opts} value="" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Fruit: All' })).toBeInTheDocument()
  })

  it('reflects the selected option label', () => {
    render(<CustomSelect label="Fruit" options={opts} value="b" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Fruit: Banana' })).toBeInTheDocument()
  })

  it('opens and calls onChange with the picked option value', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<CustomSelect label="Fruit" options={opts} value="" onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Fruit: All' }))
    await user.click(screen.getByRole('option', { name: 'Apple' }))
    expect(onChange).toHaveBeenCalledWith('a')
  })

  it('omits the placeholder when includePlaceholder is false', async () => {
    const user = userEvent.setup()
    render(
      <CustomSelect
        label="Fruit"
        options={opts}
        value="a"
        onChange={() => {}}
        includePlaceholder={false}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Fruit: Apple' }))
    expect(screen.queryByRole('option', { name: 'All' })).toBeNull()
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('uses a custom placeholder label', () => {
    render(
      <CustomSelect label="Fruit" options={opts} value="" onChange={() => {}} placeholder="Any" />,
    )
    expect(screen.getByRole('button', { name: 'Fruit: Any' })).toBeInTheDocument()
  })

  it('handles Escape on the trigger without selecting anything', () => {
    const onChange = vi.fn()
    render(<CustomSelect label="Fruit" options={opts} value="" onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Fruit: All' }), { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders a click-outside backdrop while open and closes on it', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { container } = render(
      <CustomSelect label="Fruit" options={opts} value="" onChange={onChange} />,
    )
    await user.click(screen.getByRole('button', { name: 'Fruit: All' }))
    const backdrop = container.querySelector('.custom-select-backdrop') as HTMLElement
    expect(backdrop).not.toBeNull()
    fireEvent.mouseDown(backdrop)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders a color dot for the selected option when it has a color', () => {
    const { container } = render(
      <CustomSelect label="Fruit" options={opts} value="b" onChange={() => {}} />,
    )
    expect(container.querySelector('.custom-select-trigger .custom-select-dot')).not.toBeNull()
  })
})
