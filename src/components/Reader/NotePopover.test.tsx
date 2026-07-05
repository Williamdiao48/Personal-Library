import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import NotePopover from './NotePopover'
import type { Annotation } from '../../types'

const annot = (over: Partial<Annotation> = {}): Annotation =>
  ({
    id: 'a1',
    item_id: 'i1',
    type: 'note',
    chapter_index: null,
    position: 0.5,
    selected_text: null,
    context_before: null,
    context_after: null,
    note_text: 'my note',
    created_at: 0,
    sort_order: null,
    ...over,
  }) as Annotation

function renderPopover(over: Partial<React.ComponentProps<typeof NotePopover>> = {}) {
  const props = { x: 200, y: 300, annotation: annot(), onClose: vi.fn(), ...over }
  render(<NotePopover {...props} />)
  return props
}

beforeEach(() => vi.clearAllMocks())

describe('NotePopover', () => {
  it('renders the note text and a truncated quote', () => {
    renderPopover({
      annotation: annot({ selected_text: 'x'.repeat(150), note_text: 'the note' }),
    })
    expect(screen.getByText('the note')).toBeInTheDocument()
    expect(screen.getByText(/…$/)).toBeInTheDocument() // quote truncated with an ellipsis
  })

  it('omits the quote when there is no selected text', () => {
    renderPopover({ annotation: annot({ selected_text: null }) })
    expect(document.querySelector('.note-popover-quote')).toBeNull()
  })

  it('closes via the close button, Escape, and outside mousedown', () => {
    const props = renderPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.mouseDown(document.body)
    expect(props.onClose).toHaveBeenCalledTimes(3)
  })

  it('does not close on mousedown inside the popover', () => {
    const props = renderPopover()
    fireEvent.mouseDown(document.querySelector('.note-popover')!)
    expect(props.onClose).not.toHaveBeenCalled()
  })
})
