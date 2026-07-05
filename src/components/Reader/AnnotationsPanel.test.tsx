import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import AnnotationsPanel from './AnnotationsPanel'
import type { Annotation } from '../../types'

const annot = (over: Partial<Annotation> = {}): Annotation =>
  ({
    id: 'a1',
    item_id: 'i1',
    type: 'highlight',
    chapter_index: null,
    position: 0.5,
    selected_text: null,
    context_before: null,
    context_after: null,
    note_text: null,
    created_at: 0,
    sort_order: null,
    ...over,
  }) as Annotation

function renderPanel(over: Partial<React.ComponentProps<typeof AnnotationsPanel>> = {}) {
  const props = {
    annotations: [] as Annotation[],
    contentType: 'article' as const,
    onJump: vi.fn(),
    onDelete: vi.fn(),
    onUpdateNote: vi.fn(),
    onMove: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  render(<AnnotationsPanel {...props} />)
  return props
}

beforeEach(() => vi.clearAllMocks())

describe('AnnotationsPanel', () => {
  it('shows an empty state when there are no highlights/notes', () => {
    renderPanel({ annotations: [annot({ type: 'bookmark' })] }) // bookmarks are excluded
    expect(screen.getByText(/No annotations yet/)).toBeInTheDocument()
  })

  it('renders highlight and note rows but omits bookmarks', () => {
    renderPanel({
      annotations: [
        annot({ id: 'h', type: 'highlight', selected_text: 'a quote' }),
        annot({ id: 'n', type: 'note', note_text: 'my note' }),
        annot({ id: 'b', type: 'bookmark' }),
      ],
    })
    expect(screen.getByText('a quote')).toBeInTheDocument()
    expect(screen.getByText('my note')).toBeInTheDocument()
    expect(document.querySelectorAll('.annotation-row-pos-link')).toHaveLength(2)
  })

  it('jumps and deletes via the row buttons', () => {
    const props = renderPanel({ annotations: [annot({ id: 'a1' })] })
    fireEvent.click(document.querySelector('.annotation-row-pos-link')!)
    expect(props.onJump).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete annotation' }))
    expect(props.onDelete).toHaveBeenCalledWith('a1')
  })

  it('edits a note and persists only the trimmed text', () => {
    const props = renderPanel({ annotations: [annot({ id: 'a1', type: 'note', note_text: '' })] })
    fireEvent.click(screen.getByRole('button', { name: 'Edit note' }))
    const textarea = screen.getByPlaceholderText('Add a note…')
    fireEvent.change(textarea, { target: { value: '  hello  ' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(props.onUpdateNote).toHaveBeenCalledWith('a1', 'hello')
  })

  it('clears a note to null when the edited text is blank', () => {
    const props = renderPanel({
      annotations: [annot({ id: 'a1', type: 'note', note_text: 'old' })],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Edit note' }))
    const textarea = screen.getByPlaceholderText('Add a note…')
    fireEvent.change(textarea, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onUpdateNote).toHaveBeenCalledWith('a1', null)
  })

  it('cancels an edit (Escape and Cancel button) without saving', () => {
    const props = renderPanel({
      annotations: [annot({ id: 'a1', type: 'note', note_text: 'orig' })],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Edit note' }))
    const ta = screen.getByPlaceholderText('Add a note…')
    fireEvent.change(ta, { target: { value: 'changed' } })
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Add a note…')).toBeNull()
    expect(screen.getByText('orig')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit note' }))
    fireEvent.change(screen.getByPlaceholderText('Add a note…'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('orig')).toBeInTheDocument()
    expect(props.onUpdateNote).not.toHaveBeenCalled()
  })

  it('reorders with move up/down, disabled at the ends', () => {
    const props = renderPanel({
      annotations: [annot({ id: 'a1' }), annot({ id: 'a2' }), annot({ id: 'a3' })],
    })
    const rows = [...document.querySelectorAll('.annotation-row-pos-link')].map(
      (b) => b.closest('.annotation-row') as HTMLElement,
    )
    // First row: up disabled, down moves toward the next id
    expect(within(rows[0]).getByRole('button', { name: 'Move up' })).toBeDisabled()
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Move down' }))
    expect(props.onMove).toHaveBeenCalledWith('a1', 'a2')
    // Last row: down disabled, up moves toward the previous id
    expect(within(rows[2]).getByRole('button', { name: 'Move down' })).toBeDisabled()
    fireEvent.click(within(rows[2]).getByRole('button', { name: 'Move up' }))
    expect(props.onMove).toHaveBeenCalledWith('a3', 'a2')
  })

  it('closes via the header button', () => {
    const props = renderPanel({ annotations: [annot()] })
    fireEvent.click(screen.getByRole('button', { name: 'Close annotations panel' }))
    expect(props.onClose).toHaveBeenCalled()
  })
})
