import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import ColorInput from './ColorInput'

describe('ColorInput', () => {
  it('shows the current color on both the swatch and the native input', () => {
    const { container } = render(<ColorInput value="#ff0000" onChange={() => {}} />)
    const circle = container.querySelector('.color-input-circle') as HTMLElement
    expect(circle.style.backgroundColor).toBe('rgb(255, 0, 0)')
    const input = container.querySelector('input[type="color"]') as HTMLInputElement
    expect(input.value).toBe('#ff0000')
  })

  it('fires onChange with the picked color', () => {
    const onChange = vi.fn()
    const { container } = render(<ColorInput value="#000000" onChange={onChange} />)
    const input = container.querySelector('input[type="color"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '#00ff00' } })
    expect(onChange).toHaveBeenCalledWith('#00ff00')
  })

  it('applies the size prop to the trigger and swatch', () => {
    const { container } = render(<ColorInput value="#123456" onChange={() => {}} size={40} />)
    const trigger = container.querySelector('.color-input-trigger') as HTMLElement
    expect(trigger.style.width).toBe('40px')
    expect(trigger.style.height).toBe('40px')
  })
})
