import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  usePdfSearch,
  foldText,
  mulTransform,
  itemToRect,
  buildPageIndex,
  findMatchesInPage,
  type SearchTextItem,
} from './usePdfSearch'

// A scale-1 viewport transform: PDF space (y-up) → device space (y-down, top-left
// origin) for an 800pt-tall page. Matches page.getViewport({scale:1}).transform.
const VP = [1, 0, 0, -1, 0, 800]

/** Lay words out left-to-right as pdfjs-shaped text items on one baseline.
 *  Non-final words carry a trailing space (pdfjs includes inter-word spaces in
 *  the item text); the last word is flagged hasEOL. */
function itemsFromLine(words: string[], y = 700, joinSpaces = true): SearchTextItem[] {
  let x = 50
  return words.map((w, i) => {
    const isLast = i === words.length - 1
    const str = !isLast && joinSpaces ? w + ' ' : w
    const item: SearchTextItem = {
      str,
      transform: [12, 0, 0, 12, x, y],
      width: str.length * 7,
      hasEOL: isLast,
    }
    x += str.length * 7
    return item
  })
}

// The hook only touches numPages + getPage → { getViewport, getTextContent }.
// No pdfjs, no window.api, no better-sqlite3 — renderer/jsdom, no ABI toggle.
function docFromPages(pages: string[]): PDFDocumentProxy {
  return {
    numPages: pages.length,
    getPage: async (i: number) => ({
      getViewport: () => ({ transform: VP, width: 600, height: 800 }),
      getTextContent: async () => ({ items: itemsFromLine(pages[i - 1].split(' ')) }),
    }),
  } as unknown as PDFDocumentProxy
}

async function build(result: { current: ReturnType<typeof usePdfSearch> }, pages: string[]) {
  await act(async () => {
    await result.current.buildIndex(docFromPages(pages))
  })
}

beforeEach(() => vi.clearAllMocks())

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('foldText', () => {
  it('lowercases and strips diacritics', () => {
    expect(foldText('Café')).toBe('cafe')
    expect(foldText('NAÏVE')).toBe('naive')
    expect(foldText('résumé')).toBe('resume')
    expect(foldText('Hello')).toBe('hello')
  })
})

describe('mulTransform', () => {
  it('composes affine matrices like pdfjs Util.transform', () => {
    // identity × M = M
    expect(mulTransform([1, 0, 0, 1, 0, 0], [12, 0, 0, 12, 3, 4])).toEqual([12, 0, 0, 12, 3, 4])
    // viewport flip applied to a text matrix at (100,700) on an 800-tall page
    expect(mulTransform(VP, [12, 0, 0, 12, 100, 700])).toEqual([12, 0, 0, -12, 100, 100])
  })
})

describe('itemToRect', () => {
  it('derives a scale-1 top-left rect (left=tx4, top=tx5-ascent, h=fontHeight)', () => {
    const item: SearchTextItem = {
      str: 'hi',
      transform: [12, 0, 0, 12, 100, 700],
      width: 20,
      hasEOL: false,
    }
    const [x, y, w, h] = itemToRect(item, VP)
    expect(x).toBe(100)
    expect(w).toBe(20)
    expect(h).toBeCloseTo(12)
    expect(y).toBeCloseTo(100 - 12 * 0.8) // baseline 100, ascent 0.8·12
  })
})

describe('buildPageIndex', () => {
  it('folds item text, records per-item offsets, and keeps a rect per item', () => {
    const items = itemsFromLine(['Café', 'bar']) // "Café " + "bar"
    const idx = buildPageIndex(items, VP)
    expect(idx.folded.trimEnd()).toBe('cafe bar')
    expect(idx.itemStarts).toEqual([0, 5]) // "cafe " starts at 0, "bar" at 5
    expect(idx.itemLens).toEqual([5, 3])
    expect(idx.rects).toHaveLength(2)
  })

  it('inserts a space at a line break so cross-line words never merge', () => {
    const idx = buildPageIndex([...itemsFromLine(['end']), ...itemsFromLine(['start'])], VP)
    expect(idx.folded.trimEnd()).toBe('end start')
    expect(findMatchesInPage(idx, 'endstart')).toHaveLength(0)
    expect(findMatchesInPage(idx, 'end start')).toHaveLength(1)
  })
})

describe('findMatchesInPage', () => {
  it('returns one rect set per non-overlapping occurrence', () => {
    const idx = buildPageIndex(itemsFromLine(['cat', 'dog', 'cat']), VP)
    const matches = findMatchesInPage(idx, 'cat')
    expect(matches).toHaveLength(2)
    expect(matches[0]).toHaveLength(1) // one item covered
  })

  it('covers every item a match straddles (word split across items)', () => {
    // "wor" + "ld" with no spaces → folded "world"; searching "world" spans both.
    const idx = buildPageIndex(itemsFromLine(['wor', 'ld'], 700, false), VP)
    expect(idx.folded.trimEnd()).toBe('world')
    const matches = findMatchesInPage(idx, 'world')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toHaveLength(2) // both items' rects
  })

  it('narrows the rect to the matched glyphs inside a whole-line item', () => {
    // pdf.js often returns a full line as ONE item — the match must be sliced out
    // of it, not highlight the entire line.
    const lineItem: SearchTextItem = {
      str: 'the quick brown fox', // 19 chars, one item spanning the line
      transform: [12, 0, 0, 12, 100, 700],
      width: 190, // 10px per char
      hasEOL: true,
    }
    const idx = buildPageIndex([lineItem], VP)
    const [[[x, , w]]] = findMatchesInPage(idx, 'brown') // chars 10–15 of 19
    expect(x).toBeCloseTo(100 + 190 * (10 / 19)) // offset to "brown"
    expect(w).toBeCloseTo(190 * (5 / 19)) // width of just "brown"
    expect(w).toBeLessThan(190) // not the whole line
  })

  it('empty query yields no matches', () => {
    const idx = buildPageIndex(itemsFromLine(['cat']), VP)
    expect(findMatchesInPage(idx, '')).toEqual([])
  })
})

