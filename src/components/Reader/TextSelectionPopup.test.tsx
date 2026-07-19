import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { createRef } from 'react'
import TextSelectionPopup from './TextSelectionPopup'
import { installMockApi } from '../../../test/renderer/mockWindowApi'

// Build a container with real text and a Range over it, and stub window.getSelection
// to return a non-collapsed selection with a non-zero bounding rect.
function stubSelection(container: HTMLElement, text = 'selected') {
  const range = document.createRange()
  range.selectNodeContents(container)
  // The component reads range.toString() to gate the single-word "Define"
  // button, so drive it from `text` rather than the container's full contents.
  range.toString = () => text
  range.getBoundingClientRect = () =>
    ({
      left: 100,
      top: 200,
      right: 200,
      bottom: 220,
      width: 100,
      height: 20,
      x: 100,
      y: 200,
    }) as DOMRect
  const sel = {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
  }
  vi.spyOn(window, 'getSelection').mockReturnValue(sel as unknown as Selection)
  return range
}

function setup(props: Partial<React.ComponentProps<typeof TextSelectionPopup>> = {}) {
  const container = document.createElement('div')
  container.textContent = 'selected text in the reader'
  document.body.appendChild(container)
  const ref = createRef<HTMLElement>()
  ;(ref as { current: HTMLElement }).current = container
  const onHighlight = vi.fn()
  const onNote = vi.fn()
  const utils = render(
    <TextSelectionPopup containerRef={ref} onHighlight={onHighlight} onNote={onNote} {...props} />,
  )
  // Spread utils first so our text container isn't shadowed by RTL's render root.
  return { ...utils, container, onHighlight, onNote }
}

// Dispatch a real bubbling mouseup with a fixed target. (fireEvent.mouseUp lets
// jsdom reset event.target to null before the component's deferred setTimeout
// reads it, so we set target explicitly here.) Then flush the deferred handler.
function mouseUpIn(container: HTMLElement) {
  const evt = new MouseEvent('mouseup', { bubbles: true })
  Object.defineProperty(evt, 'target', { value: container })
  act(() => {
    container.dispatchEvent(evt)
    vi.runOnlyPendingTimers()
  })
}

// Fire a mouseup inside the container and flush the deferred handler.
function selectAndMouseUp(container: HTMLElement) {
  stubSelection(container)
  mouseUpIn(container)
}

beforeEach(() => {
  vi.useFakeTimers()
  // DefinitionPopover (mounted when "Define" is clicked) calls window.api on mount.
  const api = installMockApi()
  api.dictionary.lookup.mockResolvedValue({ word: 'selected', found: false, entries: [] })
})
afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('TextSelectionPopup', () => {
  it('renders nothing until a selection is made', () => {
    setup()
    expect(screen.queryByText('Note')).toBeNull()
  })

  it('shows the popup and a color swatch fires onHighlight with the range and color', () => {
    const { container, onHighlight } = setup()
    const range = stubSelection(container)
    mouseUpIn(container)
    // All four swatches render
    expect(screen.getByLabelText('Highlight yellow')).toBeInTheDocument()
    expect(screen.getByLabelText('Highlight green')).toBeInTheDocument()
    expect(screen.getByLabelText('Highlight blue')).toBeInTheDocument()
    expect(screen.getByLabelText('Highlight pink')).toBeInTheDocument()
    // Clicking a non-default swatch threads that color through
    fireEvent.click(screen.getByLabelText('Highlight green'))
    expect(onHighlight).toHaveBeenCalledWith(range, 'green')
  })

  it('Note fires with the range', () => {
    const { container, onNote } = setup()
    const range = stubSelection(container)
    mouseUpIn(container)
    fireEvent.click(screen.getByText('Note'))
    expect(onNote).toHaveBeenCalledWith(range)
  })

  it('does nothing while disabled', () => {
    const { container } = setup({ disabled: true })
    selectAndMouseUp(container)
    expect(screen.queryByText('Note')).toBeNull()
  })

  it('ignores a collapsed selection', () => {
    const { container } = setup()
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: true,
      rangeCount: 0,
      toString: () => '',
      getRangeAt: () => document.createRange(),
      removeAllRanges: vi.fn(),
    } as unknown as Selection)
    mouseUpIn(container)
    expect(screen.queryByText('Note')).toBeNull()
  })

  it('dismisses on an outside mousedown', () => {
    const { container } = setup()
    selectAndMouseUp(container)
    expect(screen.getByText('Note')).toBeInTheDocument()
    act(() => {
      fireEvent.mouseDown(document.body)
    })
    expect(screen.queryByText('Note')).toBeNull()
  })

  it('dismisses when the selection is cleared (selectionchange)', () => {
    const { container } = setup()
    selectAndMouseUp(container)
    expect(screen.getByText('Note')).toBeInTheDocument()
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: true,
    } as unknown as Selection)
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(screen.queryByText('Note')).toBeNull()
  })

  it('shows "Define" for a single-word selection and opens the definition popover', async () => {
    const { container } = setup()
    stubSelection(container, 'serendipity')
    mouseUpIn(container)
    const defineBtn = screen.getByText('Define')
    expect(defineBtn).toBeInTheDocument()
    act(() => {
      fireEvent.click(defineBtn)
    })
    // The selection popup closes and the definition dialog opens for the word.
    expect(screen.queryByText('Note')).toBeNull()
    expect(screen.getByRole('dialog', { name: /Definition of serendipity/ })).toBeInTheDocument()
    // Flush DefinitionPopover's async lookup so its state settles inside act().
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('hides "Define" for a multi-word selection', () => {
    const { container } = setup()
    stubSelection(container, 'two words')
    mouseUpIn(container)
    expect(screen.getByText('Note')).toBeInTheDocument() // popup is up
    expect(screen.queryByText('Define')).toBeNull()
  })

  it('dismisses when the clearTrigger changes', () => {
    const { container, rerender, onHighlight, onNote } = setup({ clearTrigger: 'a' })
    selectAndMouseUp(container)
    expect(screen.getByText('Note')).toBeInTheDocument()
    const ref = createRef<HTMLElement>()
    ;(ref as { current: HTMLElement }).current = container
    rerender(
      <TextSelectionPopup
        containerRef={ref}
        onHighlight={onHighlight}
        onNote={onNote}
        clearTrigger="b"
      />,
    )
    expect(screen.queryByText('Note')).toBeNull()
  })
})
