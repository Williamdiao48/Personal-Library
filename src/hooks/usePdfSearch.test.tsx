import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { usePdfSearch } from './usePdfSearch'

// The hook builds a plain-text page index from a PDFDocumentProxy, then does
// substring search over it. We only need the tiny duck-typed surface it touches
// (numPages + getPage → getTextContent → items[{str}]); no pdfjs, no window.api,
// no better-sqlite3 — renderer/jsdom, no ABI toggle.
function docFromPages(pages: string[]): PDFDocumentProxy {
  return {
    numPages: pages.length,
    getPage: async (i: number) => ({
      getTextContent: async () => ({
        items: pages[i - 1].split(' ').map((str) => ({ str })),
      }),
    }),
  } as unknown as PDFDocumentProxy
}

async function build(result: { current: ReturnType<typeof usePdfSearch> }, pages: string[]) {
  await act(async () => {
    await result.current.buildIndex(docFromPages(pages))
  })
}

beforeEach(() => vi.clearAllMocks())

describe('usePdfSearch — indexing', () => {
  it('builds the index and toggles the flags', async () => {
    const { result } = renderHook(() => usePdfSearch())
    expect(result.current.indexBuilt).toBe(false)
    await build(result, ['alpha', 'beta'])
    expect(result.current.indexBuilt).toBe(true)
    expect(result.current.indexing).toBe(false)
  })

  it('ignores text items that lack a str field', async () => {
    const { result } = renderHook(() => usePdfSearch())
    const doc = {
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({
          items: [{ str: 'findme' }, { type: 'beginMarkedContent' }],
        }),
      }),
    } as unknown as PDFDocumentProxy
    await act(async () => {
      await result.current.buildIndex(doc)
    })
    act(() => result.current.search('findme'))
    expect(result.current.matchCount).toBe(1)
  })

  it('is idempotent — a second buildIndex does not re-read the document', async () => {
    const getPage = vi.fn(async (i: number) => ({
      getTextContent: async () => ({ items: [{ str: `page${i}` }] }),
    }))
    const doc = { numPages: 2, getPage } as unknown as PDFDocumentProxy
    const { result } = renderHook(() => usePdfSearch())
    await act(async () => {
      await result.current.buildIndex(doc)
    })
    expect(getPage).toHaveBeenCalledTimes(2)
    await act(async () => {
      await result.current.buildIndex(doc)
    })
    expect(getPage).toHaveBeenCalledTimes(2) // guarded, not re-indexed
  })
})

describe('usePdfSearch — search', () => {
  it('finds matching pages in page order and points at the first', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['cat dog', 'bird', 'cat fish'])
    act(() => result.current.search('cat'))
    expect(result.current.matchCount).toBe(2)
    expect(result.current.currentMatch).toBe(1)
    expect(result.current.targetPage).toBe(1)
  })

  // Headline B: both the indexed text and the query are lowercased, so search
  // is case-insensitive.
  it('matches case-insensitively', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['Hello World'])
    act(() => result.current.search('HELLO'))
    expect(result.current.matchCount).toBe(1)
    expect(result.current.targetPage).toBe(1)
  })

  it('resets to zero for a blank query', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['cat'])
    act(() => result.current.search('cat'))
    act(() => result.current.search('   '))
    expect(result.current.matchCount).toBe(0)
    expect(result.current.currentMatch).toBe(0)
    expect(result.current.targetPage).toBe(0)
  })

  it('resets to zero when searching before the index is built', () => {
    const { result } = renderHook(() => usePdfSearch())
    act(() => result.current.search('anything'))
    expect(result.current.matchCount).toBe(0)
    expect(result.current.targetPage).toBe(0)
  })

  it('reports zero matches when nothing contains the query', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['abc'])
    act(() => result.current.search('zzz'))
    expect(result.current.matchCount).toBe(0)
    expect(result.current.currentMatch).toBe(0)
    expect(result.current.targetPage).toBe(0)
  })
})

describe('usePdfSearch — navigation', () => {
  it('goNext cycles through matches and wraps back to the first', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['cat', 'cat'])
    act(() => result.current.search('cat'))
    act(() => result.current.goNext())
    expect(result.current.currentMatch).toBe(2)
    expect(result.current.targetPage).toBe(2)
    act(() => result.current.goNext())
    expect(result.current.currentMatch).toBe(1) // wrapped
    expect(result.current.targetPage).toBe(1)
  })

  // Headline A: goPrev adds matches.length before the modulo so stepping back
  // from the first match wraps to the last (never a negative index).
  it('goPrev wraps from the first match to the last', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['cat', 'bird', 'cat'])
    act(() => result.current.search('cat'))
    expect(result.current.currentMatch).toBe(1)
    act(() => result.current.goPrev())
    expect(result.current.currentMatch).toBe(2) // 2 matches: pages 1 and 3
    expect(result.current.targetPage).toBe(3) // last match's page
  })

  it('goNext / goPrev are no-ops when there are no matches', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['abc'])
    act(() => result.current.search('zzz'))
    act(() => result.current.goNext())
    act(() => result.current.goPrev())
    expect(result.current.currentMatch).toBe(0)
    expect(result.current.targetPage).toBe(0)
  })
})
