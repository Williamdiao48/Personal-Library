import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMarkInteractions } from './useMarkInteractions'
import type { Annotation } from '../types'

// Pure DOM (jsdom): the hook binds click/contextmenu delegation listeners on a
// container and resolves the clicked <mark data-annotation-id> to an annotation.
// No window.api, no better-sqlite3 — renderer/jsdom, no ABI toggle.

const annot = (over: Partial<Annotation> = {}): Annotation =>
  ({
    id: 'a1',
    item_id: 'i1',
    type: 'note',
    chapter_index: null,
    position: 0.5,
    selected_text: 'quoted',
    context_before: null,
    context_after: null,
    note_text: 'a note',
    color: null,
    created_at: 0,
    sort_order: null,
    ...over,
  }) as Annotation

/** A container holding one `<mark>` with the given dataset. */
function containerWithMark(dataset: Record<string, string>) {
  const div = document.createElement('div')
  const mark = document.createElement('mark')
  Object.entries(dataset).forEach(([k, v]) => (mark.dataset[k] = v))
  mark.textContent = 'marked text'
  div.appendChild(mark)
  document.body.appendChild(div)
  return { div, mark }
}

function mount(el: HTMLElement, annotations: Annotation[]) {
  const setNotePopup = vi.fn()
  const setContextMenu = vi.fn()
  const ref = { current: el } as React.RefObject<HTMLElement | null>
  renderHook(() => useMarkInteractions(ref, annotations, { setNotePopup, setContextMenu }))
  return { setNotePopup, setContextMenu }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useMarkInteractions', () => {
  it('left-click on a note mark opens the note popover', () => {
    const a = annot({ id: 'a1', type: 'note', note_text: 'hello' })
    const { div, mark } = containerWithMark({ annotationId: 'a1', type: 'note' })
    const { setNotePopup, setContextMenu } = mount(div, [a])

    mark.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(setNotePopup).toHaveBeenCalledTimes(1)
    expect(setNotePopup.mock.calls[0][0]).toMatchObject({ annotation: a })
    expect(setContextMenu).not.toHaveBeenCalled()
  })

  it('left-click ignores highlight marks (only notes get a popover)', () => {
    const a = annot({ id: 'a1', type: 'highlight', note_text: null })
    const { div, mark } = containerWithMark({ annotationId: 'a1', type: 'highlight' })
    const { setNotePopup } = mount(div, [a])

    mark.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(setNotePopup).not.toHaveBeenCalled()
  })

  it('right-click on any mark opens the context menu and clears the popover', () => {
    const a = annot({ id: 'a1', type: 'highlight' })
    const { div, mark } = containerWithMark({ annotationId: 'a1', type: 'highlight' })
    const { setNotePopup, setContextMenu } = mount(div, [a])

    const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    mark.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
    expect(setContextMenu).toHaveBeenCalledTimes(1)
    expect(setContextMenu.mock.calls[0][0]).toMatchObject({ annotation: a })
    expect(setNotePopup).toHaveBeenCalledWith(null)
  })

  it('clicking outside any mark is a no-op', () => {
    const a = annot({ id: 'a1' })
    const { div } = containerWithMark({ annotationId: 'a1', type: 'note' })
    const { setNotePopup, setContextMenu } = mount(div, [a])

    div.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(setNotePopup).not.toHaveBeenCalled()
    expect(setContextMenu).not.toHaveBeenCalled()
  })

  it('removes its listeners on unmount', () => {
    const a = annot({ id: 'a1', type: 'note', note_text: 'hi' })
    const { div, mark } = containerWithMark({ annotationId: 'a1', type: 'note' })
    const setNotePopup = vi.fn()
    const setContextMenu = vi.fn()
    const ref = { current: div } as React.RefObject<HTMLElement | null>
    const { unmount } = renderHook(() =>
      useMarkInteractions(ref, [a], { setNotePopup, setContextMenu }),
    )
    unmount()
    mark.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(setNotePopup).not.toHaveBeenCalled()
  })
})
