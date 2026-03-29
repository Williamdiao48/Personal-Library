import { useEffect, useRef, useCallback, useState } from 'react'
import { libraryService } from '../../services/library'
import { readerService } from '../../services/reader'
import { useReadingSession } from '../../hooks/useReadingSession'
import { useTextHighlight } from '../../hooks/useTextHighlight'
import SearchBar from './SearchBar'
import type { Item, EpubBook } from '../../types'
import '../../styles/epub-reader.css'

const SAVE_DEBOUNCE_MS = 600
const TRANSITION_MS    = 250

type FontFamily = 'serif' | 'sans' | 'mono'
type Theme      = 'dark' | 'light' | 'sepia'
type ColPadding = 'narrow' | 'normal' | 'wide'

const FONT_FAMILIES: Record<FontFamily, string> = {
  serif: "Georgia, 'Times New Roman', serif",
  sans:  "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono:  "'SF Mono', 'Fira Code', monospace",
}

// Side padding values (px) for narrow/normal/wide width settings.
// Applied to .epub-page-content > * via --epub-side-padding CSS var.
// Must NOT be applied to the container itself — side padding shifts column
// boundaries away from outerWidth multiples and breaks page-count math.
const COL_PADDING_PX: Record<ColPadding, number> = {
  narrow: 80,
  normal: 40,
  wide:   12,
}

const LS_FONT_SIZE   = 'epub-font-size'
const LS_FONT_FAM    = 'epub-font-family'
const LS_THEME       = 'epub-theme'
const LS_LINE_HEIGHT = 'epub-line-height'
const LS_COL_PADDING = 'epub-col-padding'

interface Props { item: Item; onBack: () => void }

interface XAnim {
  chapter:    number
  direction:  'forward' | 'backward'
  newPage:    number           // 0 for fwd; lastPage for bwd (filled during 'measure')
  phase:      'setup'          // fwd: incoming at W off-screen-right, waiting for rAF
            | 'measure'        // bwd: incoming at 0 visibility:hidden, measuring scrollWidth
            | 'positioned'     // bwd: incoming at -(lastPage+1)*W, waiting for rAF
            | 'sliding'        // CSS transition active on both divs
  activeEnd:  number           // translateX the active div animates to
  xTransform: number           // incoming div's current (pre-slide) translateX
  xEnd:       number           // incoming div's final (post-slide) translateX
}

