import { describe, it, expect } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { RefObject } from 'react'
import { useGridColumns } from './useGridColumns'
import { fireResize } from '../../test/renderer/setup'

// A tiny harness that attaches the hook's ref to a real DOM node and renders the
// derived geometry as text, so we can drive the ResizeObserver and assert output.
function Harness() {
  const { mainRef, columnsPerRow, colWidth } = useGridColumns()
  return (
    <div ref={mainRef as RefObject<HTMLDivElement>} data-testid="grid">
      {columnsPerRow}:{colWidth}
    </div>
  )
}

/** Force jsdom's clientWidth (always 0 otherwise) for the fallback path. */
function setClientWidth(el: Element, px: number): void {
  Object.defineProperty(el, 'clientWidth', { value: px, configurable: true })
}

describe('useGridColumns', () => {
  it('starts at the 4-column / MIN_COL_WIDTH default before any measurement', () => {
    render(<Harness />)
    expect(screen.getByTestId('grid')).toHaveTextContent('4:160')
  })

  it('derives columns + exact width from the observed contentRect', () => {
    render(<Harness />)
    const el = screen.getByTestId('grid')
    // contentRect width 500 → floor((500+20)/(160+20)) = 2 cols; (500-20)/2 = 240px
    const RO = (globalThis as unknown as { ResizeObserver: { instances: any[] } }).ResizeObserver
    const inst = RO.instances.at(-1)
    act(() => {
      inst.callback([{ contentRect: { width: 500 } }], inst)
    })
    expect(el).toHaveTextContent('2:240')
  })

  it('falls back to clientWidth when the entry has no contentRect', () => {
    render(<Harness />)
    const el = screen.getByTestId('grid')
    setClientWidth(el, 900)
    // fireResize passes an empty entries array → entries[0] is undefined → clientWidth.
    // floor((900+20)/180) = 5 cols; (900 - 4*20)/5 = 164px
    act(() => fireResize(el))
    expect(el).toHaveTextContent('5:164')
  })

  it('clamps to a single column for a container narrower than one card', () => {
    render(<Harness />)
    const el = screen.getByTestId('grid')
    act(() => {
      const RO = (globalThis as unknown as { ResizeObserver: { instances: any[] } }).ResizeObserver
      const inst = RO.instances.at(-1)
      inst.callback([{ contentRect: { width: 40 } }], inst)
    })
    // floor((40+20)/180) = 0 → Math.max(1, …) = 1 column
    expect(el).toHaveTextContent('1:')
  })
})
