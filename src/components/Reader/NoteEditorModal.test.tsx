import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { AnnotationTheme } from '../../types'

// Stub ThemePicker — it pulls in the annotations services and isn't under test here.
vi.mock('../Annotations/ThemePicker', () => ({
  default: () => <div data-testid="theme-picker" />,
}))

import NoteEditorModal from './NoteEditorModal'

const baseProps = () => ({
  title: 'Add note',
  noteText: 'hello',
  onNoteTextChange: vi.fn(),
  themes: [] as AnnotationTheme[],
  onThemesChange: vi.fn(),
  allThemes: [] as AnnotationTheme[],
  onVocabChange: vi.fn(),
  onSave: vi.fn(),
  onCancel: vi.fn(),
})

beforeEach(() => vi.clearAllMocks())

describe('NoteEditorModal', () => {
  it('renders the title and current note text', () => {
    render(<NoteEditorModal {...baseProps()} title="Edit note" />)
    expect(screen.getByText('Edit note')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Write a note…')).toHaveValue('hello')
  })

  it('shows the quote blockquote only when a quote is provided', () => {
    const { rerender, container } = render(<NoteEditorModal {...baseProps()} />)
    expect(container.querySelector('.note-editor-quote')).toBeNull()

    rerender(<NoteEditorModal {...baseProps()} quote="the selected sentence" />)
    expect(container.querySelector('.note-editor-quote')).toHaveTextContent('the selected sentence')
  })

  it('reports textarea changes', () => {
    const p = baseProps()
    render(<NoteEditorModal {...p} />)
    fireEvent.change(screen.getByPlaceholderText('Write a note…'), {
      target: { value: 'updated' },
    })
    expect(p.onNoteTextChange).toHaveBeenCalledWith('updated')
  })

  it('saves on the Save button and on Enter (without Shift)', () => {
    const p = baseProps()
    render(<NoteEditorModal {...p} />)
    fireEvent.click(screen.getByText('Save'))
    expect(p.onSave).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(screen.getByPlaceholderText('Write a note…'), { key: 'Enter' })
    expect(p.onSave).toHaveBeenCalledTimes(2)
  })

  it('does NOT save on Shift+Enter (newline in the note)', () => {
    const p = baseProps()
    render(<NoteEditorModal {...p} />)
    fireEvent.keyDown(screen.getByPlaceholderText('Write a note…'), {
      key: 'Enter',
      shiftKey: true,
    })
    expect(p.onSave).not.toHaveBeenCalled()
  })

  it('cancels on the Cancel button, Escape, and overlay click', () => {
    const p = baseProps()
    const { container } = render(<NoteEditorModal {...p} />)

    fireEvent.click(screen.getByText('Cancel'))
    fireEvent.keyDown(screen.getByPlaceholderText('Write a note…'), { key: 'Escape' })
    fireEvent.click(container.querySelector('.note-editor-overlay')!)
    expect(p.onCancel).toHaveBeenCalledTimes(3)
  })

  it('a click inside the modal does not bubble to the overlay (no cancel)', () => {
    const p = baseProps()
    const { container } = render(<NoteEditorModal {...p} />)
    fireEvent.click(container.querySelector('.note-editor-modal')!)
    expect(p.onCancel).not.toHaveBeenCalled()
  })
})
