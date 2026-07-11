import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAnnotations, clearAnnotationMarks } from './useAnnotations'
import type { Annotation, AnnotationTheme } from '../types'

vi.mock('../services/annotationsService', () => ({
  annotationsService: {
    getForItem: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    updateNote: vi.fn().mockResolvedValue(undefined),
    setColor: vi.fn().mockResolvedValue(undefined),
    setThemes: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    swapSortOrder: vi.fn().mockResolvedValue(undefined),
  },
  annotationThemesService: {
    list: vi.fn().mockResolvedValue([]),
  },
}))
import { annotationsService, annotationThemesService } from '../services/annotationsService'

const svc = annotationsService as unknown as Record<string, ReturnType<typeof vi.fn>>
const themeSvc = annotationThemesService as unknown as Record<string, ReturnType<typeof vi.fn>>

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
    color: null,
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

/** Render the hook against a real jsdom container so DOM-mutating paths run. */
function setupWith(
  container: HTMLElement | null,
  initial: Annotation[] = [],
  chapterIndex: number | null = 0,
) {
  svc.getForItem.mockResolvedValue(initial)
  const ref = { current: container }
  const hook = renderHook(() => useAnnotations({ itemId: 'item1', contentRef: ref, chapterIndex }))
  return { ...hook, ref }
}

/** Build a Range spanning `substr` inside the first text node that contains it. */
function rangeInText(root: HTMLElement, substr: string): Range {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let n: Node | null
  while ((n = walker.nextNode())) {
    const t = n as Text
    const i = t.data.indexOf(substr)
    if (i !== -1) {
      const r = document.createRange()
      r.setStart(t, i)
      r.setEnd(t, i + substr.length)
      return r
    }
  }
  throw new Error(`substr not found in container: ${substr}`)
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

describe('useAnnotations — creation with anchored text', () => {
  it('createHighlight persists selected_text + context and paints a mark', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>The quick brown fox jumps over</p>'
    const { result } = setupWith(container, [])
    await waitFor(() => expect(svc.getForItem).toHaveBeenCalled())
    svc.create.mockResolvedValue(ann({ id: 'h1', type: 'highlight', selected_text: 'brown' }))

    await act(async () => {
      await result.current.createHighlight(rangeInText(container, 'brown'), 0.3)
    })

    expect(svc.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'highlight',
        selected_text: 'brown',
        context_before: 'The quick ',
        context_after: ' fox jumps over',
      }),
    )
    const mark = container.querySelector('mark[data-annotation-id="h1"]')
    expect(mark?.textContent).toBe('brown')
    expect((mark as HTMLElement).dataset.type).toBe('highlight')
  })

  it('createHighlight threads the chosen color into the payload and onto the mark', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>The quick brown fox jumps over</p>'
    const { result } = setupWith(container, [])
    await waitFor(() => expect(svc.getForItem).toHaveBeenCalled())
    svc.create.mockResolvedValue(
      ann({ id: 'h2', type: 'highlight', selected_text: 'brown', color: 'green' }),
    )

    await act(async () => {
      await result.current.createHighlight(rangeInText(container, 'brown'), 0.3, 'green')
    })

    expect(svc.create).toHaveBeenCalledWith(expect.objectContaining({ color: 'green' }))
    const mark = container.querySelector('mark[data-annotation-id="h2"]') as HTMLElement
    expect(mark.dataset.color).toBe('green')
  })

  it('createHighlight defaults to yellow when no color is passed', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>default color path here</p>'
    const { result } = setupWith(container, [])
    await waitFor(() => expect(svc.getForItem).toHaveBeenCalled())
    svc.create.mockResolvedValue(ann({ id: 'h3', type: 'highlight', selected_text: 'default' }))

    await act(async () => {
      await result.current.createHighlight(rangeInText(container, 'default'), 0.1)
    })
    expect(svc.create).toHaveBeenCalledWith(expect.objectContaining({ color: 'yellow' }))
  })

  it('createHighlight ignores an empty/whitespace selection', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>   spaces   </p>'
    const { result } = setupWith(container, [])
    await waitFor(() => expect(svc.getForItem).toHaveBeenCalled())

    await act(async () => {
      await result.current.createHighlight(rangeInText(container, '   '), 0.1)
    })
    expect(svc.create).not.toHaveBeenCalled()
    expect(container.querySelector('mark')).toBeNull()
  })

  it('createNote with a range stores the text and paints a note mark', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>anchor this note somewhere</p>'
    const { result } = setupWith(container, [])
    await waitFor(() => expect(svc.getForItem).toHaveBeenCalled())
    svc.create.mockResolvedValue(
      ann({ id: 'n1', type: 'note', selected_text: 'this note', note_text: 'hi' }),
    )

    await act(async () => {
      await result.current.createNote(0.4, 'hi', rangeInText(container, 'this note'))
    })

    expect(svc.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', selected_text: 'this note', note_text: 'hi' }),
    )
    const mark = container.querySelector('mark[data-annotation-id="n1"]')
    expect(mark?.textContent).toBe('this note')
    expect((mark as HTMLElement).dataset.type).toBe('note')
  })

  it('createNote without a range stores a null selection and paints nothing', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>body text</p>'
    const { result } = setupWith(container, [])
    await waitFor(() => expect(svc.getForItem).toHaveBeenCalled())
    svc.create.mockResolvedValue(ann({ id: 'n2', type: 'note', note_text: 'standalone' }))

    await act(async () => {
      await result.current.createNote(0.5, 'standalone')
    })
    expect(svc.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', selected_text: null, note_text: 'standalone' }),
    )
    expect(container.querySelector('mark')).toBeNull()
  })
})