export default function EpubReader({ item, onBack }: Props) {
  const { recordActivity } = useReadingSession(item.id)

  const [book,         setBook]         = useState<EpubBook | null>(null)
  const [chapter,      setChapter]      = useState(0)
  const [page,         setPage]         = useState(0)
  const [totalPages,   setTotalPages]   = useState(1)
  const [outerWidth,   setOuterWidth]   = useState(0)
  const [noTransition, setNoTransition] = useState(false)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState<string | null>(null)
  const [xAnim,        setXAnim]        = useState<XAnim | null>(null)
  const [fontSize,     setFontSize]     = useState(() => Number(localStorage.getItem(LS_FONT_SIZE)) || 18)
  const [fontFamily,   setFontFamily]   = useState<FontFamily>(() => (localStorage.getItem(LS_FONT_FAM) as FontFamily) || 'serif')
  const [theme,        setTheme]        = useState<Theme>(() => (localStorage.getItem(LS_THEME) as Theme) || 'dark')
  const [lineHeight,   setLineHeight]   = useState(() => Number(localStorage.getItem(LS_LINE_HEIGHT)) || 1.4)
  const [colPadding,   setColPadding]   = useState<ColPadding>(() => (localStorage.getItem(LS_COL_PADDING) as ColPadding) || 'normal')
  const [showSettings,      setShowSettings]      = useState(false)
  const [showChapterList,   setShowChapterList]   = useState(false)
  const [showSearch,        setShowSearch]        = useState(false)
  const [searchQuery,       setSearchQuery]       = useState('')
  const [chapterPageCounts, setChapterPageCounts] = useState<number[]>([])

  const outerRef   = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const xRef       = useRef<HTMLDivElement>(null)   // ref for incoming chapter div
  const saveTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Ref mirrors for use inside stable event handlers / stale closures
  const pageRef               = useRef(0)
  const totalPagesRef         = useRef(1)
  const chapterRef            = useRef(0)
  const bookRef               = useRef<EpubBook | null>(null)
  const outerWidthRef         = useRef(0)            // mirrors outerWidth
  const xAnimRef              = useRef<XAnim | null>(null)  // mirrors xAnim
  const chapterPageCountsRef  = useRef<number[]>([]) // mirrors chapterPageCounts
  // Carries the within-chapter page from initial localStorage read to the first
  // page-count measurement (effect 3), where totalPages is known for clamping.
  const pendingPageRef        = useRef<number | null>(null)

  // Keep both state and ref in sync for xAnim
  function updateXAnim(next: XAnim | null) {
    xAnimRef.current = next
    setXAnim(next)
  }

  // ── In-content search ─────────────────────────────────────────
  // `chapter` is the contentKey: when the user navigates to a new chapter,
  // React updates innerHTML and the highlight effect re-fires automatically.

  // EPUB content uses CSS multi-column pagination driven by transform, not
  // overflow-scroll. scrollIntoView() is ineffective here — instead we
  // recover the mark's logical column index and flip to that page directly.
  const handleSearchActivate = useCallback((mark: HTMLElement) => {
    const w     = outerWidthRef.current
    const outer = outerRef.current
    if (!w || !outer) return
    // getBoundingClientRect() gives the visual (post-transform) position.
    // Adding back the current page offset recovers the logical column position.
    const markRect  = mark.getBoundingClientRect()
    const outerRect = outer.getBoundingClientRect()
    const logicalX  = (markRect.left - outerRect.left) + pageRef.current * w
    const target    = Math.max(0, Math.min(Math.floor(logicalX / w), totalPagesRef.current - 1))
    if (target !== pageRef.current) {
      pageRef.current = target
      setPage(target)
    }
  }, []) // refs are stable — no deps needed

  const { matchCount, currentMatch, goNext: hlNext, goPrev: hlPrev } =
    useTextHighlight(contentRef, showSearch ? searchQuery : '', chapter, handleSearchActivate)

  function openSearch() {
    setShowSearch(true)
    setShowSettings(false)
    setShowChapterList(false)
  }

  function closeSearch() {
    setShowSearch(false)
    setSearchQuery('')
  }

  // ── 1. Load EPUB ───────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false

    readerService.loadEpub(item.file_path)
      .then(loaded => {
        if (cancelled) return
        const total   = loaded.chapters.length
        const initial = item.scroll_position && total > 1
          ? Math.max(0, Math.min(Math.round(item.scroll_position * (total - 1)), total - 1))
          : 0
        bookRef.current    = loaded
        chapterRef.current = initial
        // Restore within-chapter page from localStorage. The page count for
        // this chapter isn't known yet (requires a rendered DOM), so we stash
        // it in pendingPageRef and apply it in effect 3 once totalPages is set.
        try {
          const raw = localStorage.getItem(`epub-pos-${item.id}`)
          if (raw) {
            const { chapter: savedCh, page: savedPg } = JSON.parse(raw) as { chapter: number; page: number }
            if (savedCh === initial && savedPg > 0) pendingPageRef.current = savedPg
          }
        } catch {}
        setBook(loaded)
        setChapter(initial)
        setLoading(false)
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load EPUB.')
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 2. Measure outer container width (ResizeObserver) ─────────
  // Runs after loading ends so the outer div is actually mounted.

  useEffect(() => {
    if (loading) return
    const el = outerRef.current
    if (!el) return

    const w = el.clientWidth
    outerWidthRef.current = w
    setOuterWidth(w)

    const ro = new ResizeObserver(([entry]) => {
      setNoTransition(true)
      const newW = Math.round(entry.contentRect.width)
      outerWidthRef.current = newW
      setOuterWidth(newW)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [loading])

  // ── 3. Recompute page count after chapter / width changes ──────

  useEffect(() => {
    if (!book || outerWidth === 0) return

    const rafId = requestAnimationFrame(() => {
      const content = contentRef.current
      if (!content) return

      const pages = Math.max(1, Math.round(content.scrollWidth / outerWidth))
      totalPagesRef.current = pages
      setTotalPages(pages)

      // On initial load, restore the saved within-chapter page position.
      if (pendingPageRef.current !== null) {
        const restored = Math.min(pendingPageRef.current, pages - 1)
        pendingPageRef.current = null
        pageRef.current = restored
        setPage(restored)
      } else {
        // Only clamp; xAnim commit already sets the correct page for chapter transitions
        const clamped = Math.min(pageRef.current, pages - 1)
        if (clamped !== pageRef.current) {
          pageRef.current = clamped
          setPage(clamped)
        }
      }

      setNoTransition(false)
    })

    return () => cancelAnimationFrame(rafId)
  }, [chapter, book, outerWidth, fontSize, fontFamily])

  // ── 3c. Persist within-chapter page to localStorage ─────────────
  // The DB only stores the chapter fraction; localStorage adds page granularity.
  // Debounced so rapid page flips don't spam writes.
  useEffect(() => {
    if (loading) return
    const timer = setTimeout(() => {
      localStorage.setItem(`epub-pos-${item.id}`, JSON.stringify({ chapter, page }))
    }, 400)
    return () => clearTimeout(timer)
  }, [chapter, page, loading, item.id])

  // ── 3b. Measure all chapter page counts for global progress ────
  // Creates a hidden off-screen div and renders each chapter's HTML in
  // rAF-batched chunks (≤8 ms per frame) to avoid freezing the UI on
  // large EPUBs. Cleans up the div if deps change mid-measurement.

  useEffect(() => {
    if (!book || outerWidth === 0) return
    const outer = outerRef.current
    if (!outer) return
    const h = outer.clientHeight
    if (h === 0) return

    const chapters = book.chapters
    const counts   = new Array<number>(chapters.length)
    let cancelled  = false
    let i          = 0

    const el = document.createElement('div')
    Object.assign(el.style, {
      position:      'fixed',
      left:          '-99999px',
      top:           '0',
      visibility:    'hidden',
      pointerEvents: 'none',
      width:         `${outerWidth}px`,
      height:        `${h}px`,
      columnWidth:   `${Math.floor(outerWidth / 2)}px`,
      columnFill:    'auto',
      columnGap:     '0',
      boxSizing:     'border-box',
      padding:       `16px ${COL_PADDING_PX[colPadding]}px`,
      fontSize:      `${fontSize}px`,
      fontFamily:    FONT_FAMILIES[fontFamily],
      lineHeight:    String(lineHeight),
    })
    document.body.appendChild(el)

    let rafId: number

    function measureBatch() {
      if (cancelled) return
      const deadline = performance.now() + 8  // ≤8 ms per frame
      while (i < chapters.length && performance.now() < deadline) {
        el.innerHTML = chapters[i].html
        counts[i]    = Math.max(1, Math.round(el.scrollWidth / outerWidth))
        i++
      }
      if (i < chapters.length) {
        rafId = requestAnimationFrame(measureBatch)
      } else {
        document.body.removeChild(el)
        chapterPageCountsRef.current = counts.slice()
        setChapterPageCounts(counts.slice())
      }
    }

    rafId = requestAnimationFrame(measureBatch)

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      if (document.body.contains(el)) document.body.removeChild(el)
    }
  }, [book, outerWidth, fontSize, fontFamily, lineHeight, colPadding])

  // ── 4. xAnim state machine ─────────────────────────────────────

  useEffect(() => {
    if (!xAnim) return

    // Forward nav: incoming div has been painted at xTransform=W with no transition.
    // One rAF ensures the browser commits that position before we enable the transition.
    if (xAnim.phase === 'setup') {
      const raf = requestAnimationFrame(() =>
        updateXAnim({ ...xAnim, phase: 'sliding' }))
      return () => cancelAnimationFrame(raf)
    }

    // Backward nav: incoming div painted at translateX(0), visibility:hidden.
    // Measure scrollWidth to find lastPage, then reposition off-screen-left.
    if (xAnim.phase === 'measure') {
      const raf = requestAnimationFrame(() => {
        const el = xRef.current
        if (!el) return
        const w     = outerWidthRef.current
        const pages = Math.max(1, Math.round(el.scrollWidth / w))
        const last  = pages - 1
        updateXAnim({
          ...xAnim,
          phase:      'positioned',
          newPage:    last,
          xTransform: -(last + 1) * w,  // off-screen left; last-page col is 1 W off left edge
          xEnd:       -(last * w),        // final: last page aligns with viewport
        })
      })
      return () => cancelAnimationFrame(raf)
    }

    // Backward nav: incoming has been snapped to off-screen-left (no transition).
    // One rAF so browser commits that position before enabling the transition.
    if (xAnim.phase === 'positioned') {
      const raf = requestAnimationFrame(() =>
        updateXAnim({ ...xAnim, phase: 'sliding' }))
      return () => cancelAnimationFrame(raf)
    }

    // Both divs are now animating via CSS transition.
    // After the transition completes, commit the new chapter/page state.
    if (xAnim.phase === 'sliding') {
      const timer = setTimeout(() => {
        chapterRef.current = xAnim.chapter
        pageRef.current    = xAnim.newPage

        if (xAnim.direction === 'backward') {
          // We measured the page count; set it now so totalPagesRef is correct
          // before the page-count effect's rAF fires
          const pages = xAnim.newPage + 1
          totalPagesRef.current = pages
          setTotalPages(pages)
        }

        // noTransition=true prevents a spurious animation when the active div
        // snaps from activeEnd (off-screen) back to offset=0 for the new chapter
        setNoTransition(true)
        setChapter(xAnim.chapter)
        setPage(xAnim.newPage)
        updateXAnim(null)
      }, TRANSITION_MS + 20)
      return () => clearTimeout(timer)
    }
  }, [xAnim])

  // ── 5. Keyboard navigation ─────────────────────────────────────

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName

      // Cmd+F / Ctrl+F — open search
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(true)
        setShowSettings(false)
        setShowChapterList(false)
        return
      }

      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (xAnimRef.current) return  // block all nav during chapter transition

      // f — toggle fullscreen
      if (e.key === 'f') {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {})
        else document.exitFullscreen().catch(() => {})
        return
      }

      // [ / ] — jump to prev/next chapter (instant, no slide animation)
      if (e.key === '[') {
        e.preventDefault()
        if (chapterRef.current > 0) jumpToChapter(chapterRef.current - 1)
        return
      }
      if (e.key === ']') {
        e.preventDefault()
        const bk = bookRef.current
        if (bk && chapterRef.current < bk.chapters.length - 1) jumpToChapter(chapterRef.current + 1)
        return
      }

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        if (pageRef.current < totalPagesRef.current - 1) {
          const next = pageRef.current + 1
          pageRef.current = next
          setPage(next)
        } else if (bookRef.current && chapterRef.current < bookRef.current.chapters.length - 1) {
          // Held-down key: skip the slide animation so rapid flipping isn't
          // interrupted by the 250 ms transition at every chapter boundary.
          if (e.repeat) jumpToChapter(chapterRef.current + 1)
          else          changeChapter(chapterRef.current + 1, false)
        }
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (pageRef.current > 0) {
          const prev = pageRef.current - 1
          pageRef.current = prev
          setPage(prev)
        } else if (chapterRef.current > 0) {
          if (e.repeat) {
            const prev     = chapterRef.current - 1
            const known    = chapterPageCountsRef.current[prev]
            const lastPage = known ? known - 1 : 0
            jumpToChapter(prev, lastPage)
          } else {
            changeChapter(chapterRef.current - 1, true)
          }
        }
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, []) // stable — all navigation uses refs; state setters are stable

  // ── Navigation helpers ─────────────────────────────────────────

  function changeChapter(index: number, goToLastPage: boolean) {
    const bk = bookRef.current
    if (!bk || xAnimRef.current) return  // block during active transition
    const clamped = Math.max(0, Math.min(index, bk.chapters.length - 1))
    const w       = outerWidthRef.current
    const curOff  = -(pageRef.current * w)
    chapterRef.current = clamped

    updateXAnim({
      chapter:    clamped,
      direction:  goToLastPage ? 'backward' : 'forward',
      newPage:    0,                                        // filled during 'measure' for backward
      phase:      goToLastPage ? 'measure' : 'setup',
      activeEnd:  goToLastPage ? curOff + w : curOff - w,  // active slides right (bwd) or left (fwd)
      xTransform: goToLastPage ? 0 : w,                    // bwd: hidden at 0; fwd: off-screen right
      xEnd:       0,                                        // filled during 'measure' for backward
    })

    const fraction = bk.chapters.length > 1 ? clamped / (bk.chapters.length - 1) : 0
    scheduleSave(fraction)
  }

  // Instant chapter jump — no slide animation.
  // Used by the chapter bar (dropdown + arrows) and rapid key-repeat at boundaries.
  // Always lands on page 0 of the target chapter.
  function jumpToChapter(index: number, targetPage = 0) {
    const bk = bookRef.current
    if (!bk) return
    const clamped = Math.max(0, Math.min(index, bk.chapters.length - 1))
    recordActivity()
    updateXAnim(null)
    chapterRef.current = clamped
    pageRef.current    = targetPage
    setNoTransition(true)
    setChapter(clamped)
    setPage(targetPage)
    const fraction = bk.chapters.length > 1 ? clamped / (bk.chapters.length - 1) : 0
    scheduleSave(fraction)
  }

  function prevPage() {
    if (xAnimRef.current) return
    recordActivity()
    if (pageRef.current > 0) {
      const prev = pageRef.current - 1
      pageRef.current = prev
      setPage(prev)
    } else if (chapterRef.current > 0) {
      changeChapter(chapterRef.current - 1, true)
    }
  }

  function nextPage() {
    if (xAnimRef.current) return
    recordActivity()
    const bk = bookRef.current
    if (pageRef.current < totalPagesRef.current - 1) {
      const next = pageRef.current + 1
      pageRef.current = next
      setPage(next)
    } else if (bk && chapterRef.current < bk.chapters.length - 1) {
      changeChapter(chapterRef.current + 1, false)
    }
  }

  const scheduleSave = useCallback((fraction: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      libraryService.updateProgress(item.id, fraction)
    }, SAVE_DEBOUNCE_MS)
  }, [item.id])

  function adjustFontSize(delta: number) {
    const next = Math.max(12, Math.min(28, fontSize + delta))
    setFontSize(next)
    localStorage.setItem(LS_FONT_SIZE, String(next))
  }

  function setFontFamilyAndSave(ff: FontFamily) {
    setFontFamily(ff)
    localStorage.setItem(LS_FONT_FAM, ff)
  }

  function setThemeAndSave(t: Theme) {
    setTheme(t)
    localStorage.setItem(LS_THEME, t)
  }

  function setLineHeightAndSave(v: number) {
    setLineHeight(v)
    localStorage.setItem(LS_LINE_HEIGHT, String(v))
  }

  function setColPaddingAndSave(v: ColPadding) {
    setColPadding(v)
    localStorage.setItem(LS_COL_PADDING, v)
  }

  // ── Render ─────────────────────────────────────────────────────

  if (loading) return <div className="reader-loading">Loading EPUB…</div>
  if (error)   return <div className="reader-loading">{error}</div>
  if (!book || book.chapters.length === 0)
    return <div className="reader-loading">No readable content found in this EPUB.</div>

  const ch      = book.chapters[chapter]
  const w       = outerWidth
  const offset  = w > 0 ? -(page * w) : 0
  const canPrev = page > 0 || chapter > 0
  const canNext = page < totalPages - 1 || chapter < book.chapters.length - 1

  const allMeasured = chapterPageCounts.length === book.chapters.length
  const globalPage  = allMeasured
    ? chapterPageCounts.slice(0, chapter).reduce((a, b) => a + b, 0) + page + 1
    : null
  const globalTotal         = allMeasured ? chapterPageCounts.reduce((a, b) => a + b, 0) : null
  const remainingInChapter  = totalPages - page - 1

  // During 'sliding', override the active div's transform to its animated end position
  const activeTransform  = xAnim?.phase === 'sliding' ? xAnim.activeEnd : offset
  const activeTransition = xAnim?.phase === 'sliding'
    ? `transform ${TRANSITION_MS}ms ease`
    : noTransition ? 'none' : `transform ${TRANSITION_MS}ms ease`

  // Shared style props for both content divs.
  // '--epub-side-padding' drives padding on > * via CSS var — side padding
  // must not go on the container itself (would break column-width math).
  const contentStyleBase = {
    columnWidth:            w > 0 ? `${Math.floor(w / 2)}px` : undefined,
    fontSize:               `${fontSize}px`,
    fontFamily:             FONT_FAMILIES[fontFamily],
    lineHeight:             String(lineHeight),
    '--epub-side-padding':  `${COL_PADDING_PX[colPadding]}px`,
  } as React.CSSProperties

  return (
    <div className={`epub-reader epub-theme-${theme}`}>

      {/* ── Combined reader header ─────────────────────────────── */}
      <header className="reader-header">

        <button className="epub-back-btn" onClick={onBack}>← Library</button>

        {showSearch ? (
          <SearchBar
            query={searchQuery}
            onQueryChange={setSearchQuery}
            matchCount={matchCount}
            currentMatch={currentMatch}
            onNext={hlNext}
            onPrev={hlPrev}
            onClose={closeSearch}
          />
        ) : (
          <span className="reader-header-title">{item.title}</span>
        )}

        {/* Chapter navigation — right side, before search + Aa */}
        {!showSearch && (
          <div className="epub-chapter-nav">
            <button
              className="epub-chapter-arrow"
              onClick={() => jumpToChapter(chapter - 1)}
              disabled={chapter === 0}
            >‹</button>

            <div className="epub-chapter-dropdown-wrapper">
              <button
                className="epub-chapter-btn"
                onClick={() => setShowChapterList(s => !s)}
              >
                {chapter + 1}. {ch.title} ▾
              </button>

              {showChapterList && (
                <>
                  <div className="epub-settings-overlay" onClick={() => setShowChapterList(false)} />
                  <div className="epub-chapter-list" style={{left: 'auto', right: 0}}>
                    {book.chapters.map((c, i) => (
                      <button
                        key={i}
                        className={`epub-chapter-item${i === chapter ? ' active' : ''}`}
                        onClick={() => { jumpToChapter(i); setShowChapterList(false) }}
                      >
                        {i + 1}. {c.title}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <button
              className="epub-chapter-arrow"
              onClick={() => jumpToChapter(chapter + 1)}
              disabled={chapter === book.chapters.length - 1}
            >›</button>
          </div>
        )}

        {/* Search button */}
        {!showSearch && (
          <button
            className="epub-top-btn reader-search-btn"
            onClick={openSearch}
            aria-label="Search in content"
            title="Search (⌘F)"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <circle cx="6.5" cy="6.5" r="4.5" />
              <line x1="10.5" y1="10.5" x2="14" y2="14" />
            </svg>
          </button>
        )}

        <div className="epub-settings-wrapper">
          <button
            className={`epub-top-btn${showSettings ? ' active' : ''}`}
            onClick={() => { setShowSettings(s => !s); setShowSearch(false) }}
            aria-label="Reader settings"
          >
            Aa
          </button>

          {showSettings && (
            <>
              <div className="epub-settings-overlay" onClick={() => setShowSettings(false)} />

              <div className="epub-settings-panel">
                <div className="epub-settings-row">
                  <span className="epub-settings-label">Text size</span>
                  <div className="epub-settings-group">
                    <button className="epub-settings-btn" onClick={() => adjustFontSize(-1)}>A−</button>
                    <span className="epub-settings-size-display">{fontSize}</span>
                    <button className="epub-settings-btn" onClick={() => adjustFontSize(+1)}>A+</button>
                  </div>
                </div>

                <div className="epub-settings-row">
                  <span className="epub-settings-label">Font</span>
                  <div className="epub-settings-group">
                    {(['serif', 'sans', 'mono'] as FontFamily[]).map(ff => (
                      <button
                        key={ff}
                        className={`epub-settings-btn${fontFamily === ff ? ' active' : ''}`}
                        onClick={() => setFontFamilyAndSave(ff)}
                      >
                        {ff.charAt(0).toUpperCase() + ff.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="epub-settings-row">
                  <span className="epub-settings-label">Spacing</span>
                  <div className="epub-settings-group">
                    {([1.4, 1.7, 2.1] as const).map(v => (
                      <button
                        key={v}
                        className={`epub-settings-btn${lineHeight === v ? ' active' : ''}`}
                        onClick={() => setLineHeightAndSave(v)}
                      >
                        {v === 1.4 ? 'Tight' : v === 1.7 ? 'Normal' : 'Wide'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="epub-settings-row">
                  <span className="epub-settings-label">Width</span>
                  <div className="epub-settings-group">
                    {(['narrow', 'normal', 'wide'] as ColPadding[]).map(v => (
                      <button
                        key={v}
                        className={`epub-settings-btn${colPadding === v ? ' active' : ''}`}
                        onClick={() => setColPaddingAndSave(v)}
                      >
                        {v.charAt(0).toUpperCase() + v.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="epub-settings-row">
                  <span className="epub-settings-label">Theme</span>
                  <div className="epub-settings-group">
                    {(['dark', 'light', 'sepia'] as Theme[]).map(t => (
                      <button
                        key={t}
                        className={`epub-settings-btn${theme === t ? ' active' : ''}`}
                        onClick={() => setThemeAndSave(t)}
                      >
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

      </header>

      {/* ── Page viewport ──────────────────────────────────────── */}
      <div ref={outerRef} className="epub-page-outer">

        {/* Active (current) chapter */}
        <div
          ref={contentRef}
          className="epub-page-content"
          style={{
            ...contentStyleBase,
            transform:  `translateX(${activeTransform}px)`,
            transition: activeTransition,
          }}
          dangerouslySetInnerHTML={{ __html: ch.html }}
        />

        {/* Incoming chapter — rendered only during a chapter transition */}
        {xAnim && (
          <div
            ref={xRef}
            className="epub-page-content"
            style={{
              ...contentStyleBase,
              position:   'absolute',
              inset:      0,
              transform:  `translateX(${xAnim.phase === 'sliding' ? xAnim.xEnd : xAnim.xTransform}px)`,
              transition: xAnim.phase === 'sliding' ? `transform ${TRANSITION_MS}ms ease` : 'none',
              visibility: xAnim.phase === 'measure' ? 'hidden' : 'visible',
            }}
            dangerouslySetInnerHTML={{ __html: book.chapters[xAnim.chapter].html }}
          />
        )}

        {canPrev && (
          <div
            className="epub-click-prev"
            onClick={prevPage}
            aria-label="Previous page"
            role="button"
          />
        )}
        {canNext && (
          <div
            className="epub-click-next"
            onClick={nextPage}
            aria-label="Next page"
            role="button"
          />
        )}

        {/* Page number overlay — absolute, centred at bottom of reading area */}
        {allMeasured && (
          <div className="epub-page-footer">
            <span className="epub-page-short epub-page-indicator">{globalPage}</span>
            <span className="epub-page-long epub-page-indicator">
              {globalPage} / {globalTotal} · {remainingInChapter > 0
                ? `${remainingInChapter} page${remainingInChapter !== 1 ? 's' : ''} left in chapter`
                : 'last page of chapter'}
            </span>
          </div>
        )}

      </div>

    </div>
  )
}