// ── Hook ─────────────────────────────────────────────────────────────────────

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
        getViewport: () => ({ transform: VP, width: 600, height: 800 }),
        getTextContent: async () => ({
          items: [
            { str: 'findme', transform: [12, 0, 0, 12, 50, 700], width: 42, hasEOL: true },
            { type: 'beginMarkedContent' },
          ],
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
      getViewport: () => ({ transform: VP, width: 600, height: 800 }),
      getTextContent: async () => ({ items: itemsFromLine([`page${i}`]) }),
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
  it('finds every occurrence in reading order but selects none until you navigate', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['cat dog cat', 'bird', 'cat fish'])
    act(() => result.current.search('cat'))
    expect(result.current.matchCount).toBe(3) // 2 on page 1, 1 on page 3
    expect(result.current.currentMatch).toBe(0) // decoupled — no jump while typing
    expect(result.current.activeMatch).toBeNull()
    expect(result.current.matches.map((m) => m.page)).toEqual([1, 1, 3])
    // The first goNext selects the first match.
    act(() => result.current.goNext())
    expect(result.current.currentMatch).toBe(1)
    expect(result.current.activeMatch?.page).toBe(1)
    expect(result.current.activeMatch?.rects.length).toBeGreaterThan(0)
  })

  it('matches case-insensitively and folds diacritics', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['Hello Café World'])
    act(() => result.current.search('HELLO'))
    expect(result.current.matchCount).toBe(1)
    act(() => result.current.search('cafe'))
    expect(result.current.matchCount).toBe(1)
  })

  it('does NOT bump navNonce on search (no jump while typing), only on navigation', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['cat'])
    const before = result.current.navNonce
    act(() => result.current.search('cat'))
    expect(result.current.navNonce).toBe(before) // typing doesn't move the page
    act(() => result.current.goNext())
    expect(result.current.navNonce).toBeGreaterThan(before) // Enter/↑↓ does
  })

  it('resets to zero for a blank or too-short query', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['cat'])
    act(() => result.current.search('cat'))
    act(() => result.current.search('   '))
    expect(result.current.matchCount).toBe(0)
    expect(result.current.currentMatch).toBe(0)
    expect(result.current.activeMatch).toBeNull()
    act(() => result.current.search('c')) // single char — below MIN_QUERY_LEN
    expect(result.current.matchCount).toBe(0)
  })

  it('resets to zero when searching before the index is built', () => {
    const { result } = renderHook(() => usePdfSearch())
    act(() => result.current.search('anything'))
    expect(result.current.matchCount).toBe(0)
    expect(result.current.activeMatch).toBeNull()
  })

  it('reports zero matches when nothing contains the query', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['abc'])
    act(() => result.current.search('zzz'))
    expect(result.current.matchCount).toBe(0)
    expect(result.current.currentMatch).toBe(0)
    expect(result.current.activeMatch).toBeNull()
  })
})

describe('usePdfSearch — navigation', () => {
  it('goNext selects the first match, then cycles and wraps', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['cat', 'cat'])
    act(() => result.current.search('cat'))
    act(() => result.current.goNext())
    expect(result.current.currentMatch).toBe(1) // first goNext = first match
    expect(result.current.activeMatch?.page).toBe(1)
    act(() => result.current.goNext())
    expect(result.current.currentMatch).toBe(2)
    expect(result.current.activeMatch?.page).toBe(2)
    act(() => result.current.goNext())
    expect(result.current.currentMatch).toBe(1) // wrapped
    expect(result.current.activeMatch?.page).toBe(1)
  })

  it('goPrev from a fresh search selects the last match', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['cat', 'bird', 'cat'])
    act(() => result.current.search('cat'))
    expect(result.current.currentMatch).toBe(0) // none selected yet
    act(() => result.current.goPrev())
    expect(result.current.currentMatch).toBe(2) // 2 matches: pages 1 and 3
    expect(result.current.activeMatch?.page).toBe(3) // last match's page
  })

  it('goNext / goPrev are no-ops when there are no matches', async () => {
    const { result } = renderHook(() => usePdfSearch())
    await build(result, ['abc'])
    act(() => result.current.search('zzz'))
    act(() => result.current.goNext())
    act(() => result.current.goPrev())
    expect(result.current.currentMatch).toBe(0)
    expect(result.current.activeMatch).toBeNull()
  })
})