describe('useAnnotations — updateNote & delete DOM cleanup', () => {
  it('updateNote patches note_text in state and calls the service', async () => {
    const { result } = setup([ann({ id: 'u1', type: 'note', note_text: 'old' })])
    await waitFor(() => expect(result.current.annotations).toHaveLength(1))

    await act(async () => {
      await result.current.updateNote('u1', 'new')
    })
    expect(svc.updateNote).toHaveBeenCalledWith('u1', 'new')
    expect(result.current.annotations[0].note_text).toBe('new')
  })

  it('setHighlightColor persists, patches state, and recolors the live mark', async () => {
    const container = document.createElement('div')
    container.innerHTML =
      'keep <mark data-annotation-id="c1" data-type="highlight">word</mark> tail'
    const { result } = setupWith(container, [
      ann({ id: 'c1', type: 'highlight', color: 'yellow', selected_text: 'word' }),
    ])
    await waitFor(() => expect(result.current.annotations).toHaveLength(1))

    await act(async () => {
      await result.current.setHighlightColor('c1', 'blue')
    })
    expect(svc.setColor).toHaveBeenCalledWith('c1', 'blue')
    expect(result.current.annotations[0].color).toBe('blue')
    const mark = container.querySelector('mark[data-annotation-id="c1"]') as HTMLElement
    expect(mark.dataset.color).toBe('blue')
  })

  it('deleteAnnotation unwraps the annotation mark from the container', async () => {
    const container = document.createElement('div')
    container.innerHTML = 'keep <mark data-annotation-id="d1">gone</mark> tail'
    const { result } = setupWith(container, [ann({ id: 'd1', type: 'highlight' })])
    await waitFor(() => expect(result.current.annotations).toHaveLength(1))

    await act(async () => {
      await result.current.deleteAnnotation('d1')
    })
    expect(svc.delete).toHaveBeenCalledWith('d1')
    expect(container.querySelector('mark')).toBeNull()
    expect(container.textContent).toBe('keep gone tail')
  })
})

describe('useAnnotations — applyHighlightsToDOM re-anchoring', () => {
  it('disambiguates duplicate text using stored context (picks the right occurrence)', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>alpha target beta target gamma</p>'
    const highlight = ann({
      id: 'ctx',
      type: 'highlight',
      chapter_index: 0,
      selected_text: 'target',
      context_before: 'beta ',
      context_after: ' gamma',
    })
    const { result } = setupWith(container, [highlight])
    await waitFor(() => expect(result.current.annotations).toHaveLength(1))

    act(() => result.current.applyHighlightsToDOM(0))

    const mark = container.querySelector('mark[data-annotation-id="ctx"]')!
    expect(mark.textContent).toBe('target')
    // The 2nd "target" is the one preceded by "beta " — verify by the text before the mark.
    const before = (mark.previousSibling as Text | null)?.data ?? ''
    expect(before).toMatch(/beta $/)
  })

  it('re-anchors a stored colored highlight with its data-color', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>find the pink needle in here</p>'
    const highlight = ann({
      id: 'clr',
      type: 'highlight',
      chapter_index: 0,
      selected_text: 'needle',
      color: 'pink',
    })
    const { result } = setupWith(container, [highlight])
    await waitFor(() => expect(result.current.annotations).toHaveLength(1))

    act(() => result.current.applyHighlightsToDOM(0))

    const mark = container.querySelector('mark[data-annotation-id="clr"]') as HTMLElement
    expect(mark.dataset.color).toBe('pink')
  })

  it('re-applying is idempotent — clears prior marks, never nests or double-wraps', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>find the needle in here</p>'
    const highlight = ann({
      id: 'idem',
      type: 'highlight',
      chapter_index: 0,
      selected_text: 'needle',
    })
    const { result } = setupWith(container, [highlight])
    await waitFor(() => expect(result.current.annotations).toHaveLength(1))

    act(() => result.current.applyHighlightsToDOM(0))
    act(() => result.current.applyHighlightsToDOM(0))

    expect(container.querySelectorAll('mark[data-annotation-id="idem"]').length).toBe(1)
    expect(container.querySelectorAll('mark mark').length).toBe(0)
  })

  it('falls back to extractContents when the range crosses element boundaries', async () => {
    const container = document.createElement('div')
    // needle "lo wor" spans the </b> boundary, so surroundContents throws.
    container.innerHTML = '<p><b>Hello</b> world</p>'
    const highlight = ann({
      id: 'cross',
      type: 'highlight',
      chapter_index: 0,
      selected_text: 'lo wor',
    })
    const { result } = setupWith(container, [highlight])
    await waitFor(() => expect(result.current.annotations).toHaveLength(1))

    act(() => result.current.applyHighlightsToDOM(0))

    const mark = container.querySelector('mark[data-annotation-id="cross"]')
    expect(mark?.textContent).toBe('lo wor')
  })

  it('leaves annotations unpainted when the stored text is not found', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>nothing matches</p>'
    const highlight = ann({ id: 'miss', type: 'highlight', chapter_index: 0, selected_text: 'zzz' })
    const { result } = setupWith(container, [highlight])
    await waitFor(() => expect(result.current.annotations).toHaveLength(1))

    act(() => result.current.applyHighlightsToDOM(0))
    expect(container.querySelector('mark')).toBeNull()
  })

  it('skips highlights from other chapters and bookmarks', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>chapter one word here</p>'
    const { result } = setupWith(container, [
      ann({ id: 'other', type: 'highlight', chapter_index: 1, selected_text: 'word' }),
      ann({ id: 'bm', type: 'bookmark', chapter_index: 0 }),
    ])
    await waitFor(() => expect(result.current.annotations).toHaveLength(2))

    act(() => result.current.applyHighlightsToDOM(0))
    expect(container.querySelector('mark')).toBeNull()
  })

  it('is a no-op when the content ref is detached', async () => {
    const { result } = setupWith(null, [
      ann({ id: 'x', type: 'highlight', chapter_index: 0, selected_text: 'x' }),
    ])
    await waitFor(() => expect(result.current.annotations).toHaveLength(1))
    expect(() => act(() => result.current.applyHighlightsToDOM(0))).not.toThrow()
  })
})

