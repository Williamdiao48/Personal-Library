import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTextHighlight } from './useTextHighlight'

// The hook wraps matching text nodes inside containerRef in <mark> elements via
// a TreeWalker. jsdom implements everything it needs (TreeWalker, fragments,
// closest, normalize, classList) except scrollIntoView, which we stub. Pure DOM;
// no window.api, no better-sqlite3 — renderer/jsdom, no ABI toggle.

function container(html: string): HTMLDivElement {
  const div = document.createElement('div')
  div.innerHTML = html
  document.body.appendChild(div)
  return div
}

type Props = { q: string; k?: string | number }

function mount(
  el: HTMLElement,
  query: string,
  onActivate?: (m: HTMLElement) => void,
  key?: string | number,
) {
  const ref = { current: el } as React.RefObject<HTMLElement | null>
  return renderHook(({ q, k }: Props) => useTextHighlight(ref, q, k, onActivate), {
    initialProps: { q: query, k: key } as Props,
  })
}

const marks = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('mark.search-mark'))
const active = (el: HTMLElement) => el.querySelectorAll('.search-mark-active')

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('useTextHighlight — highlighting', () => {
  it('wraps every occurrence in <mark> and reports the count', () => {
    const el = container('<p>foo bar foo</p>')
    const { result } = mount(el, 'foo')
    expect(result.current.matchCount).toBe(2)
    expect(result.current.currentMatch).toBe(1)
    expect(marks(el)).toHaveLength(2)
    expect(el.textContent).toBe('foo bar foo') // original text preserved
  })

  it('matches case-insensitively', () => {
    const el = container('<p>Hello HELLO hello</p>')
    const { result } = mount(el, 'hello')
    expect(result.current.matchCount).toBe(3)
  })

  it('activates only the first mark on a fresh highlight', () => {
    const el = container('<p>foo foo</p>')
    mount(el, 'foo')
    const m = marks(el)
    expect(m[0].classList.contains('search-mark-active')).toBe(true)
    expect(m[1].classList.contains('search-mark-active')).toBe(false)
  })

  it('excludes script and style text', () => {
    const el = container('<script>foo</script><style>foo</style><p>foo</p>')
    const { result } = mount(el, 'foo')
    expect(result.current.matchCount).toBe(1)
  })

  // Headline A: UI chrome (nav/select/option/button) is skipped so its text is
  // never highlighted — those matches aren't scrollable/navigable in the reader.
  it('skips nav/select/option/button chrome', () => {
    const el = container('<button>foo</button><nav>foo</nav><p>foo</p>')
    const { result } = mount(el, 'foo')
    expect(result.current.matchCount).toBe(1) // only the <p>
  })

  it('clears marks and resets the count for a blank query', () => {
    const el = container('<p>foo</p>')
    const { result, rerender } = mount(el, 'foo')
    expect(result.current.matchCount).toBe(1)
    act(() => rerender({ q: '   ' }))
    expect(result.current.matchCount).toBe(0)
    expect(marks(el)).toHaveLength(0)
    expect(el.textContent).toBe('foo')
  })

  it('re-highlights when the query changes, dropping the old marks', () => {
    const el = container('<p>foo bar</p>')
    const { result, rerender } = mount(el, 'foo')
    act(() => rerender({ q: 'bar' }))
    expect(result.current.matchCount).toBe(1)
    expect(marks(el)).toHaveLength(1)
    expect(marks(el)[0].textContent).toBe('bar')
    expect(el.textContent).toBe('foo bar')
  })

  it('re-applies highlights when contentKey changes (new chapter innerHTML)', () => {
    const el = container('<p>foo</p>')
    const { result, rerender } = mount(el, 'foo', undefined, 1)
    expect(result.current.matchCount).toBe(1)
    el.innerHTML = '<p>foo foo</p>' // reader swapped in a new chapter
    act(() => rerender({ q: 'foo', k: 2 }))
    expect(result.current.matchCount).toBe(2)
  })

  it('clears marks on unmount', () => {
    const el = container('<p>foo</p>')
    const { unmount } = mount(el, 'foo')
    expect(marks(el)).toHaveLength(1)
    unmount()
    expect(marks(el)).toHaveLength(0)
    expect(el.textContent).toBe('foo')
  })
})

describe('useTextHighlight — navigation', () => {
  it('goNext cycles forward and wraps back to the first', () => {
    const el = container('<p>foo foo foo</p>')
    const { result } = mount(el, 'foo')
    act(() => result.current.goNext())
    expect(result.current.currentMatch).toBe(2)
    act(() => result.current.goNext())
    act(() => result.current.goNext())
    expect(result.current.currentMatch).toBe(1) // wrapped
  })

  it('goPrev wraps from the first match to the last', () => {
    const el = container('<p>foo foo foo</p>')
    const { result } = mount(el, 'foo')
    act(() => result.current.goPrev())
    expect(result.current.currentMatch).toBe(3)
  })

  // Headline B: activateMark makes the active class exclusive — stepping to a new
  // match removes the active class from every other mark.
  it('keeps exactly one active mark as you navigate', () => {
    const el = container('<p>foo foo foo</p>')
    const { result } = mount(el, 'foo')
    expect(active(el)).toHaveLength(1)
    act(() => result.current.goNext())
    expect(active(el)).toHaveLength(1)
    expect(marks(el)[1].classList.contains('search-mark-active')).toBe(true)
    expect(marks(el)[0].classList.contains('search-mark-active')).toBe(false)
  })

  it('invokes onActivate with the active mark on highlight and each step', () => {
    const el = container('<p>foo foo</p>')
    const onActivate = vi.fn()
    const { result } = mount(el, 'foo', onActivate)
    expect(onActivate).toHaveBeenCalledWith(marks(el)[0])
    act(() => result.current.goNext())
    expect(onActivate).toHaveBeenLastCalledWith(marks(el)[1])
  })

  it('falls back to scrollIntoView when no onActivate is given', () => {
    const el = container('<p>foo</p>')
    mount(el, 'foo')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('goNext / goPrev are no-ops when there are no matches', () => {
    const el = container('<p>bar</p>')
    const { result } = mount(el, 'foo')
    act(() => result.current.goNext())
    act(() => result.current.goPrev())
    expect(result.current.currentMatch).toBe(0)
  })
})
