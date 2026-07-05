import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import BookmarksPanel from './BookmarksPanel'
import type { Annotation } from '../../types'

const bm = (over: Partial<Annotation> = {}): Annotation =>
  ({
    id: 'b1',
    item_id: 'i1',
    type: 'bookmark',
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

function renderPanel(over: Partial<React.ComponentProps<typeof BookmarksPanel>> = {}) {
  const props = {
    bookmarks: [] as Annotation[],
    contentType: 'article' as const,
    onJump: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  render(<BookmarksPanel {...props} />)
  return props
}

beforeEach(() => vi.clearAllMocks())

describe('BookmarksPanel', () => {
  it('shows an empty state with no bookmarks', () => {
    renderPanel()
    expect(screen.getByText('No bookmarks yet.')).toBeInTheDocument()
  })

  it('formats a PDF position as a page number', () => {
    renderPanel({ contentType: 'pdf', bookmarks: [bm({ position: 12.4 })] })
    expect(screen.getByText('Page 12')).toBeInTheDocument()
  })

  it('formats a chaptered position as "Ch. N · P%"', () => {
    renderPanel({ contentType: 'epub', bookmarks: [bm({ chapter_index: 2, position: 0.5 })] })
    expect(screen.getByText('Ch. 3 · 50%')).toBeInTheDocument()
  })

  it('formats a plain position as a percentage', () => {
    renderPanel({ bookmarks: [bm({ position: 0.25 })] })
    expect(screen.getByText('25%')).toBeInTheDocument()
  })

  it('sorts by chapter then position', () => {
    renderPanel({
      contentType: 'epub',
      bookmarks: [
        bm({ id: 'a', chapter_index: 1, position: 0.9 }),
        bm({ id: 'b', chapter_index: 0, position: 0.2 }),
        bm({ id: 'c', chapter_index: 1, position: 0.1 }),
      ],
    })
    const labels = [...document.querySelectorAll('.annotation-row-pos-link')].map(
      (b) => b.textContent,
    )
    expect(labels).toEqual(['Ch. 1 · 20%', 'Ch. 2 · 10%', 'Ch. 2 · 90%'])
  })

  it('fires jump, delete, and close callbacks', () => {
    const props = renderPanel({ bookmarks: [bm({ id: 'b1' })] })
    fireEvent.click(screen.getByText('50%'))
    expect(props.onJump).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete bookmark' }))
    expect(props.onDelete).toHaveBeenCalledWith('b1')
    fireEvent.click(screen.getByRole('button', { name: 'Close bookmarks panel' }))
    expect(props.onClose).toHaveBeenCalled()
  })
})
