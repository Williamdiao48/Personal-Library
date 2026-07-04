import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAnnotations, clearAnnotationMarks } from './useAnnotations'
import type { Annotation } from '../types'

vi.mock('../services/annotationsService', () => ({
  annotationsService: {
    getForItem: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    updateNote: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    swapSortOrder: vi.fn().mockResolvedValue(undefined),
  },
}))
import { annotationsService } from '../services/annotationsService'

const svc = annotationsService as unknown as Record<string, ReturnType<typeof vi.fn>>

function ann(over: Partial<Annotation>): Annotation {
  return {
    id: 'x',
    item_id: 'item1',
    type: 'note',
    chapter_index: 0,
    position: 0,
    selected_text: null,
    context_before: null,
    context_after: null,
    note_text: null,
    created_at: 0,
    sort_order: null,
    ...over,
  } as Annotation
}

function setup(initial: Annotation[] = []) {
  svc.getForItem.mockResolvedValue(initial)
  const ref = { current: document.createElement('div') }
  return renderHook(() => useAnnotations({ itemId: 'item1', contentRef: ref, chapterIndex: 0 }))
}

beforeEach(() => vi.clearAllMocks())

describe('useAnnotations hook', () => {
  it('loads annotations for the item on mount', async () => {
    const { result } = setup([ann({ id: 'a1' })])
    await waitFor(() => expect(result.current.annotations).toHaveLength(1))
    expect(svc.getForItem).toHaveBeenCalledWith('item1')
  })

  it('createBookmark posts the payload and appends the result', async () => {
    const { result } = setup([])
    await waitFor(() => expect(svc.getForItem).toHaveBeenCalled())
    svc.create.mockResolvedValue(ann({ id: 'bm', type: 'bookmark', position: 0.5 }))

    await act(async () => {
      await result.current.createBookmark(0.5)
    })
    expect(svc.create).toHaveBeenCalledWith(
      expect.objectContaining({
        item_id: 'item1',
        type: 'bookmark',
        position: 0.5,
        chapter_index: 0,
      }),
    )
    expect(result.current.annotations.map((a) => a.id)).toContain('bm')
  })

  it('deleteAnnotation removes it from state and calls the service', async () => {
    const { result } = setup([ann({ id: 'd1' }), ann({ id: 'd2' })])
    await waitFor(() => expect(result.current.annotations).toHaveLength(2))

    await act(async () => {
      await result.current.deleteAnnotation('d1')
    })
    expect(svc.delete).toHaveBeenCalledWith('d1')
    expect(result.current.annotations.map((a) => a.id)).toEqual(['d2'])
  })

  it('swapAnnotationOrder reorders optimistically and persists', async () => {
    const { result } = setup([ann({ id: 'a' }), ann({ id: 'b' })])
    await waitFor(() => expect(result.current.annotations).toHaveLength(2))

    await act(async () => {
      await result.current.swapAnnotationOrder('a', 'b')
    })
    expect(result.current.annotations.map((a) => a.id)).toEqual(['b', 'a'])
    expect(svc.swapSortOrder).toHaveBeenCalledWith('a', 'b')
  })
})

describe('clearAnnotationMarks', () => {
  it('unwraps annotation marks and preserves their text', () => {
    const container = document.createElement('div')
    container.innerHTML = 'Hello <mark data-annotation-id="a1">world</mark>!'
    clearAnnotationMarks(container)
    expect(container.querySelectorAll('mark').length).toBe(0)
    expect(container.textContent).toBe('Hello world!')
  })
})