describe('useAnnotations — reloads on item change', () => {
  it('resets state and refetches when itemId changes', async () => {
    svc.getForItem
      .mockResolvedValueOnce([ann({ id: 'i1' })])
      .mockResolvedValueOnce([ann({ id: 'i2a' }), ann({ id: 'i2b' })])
    const ref = { current: document.createElement('div') }
    const { result, rerender } = renderHook(
      ({ id }) => useAnnotations({ itemId: id, contentRef: ref, chapterIndex: 0 }),
      { initialProps: { id: 'item1' } },
    )
    await waitFor(() => expect(result.current.annotations.map((a) => a.id)).toEqual(['i1']))

    rerender({ id: 'item2' })
    await waitFor(() => expect(result.current.annotations.map((a) => a.id)).toEqual(['i2a', 'i2b']))
    expect(svc.getForItem).toHaveBeenCalledWith('item2')
  })
})

describe('useAnnotations — themes at creation', () => {
  const themes: AnnotationTheme[] = [
    { id: 't1', name: 'symbolism', created_at: 0 },
    { id: 't2', name: 'time', created_at: 0 },
  ]

  it('loads the theme vocabulary on mount', async () => {
    themeSvc.list.mockResolvedValueOnce(themes)
    const { result } = setup([])
    await waitFor(() => expect(result.current.allThemes).toHaveLength(2))
    expect(themeSvc.list).toHaveBeenCalled()
    expect(result.current.allThemes.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('createNote with themes links them and merges them into state', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>body text</p>'
    const { result } = setupWith(container, [])
    await waitFor(() => expect(svc.getForItem).toHaveBeenCalled())
    svc.create.mockResolvedValue(ann({ id: 'n1', type: 'note', note_text: 'hi', themes: [] }))

    await act(async () => {
      await result.current.createNote(0.5, 'hi', undefined, themes)
    })

    expect(svc.setThemes).toHaveBeenCalledWith('n1', ['t1', 't2'])
    const created = result.current.annotations.find((a) => a.id === 'n1')
    expect(created?.themes.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('createNote without themes does not call setThemes', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>body text</p>'
    const { result } = setupWith(container, [])
    await waitFor(() => expect(svc.getForItem).toHaveBeenCalled())
    svc.create.mockResolvedValue(ann({ id: 'n2', type: 'note', note_text: 'hi', themes: [] }))

    await act(async () => {
      await result.current.createNote(0.5, 'hi')
    })
    expect(svc.setThemes).not.toHaveBeenCalled()
  })

  it('setAnnotationThemes persists the id set and patches local state', async () => {
    const { result } = setup([ann({ id: 'a1', type: 'highlight', themes: [] })])
    await waitFor(() => expect(result.current.annotations).toHaveLength(1))

    await act(async () => {
      await result.current.setAnnotationThemes('a1', themes)
    })
    expect(svc.setThemes).toHaveBeenCalledWith('a1', ['t1', 't2'])
    expect(result.current.annotations[0].themes.map((t) => t.id)).toEqual(['t1', 't2'])
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
