import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import AnnotationContextMenu from './AnnotationContextMenu'
import type { Annotation } from '../../types'

const annot = (over: Partial<Annotation> = {}): Annotation =>
  ({
    id: 'a1',
    item_id: 'i1',
    type: 'note',
    chapter_index: null,
    position: 0.5,
    selected_text: 'quoted text',
    context_before: null,
    context_after: null,
    note_text: 'a note',
    color: null,
    created_at: 0,
    sort_order: null,
    ...over,
  }) as Annotation

function renderMenu(over: Partial<React.ComponentProps<typeof AnnotationContextMenu>> = {}) {
  const props = {
    x: 200,
    y: 300,
    annotation: annot(),
    onDelete: vi.fn(),
    onUpdate: vi.fn(),
    onSetColor: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  render(<AnnotationContextMenu {...props} />)
  return props
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn() },
    configurable: true,
  })
})

describe('AnnotationContextMenu', () => {
  it('offers Edit/Copy/Delete for a note with selected text', () => {
    renderMenu()
    expect(screen.getByRole('button', { name: 'Edit note' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy text' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('omits Edit note for a highlight and omits Copy when there is no text', () => {
    renderMenu({ annotation: annot({ type: 'highlight', note_text: null, selected_text: null }) })
    expect(screen.queryByRole('button', { name: 'Edit note' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy text' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('shows a recolor swatch row for a highlight and marks the active color', () => {
    renderMenu({ annotation: annot({ type: 'highlight', color: 'blue', note_text: null }) })
    const swatches = ['Yellow', 'Green', 'Blue', 'Pink'].map((n) =>
      screen.getByRole('button', { name: n }),
    )
    expect(swatches).toHaveLength(4)
    expect(screen.getByRole('button', { name: 'Blue' }).className).toMatch(/\bactive\b/)
  })

  it('recolors a highlight and closes when a swatch is clicked', () => {
    const props = renderMenu({
      annotation: annot({ type: 'highlight', color: 'yellow', note_text: null }),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Green' }))
    expect(props.onSetColor).toHaveBeenCalledWith('a1', 'green')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('shows no recolor swatches for a note', () => {
    renderMenu()
    expect(screen.queryByRole('button', { name: 'Green' })).toBeNull()
  })

  it('copies the selected text to the clipboard and closes', () => {
    const props = renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Copy text' }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('quoted text')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('deletes and closes', () => {
    const props = renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(props.onDelete).toHaveBeenCalledWith('a1')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('edits the note and saves the trimmed text', () => {
    const props = renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Edit note' }))
    const ta = screen.getByPlaceholderText('Write a note…')
    fireEvent.change(ta, { target: { value: '  updated  ' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(props.onUpdate).toHaveBeenCalledWith('a1', 'updated')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('Escape exits edit mode first, then closes on a second press', () => {
    const props = renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Edit note' }))
    // Escape inside the textarea only exits edit mode (stops propagation).
    fireEvent.keyDown(screen.getByPlaceholderText('Write a note…'), { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Write a note…')).toBeNull()
    expect(props.onClose).not.toHaveBeenCalled()
    // A second Escape (menu, not editing) closes.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalled()
  })

  it('closes on outside mousedown', () => {
    const props = renderMenu()
    fireEvent.mouseDown(document.body)
    expect(props.onClose).toHaveBeenCalled()
  })
})
