import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { libraryService } from '../../services/library'
import { readerService } from '../../services/reader'
import { useReadingSession } from '../../hooks/useReadingSession'
import { useTextHighlight } from '../../hooks/useTextHighlight'
import { useAnnotations } from '../../hooks/useAnnotations'
import SearchBar from './SearchBar'
import TextSelectionPopup from './TextSelectionPopup'
import AnnotationsPanel from './AnnotationsPanel'
import type { Item, Annotation } from '../../types'
import '../../styles/reader.css'
import '../../styles/epub-reader.css'   // reuse settings panel + button styles

type FontFamily = 'serif' | 'sans' | 'mono'
type HtmlTheme  = 'dark' | 'light' | 'sepia'

const FONT_FAMILIES: Record<FontFamily, string> = {
  serif: "Georgia, 'Times New Roman', serif",
  sans:  "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono:  "'SF Mono', 'Fira Code', monospace",
}

// localStorage keys
const LS_FONT_SIZE    = 'html-font-size'
const LS_FONT_FAM    = 'html-font-family'
const LS_THEME       = 'html-theme'
const LS_LINE_HEIGHT = 'html-line-height'
const LS_MAX_WIDTH   = 'html-max-width'
const LS_CONTINUOUS  = 'html-continuous-mode'

const SAVE_DEBOUNCE_MS = 1000

interface Chapter {
  html:  string
  title: string
}

interface Props {
  item:               Item
  content:            string
  onBack:             () => void
  /** When set, enables per-chapter lazy loading. `content` is the HTML for
   *  chapter 0 and additional chapters are fetched on demand via IPC. */
  lazyChapterCount?:  number
  /** True when the background refresh detected new content on the source. */
  contentStale?:      boolean
  /** Called when the user clicks the "Updated" badge to reload fresh content. */
  onReloadContent?:   () => void
}

/** Extract individual chapters from a multi-chapter document. */
function parseChapters(html: string): Chapter[] | null {
  const doc  = new DOMParser().parseFromString(html, 'text/html')
  const divs = Array.from(doc.querySelectorAll('.chapter'))
  if (divs.length < 2) return null
  return divs.map((d, i) => ({
    html:  d.outerHTML,
    title: d.querySelector('.chapter-title')?.textContent?.trim() ?? `Chapter ${i + 1}`,
  }))
}

export default function HtmlReader({ item, content, onBack, lazyChapterCount, contentStale, onReloadContent }: Props) {
  const { recordActivity } = useReadingSession(item.id)

  const scrollRef = useRef<HTMLDivElement>(null)
  const saveTimer            = useRef<ReturnType<typeof setTimeout> | null>(null)
  const posTimer             = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activityThrottleRef  = useRef<number>(0)

  // ── Reader settings (localStorage) ───────────────────────────────

  const [fontSize,       setFontSize]       = useState(() => Number(localStorage.getItem(LS_FONT_SIZE)) || 18)
  const [fontFamily,     setFontFamily]     = useState<FontFamily>(() => (localStorage.getItem(LS_FONT_FAM) as FontFamily) || 'serif')
  const [theme,          setTheme]          = useState<HtmlTheme>(() => (localStorage.getItem(LS_THEME) as HtmlTheme) || 'dark')
  const [lineHeight,     setLineHeight]     = useState(() => Number(localStorage.getItem(LS_LINE_HEIGHT)) || 1.75)
  const [maxWidth,       setMaxWidth]       = useState(() => Number(localStorage.getItem(LS_MAX_WIDTH)) || 680)
  const [continuousMode, setContinuousMode] = useState(() => localStorage.getItem(LS_CONTINUOUS) === 'true')

  const [showSettings,    setShowSettings]    = useState(false)
  const [showSearch,      setShowSearch]      = useState(false)
  const [searchQuery,     setSearchQuery]     = useState('')
  const [showChapterList, setShowChapterList] = useState(false)
  const [showPanel,       setShowPanel]       = useState(false)
  const [readingProgress, setReadingProgress] = useState(() => Math.round((item.scroll_position ?? 0) * 100))

  // Note editor state: null = closed
  const [noteEditorState, setNoteEditorState] = useState<{
    range:       Range | null
    position:    number
    chapterIdx:  number | null
    existingId?: string
    initialText?: string
  } | null>(null)
  const [noteText, setNoteText] = useState('')

  function adjustFontSize(delta: number) {
    const next = Math.max(12, Math.min(32, fontSize + delta))
    setFontSize(next)
    localStorage.setItem(LS_FONT_SIZE, String(next))
  }

  function setFontFamilyAndSave(ff: FontFamily) {
    setFontFamily(ff)
    localStorage.setItem(LS_FONT_FAM, ff)
  }

  function setThemeAndSave(t: HtmlTheme) {
    setTheme(t)
    localStorage.setItem(LS_THEME, t)
  }

  function setLineHeightAndSave(v: number) {
    setLineHeight(v)
    localStorage.setItem(LS_LINE_HEIGHT, String(v))
  }

  function setMaxWidthAndSave(v: number) {
    setMaxWidth(v)
    localStorage.setItem(LS_MAX_WIDTH, String(v))
  }

  function setContinuousModeAndSave(v: boolean) {
    setContinuousMode(v)
    localStorage.setItem(LS_CONTINUOUS, String(v))
  }

  // ── Chapter parsing ──────────────────────────────────────────────

  const chapters = useMemo(() => parseChapters(content), [content])

  const initialChapter = useMemo(() => {
    if (!chapters) return 0
    if (item.scroll_chapter != null) return Math.min(item.scroll_chapter, chapters.length - 1)
    if (item.scroll_position) return Math.round(item.scroll_position * (chapters.length - 1))
    return 0
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // intentionally run once on mount

  const initialScrollY = useMemo(() => {
    if (!chapters) return null
    if (item.scroll_chapter != null && item.scroll_y != null && item.scroll_y > 0) return { y: item.scroll_y, isLegacyFrac: false }
    try {
      const raw = localStorage.getItem(`html-pos-${item.id}`)
      if (raw) {
        const { chapter: savedCh, scrollFraction: savedFrac } = JSON.parse(raw) as { chapter: number; scrollFraction: number }
        if (savedCh === initialChapter && savedFrac > 0) return { y: savedFrac, isLegacyFrac: true }
      }
    } catch {}
    return null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // intentionally run once on mount

  const [currentChapter, setCurrentChapter] = useState(initialChapter)
  const currentChapterRef = useRef(initialChapter)
  const pendingScrollRef  = useRef<{ y: number; isLegacyFrac: boolean } | null>(initialScrollY)

  // ── Annotations ──────────────────────────────────────────────────

  // For single articles: chapterIndex = null. For multi-chapter: 0-based index.
  const annotChapterIndex = chapters ? currentChapter : null
  const annot = useAnnotations({
    itemId:       item.id,
    contentRef:   scrollRef,
    chapterIndex: annotChapterIndex,
  })

  // Re-apply highlights after content changes (chapter nav, initial load)
  useEffect(() => {
    let cancelled = false
    const outer = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return
        annot.applyHighlightsToDOM(annotChapterIndex)
      })
    })
    return () => { cancelled = true; cancelAnimationFrame(outer) }
  // We intentionally re-run when annotations array changes too
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChapter, content, annot.annotations, annotChapterIndex])

  function getCurrentPosition(): number {
    const el = scrollRef.current
    if (!el) return 0
    const scrollable = el.scrollHeight - el.clientHeight
    return scrollable > 0 ? el.scrollTop / scrollable : 0
  }

  function handleSelectionHighlight(range: Range) {
    annot.createHighlight(range, getCurrentPosition())
  }

  function handleSelectionNote(range: Range) {
    const pos = getCurrentPosition()
    setNoteText('')
    setNoteEditorState({ range, position: pos, chapterIdx: annotChapterIndex })
  }

  async function saveNote() {
    if (!noteEditorState) return
    const text = noteText.trim()
    if (!text) { setNoteEditorState(null); return }
    if (noteEditorState.existingId) {
      await annot.updateNote(noteEditorState.existingId, text)
    } else {
      await annot.createNote(noteEditorState.position, text, noteEditorState.range ?? undefined)
      // Clear the text selection after saving
      window.getSelection()?.removeAllRanges()
    }
    setNoteEditorState(null)
    setNoteText('')
  }

  function handleJumpToAnnotation(annotation: Annotation) {
    const el = scrollRef.current
    if (!el) return

    // If multi-chapter and different chapter, navigate there first
    if (chapters && annotation.chapter_index !== null && annotation.chapter_index !== currentChapter) {
      goToChapter(annotation.chapter_index)
      // After navigation, the re-apply effect will mark the text; then we scroll
      // We use a timeout to wait for chapter content to render
      setTimeout(() => {
        const el2 = scrollRef.current
        if (!el2) return
        const mark = el2.querySelector<HTMLElement>(`mark[data-annotation-id="${annotation.id}"]`)
        if (mark) {
          mark.scrollIntoView({ behavior: 'smooth', block: 'center' })
          return
        }
        // Fallback to position
        const scrollable = el2.scrollHeight - el2.clientHeight
        el2.scrollTo({ top: annotation.position * scrollable, behavior: 'smooth' })
      }, 400)
      return
    }

    // Try to find the mark in DOM first
    const mark = el.querySelector<HTMLElement>(`mark[data-annotation-id="${annotation.id}"]`)
    if (mark) {
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    // Fallback: scroll to stored position
    const scrollable = el.scrollHeight - el.clientHeight
    el.scrollTo({ top: annotation.position * scrollable, behavior: 'smooth' })
  }

  // ── In-content search ────────────────────────────────────────────

  const contentKey = continuousMode ? 0 : currentChapter
  const { matchCount, currentMatch, goNext: hlNext, goPrev: hlPrev } =
    useTextHighlight(scrollRef, showSearch ? searchQuery : '', contentKey)

  function openSearch() {
    setShowSearch(true)
    setShowSettings(false)
    setShowChapterList(false)
  }

  function closeSearch() {
    setShowSearch(false)
    setSearchQuery('')
  }

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (posTimer.current)  clearTimeout(posTimer.current)
    }
  }, [])

  const scheduleSaveProgress = useCallback((position: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      libraryService.updateProgress(item.id, position)
    }, SAVE_DEBOUNCE_MS)
  }, [item.id])

  const scheduleSaveScrollPos = useCallback((chapter: number, scrollY: number) => {
    if (posTimer.current) clearTimeout(posTimer.current)
    posTimer.current = setTimeout(() => {
      libraryService.saveScrollPos(item.id, chapter, scrollY)
    }, SAVE_DEBOUNCE_MS)
  }, [item.id])

  // ── Single-page (article) mode ────────────────────────────────────

  useEffect(() => {
    if (chapters) return
    const scrollY = item.scroll_y ?? 0
    if (scrollY <= 0 && !item.scroll_position) return
    // Double-rAF: first frame queues paint, second fires after layout is complete
    // so scrollHeight is accurate before we read or set it.
    let cancelled = false
    const outer = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return
        const el = scrollRef.current
        if (!el) return
        if (scrollY > 0) {
          el.scrollTop = scrollY
        } else if (item.scroll_position) {
          el.scrollTop = item.scroll_position * (el.scrollHeight - el.clientHeight)
        }
      })
    })
    return () => { cancelled = true; cancelAnimationFrame(outer) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // intentionally run once on mount

  const handleSingleScroll = useCallback(() => {
    if (chapters) return
    const el = scrollRef.current
    if (!el) return
    const now = Date.now()
    if (now - activityThrottleRef.current >= 1000) { activityThrottleRef.current = now; recordActivity() }
    const scrollable = el.scrollHeight - el.clientHeight
    const frac = scrollable > 0 ? el.scrollTop / scrollable : 1
    setReadingProgress(Math.round(frac * 100))
    scheduleSaveProgress(frac)
    scheduleSaveScrollPos(0, el.scrollTop)
  }, [chapters, scheduleSaveProgress, scheduleSaveScrollPos, recordActivity])

  // ── Multi-chapter paged mode ─────────────────────────────────────

  useEffect(() => {
    if (!chapters || continuousMode) return
    // Double-rAF ensures chapter content has fully reflowed before we apply the
    // stored scroll offset — a single rAF can fire before block heights are settled.
    let cancelled = false
    const outer = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return
        const el = scrollRef.current
        if (!el) return
        if (pendingScrollRef.current !== null) {
          const { y, isLegacyFrac } = pendingScrollRef.current
          pendingScrollRef.current = null
          el.scrollTop = isLegacyFrac ? y * (el.scrollHeight - el.clientHeight) : y
        } else {
          el.scrollTo({ top: 0 })
        }
      })
    })
    return () => { cancelled = true; cancelAnimationFrame(outer) }
  }, [currentChapter, chapters, continuousMode])

  const handlePagedScroll = useCallback(() => {
    if (!chapters || continuousMode) return
    const el = scrollRef.current
    if (!el) return
    const now = Date.now()
    if (now - activityThrottleRef.current >= 1000) { activityThrottleRef.current = now; recordActivity() }
    scheduleSaveScrollPos(currentChapterRef.current, el.scrollTop)
  }, [chapters, continuousMode, scheduleSaveScrollPos, recordActivity])

  // ── Continuous scroll mode ────────────────────────────────────────

  useEffect(() => {
    if (!chapters || !continuousMode) return
    let cancelled = false
    const outer = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return
        const el = scrollRef.current
        if (!el) return
        const storedY = item.scroll_y ?? 0
        if (storedY > 0 && storedY < el.scrollHeight) {
          el.scrollTop = storedY
        } else {
          const chEl = el.querySelector<HTMLElement>(`#chapter-${currentChapterRef.current}`)
          if (chEl) el.scrollTop = chEl.offsetTop - 48
        }
      })
    })
    return () => { cancelled = true; cancelAnimationFrame(outer) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continuousMode])

  const handleContinuousScroll = useCallback(() => {
    if (!chapters || !continuousMode) return
    const el = scrollRef.current
    if (!el) return
    const now = Date.now()
    if (now - activityThrottleRef.current >= 1000) { activityThrottleRef.current = now; recordActivity() }

    // Detect current chapter from scroll position.
    // Walk chapters in order; the current chapter is the last one whose top
    // edge has entered the visible area (offsetTop <= scrollTop + small buffer).
    const threshold = el.scrollTop + 80
    let newChapter = 0
    for (let i = 0; i < chapters.length; i++) {
      const chEl = el.querySelector<HTMLElement>(`#chapter-${i}`)
      if (!chEl) break
      if (chEl.offsetTop <= threshold) newChapter = i
      else break
    }

    if (newChapter !== currentChapterRef.current) {
      currentChapterRef.current = newChapter
      setCurrentChapter(newChapter)
      const frac = chapters.length > 1 ? newChapter / (chapters.length - 1) : 0
      scheduleSaveProgress(frac)
    }

    scheduleSaveScrollPos(currentChapterRef.current, el.scrollTop)
  }, [chapters, continuousMode, scheduleSaveScrollPos, scheduleSaveProgress, recordActivity])

  // ── Chapter navigation ────────────────────────────────────────────

  function goToChapter(index: number) {
    if (!chapters) return
    const clamped = Math.max(0, Math.min(chapters.length - 1, index))
    recordActivity()
    currentChapterRef.current = clamped
    setCurrentChapter(clamped)

    if (continuousMode) {
      const el = scrollRef.current
      const chEl = el?.querySelector<HTMLElement>(`#chapter-${clamped}`)
      if (chEl) chEl.scrollIntoView({ behavior: 'smooth' })
    } else {
      pendingScrollRef.current = null
      const fraction = chapters.length > 1 ? clamped / (chapters.length - 1) : 0
      scheduleSaveProgress(fraction)
    }
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // Cmd+F / Ctrl+F — open search
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        openSearch()
        return
      }

      // Don't intercept anything else while typing
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // f — toggle fullscreen
      if (e.key === 'f') {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {})
        else document.exitFullscreen().catch(() => {})
        return
      }

      // j / k — smooth scroll
      if (e.key === 'j') { scrollRef.current?.scrollBy({ top: 80, behavior: 'smooth' }); return }
      if (e.key === 'k') { scrollRef.current?.scrollBy({ top: -80, behavior: 'smooth' }); return }

      // [ / ] — prev/next chapter (also ArrowLeft/ArrowRight)
      if (e.key === '[' || e.key === 'ArrowLeft')  { e.preventDefault(); goToChapter(currentChapterRef.current - 1); return }
      if (e.key === ']' || e.key === 'ArrowRight') { e.preventDefault(); goToChapter(currentChapterRef.current + 1); return }
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapters, continuousMode])

  // ── Combined scroll handler ───────────────────────────────────────

  const handleScroll = useCallback(() => {
    if (!chapters)      return handleSingleScroll()
    if (continuousMode) return handleContinuousScroll()
    return handlePagedScroll()
  }, [chapters, continuousMode, handleSingleScroll, handleContinuousScroll, handlePagedScroll])

  // ── CSS custom properties via inline style on shell ──────────────

  const shellStyle: React.CSSProperties = {
    '--reader-font-size':    `${fontSize}px`,
    '--reader-font-family':  FONT_FAMILIES[fontFamily],
    '--reader-line-height':  String(lineHeight),
    '--reader-para-spacing': `${lineHeight * 0.7}em`,
    '--reader-max-width':    `${maxWidth}px`,
  } as React.CSSProperties

  // ── Render ───────────────────────────────────────────────────────

  const ch = chapters?.[currentChapter]

  const noteEditorModal = noteEditorState && (
    <div className="note-editor-overlay" onClick={() => setNoteEditorState(null)}>
      <div className="note-editor-modal" onClick={e => e.stopPropagation()}>
        <div className="note-editor-header">
          {noteEditorState.existingId ? 'Edit note' : 'Add note'}
        </div>
        {noteEditorState.range && !noteEditorState.existingId && (
          <blockquote className="note-editor-quote">
            {noteEditorState.range.toString().slice(0, 120)}
          </blockquote>
        )}
        <textarea
          className="note-editor-textarea"
          value={noteText}
          onChange={e => setNoteText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote() }
            if (e.key === 'Escape') { setNoteEditorState(null); setNoteText('') }
          }}
          autoFocus
          rows={4}
          placeholder="Write a note…"
        />
        <div className="note-editor-actions">
          <button className="annot-save-btn" onClick={saveNote}>Save</button>
          <button className="annot-cancel-btn" onClick={() => { setNoteEditorState(null); setNoteText('') }}>Cancel</button>
        </div>
      </div>
    </div>
  )

  const annotationsPanel = showPanel && (
    <AnnotationsPanel
      annotations={annot.annotations}
      contentType={item.content_type}
      onJump={handleJumpToAnnotation}
      onDelete={annot.deleteAnnotation}
      onUpdateNote={annot.updateNote}
      onClose={() => setShowPanel(false)}
    />
  )

  const header = (
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

      {!showSearch && chapters && ch && (
        <div className="epub-chapter-nav">
          <button
            className="epub-chapter-arrow"
            onClick={() => goToChapter(currentChapter - 1)}
            disabled={currentChapter === 0}
            aria-label="Previous chapter"
          >‹</button>

          <div className="epub-chapter-dropdown-wrapper">
            <button
              className="epub-chapter-btn"
              onClick={() => setShowChapterList(s => !s)}
              title="Jump to chapter"
            >
              {currentChapter + 1}. {ch.title} ▾
            </button>

            {showChapterList && (
              <>
                <div className="epub-settings-overlay" onClick={() => setShowChapterList(false)} />
                <div className="epub-chapter-list" style={{ left: 'auto', right: 0 }}>
                  {chapters.map((c, i) => (
                    <button
                      key={i}
                      className={`epub-chapter-item${i === currentChapter ? ' active' : ''}`}
                      onClick={() => { goToChapter(i); setShowChapterList(false) }}
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
            onClick={() => goToChapter(currentChapter + 1)}
            disabled={currentChapter === chapters.length - 1}
            aria-label="Next chapter"
          >›</button>
        </div>
      )}

      {!showSearch && contentStale && onReloadContent && (
        <button
          className="reader-updated-badge"
          onClick={onReloadContent}
          title="New content available — click to reload"
          style={{ marginLeft: chapters ? '8px' : 'auto' }}
        >
          Updated ↻
        </button>
      )}

      {!showSearch && (
        <button
          className="epub-top-btn reader-search-btn"
          onClick={openSearch}
          aria-label="Search in content"
          title="Search (⌘F)"
          style={{ marginLeft: (contentStale || chapters) ? '8px' : 'auto' }}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
            <circle cx="6.5" cy="6.5" r="4.5" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" />
          </svg>
        </button>
      )}

      <div style={{ position: 'relative', marginLeft: '8px' }}>
        <button
          className={`epub-top-btn${showPanel ? ' active' : ''}`}
          onClick={() => setShowPanel(s => !s)}
          aria-label="Annotations"
          title="Annotations"
          style={{ position: 'relative' }}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
            <path d="M3 2h10v13l-5-3-5 3V2z" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
          {annot.annotations.length > 0 && (
            <span className="annot-badge">{annot.annotations.length}</span>
          )}
        </button>
      </div>

      <div className="epub-settings-wrapper" style={{ marginLeft: '8px' }}>
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
                  {([1.4, 1.75, 2.1] as const).map(v => (
                    <button
                      key={v}
                      className={`epub-settings-btn${lineHeight === v ? ' active' : ''}`}
                      onClick={() => setLineHeightAndSave(v)}
                    >
                      {v === 1.4 ? 'Tight' : v === 1.75 ? 'Normal' : 'Wide'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="epub-settings-row">
                <span className="epub-settings-label">Width</span>
                <div className="epub-settings-group">
                  {([560, 680, 800] as const).map(v => (
                    <button
                      key={v}
                      className={`epub-settings-btn${maxWidth === v ? ' active' : ''}`}
                      onClick={() => setMaxWidthAndSave(v)}
                    >
                      {v === 560 ? 'Narrow' : v === 680 ? 'Normal' : 'Wide'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="epub-settings-row">
                <span className="epub-settings-label">Theme</span>
                <div className="epub-settings-group">
                  {(['dark', 'light', 'sepia'] as HtmlTheme[]).map(t => (
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

              {chapters && (
                <div className="epub-settings-row">
                  <span className="epub-settings-label">Scroll</span>
                  <div className="epub-settings-group">
                    <button
                      className={`epub-settings-btn${!continuousMode ? ' active' : ''}`}
                      onClick={() => setContinuousModeAndSave(false)}
                    >
                      Paged
                    </button>
                    <button
                      className={`epub-settings-btn${continuousMode ? ' active' : ''}`}
                      onClick={() => setContinuousModeAndSave(true)}
                    >
                      Continuous
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </header>
  )

  // ── Continuous mode render ────────────────────────────────────────

  if (chapters && continuousMode) {
    return (
      <div className={`html-reader-shell html-theme-${theme}`} style={shellStyle}>
        {header}
        <div className="reader-with-panel">
          <div ref={scrollRef} className="html-reader" style={{ flex: 1, minWidth: 0 }} onScroll={handleScroll}>
            {chapters.map((c, i) => (
              <div key={i}>
                {i > 0 && (
                  <div className="chapter-separator" aria-hidden="true">
                    Chapter {i + 1}
                  </div>
                )}
                <div id={`chapter-${i}`} dangerouslySetInnerHTML={{ __html: c.html }} />
              </div>
            ))}
            <TextSelectionPopup
              containerRef={scrollRef}
              onHighlight={handleSelectionHighlight}
              onNote={handleSelectionNote}
            />
          </div>
          {annotationsPanel}
        </div>
        {noteEditorModal}
      </div>
    )
  }

  // ── Paged multi-chapter render ────────────────────────────────────

  if (chapters && ch) {
    return (
      <div className={`html-reader-shell html-theme-${theme}`} style={shellStyle}>
        {header}
        <div className="reader-with-panel">
          <div ref={scrollRef} className="html-reader" style={{ flex: 1, minWidth: 0 }} onScroll={handleScroll}>
            <div dangerouslySetInnerHTML={{ __html: ch.html }} />
            <nav className="chapter-nav">
              <button
                className="chapter-nav-btn chapter-nav-prev"
                onClick={() => goToChapter(currentChapter - 1)}
                disabled={currentChapter === 0}
              >
                ← Previous
              </button>
              {currentChapter < chapters.length - 1 ? (
                <button
                  className="chapter-nav-btn chapter-nav-next"
                  onClick={() => goToChapter(currentChapter + 1)}
                >
                  Next →
                </button>
              ) : (
                <span className="chapter-nav-end">End of story</span>
              )}
            </nav>
            <TextSelectionPopup
              containerRef={scrollRef}
              onHighlight={handleSelectionHighlight}
              onNote={handleSelectionNote}
            />
          </div>
          {annotationsPanel}
        </div>
        {noteEditorModal}
      </div>
    )
  }

  // ── Single-page (article) render ─────────────────────────────────

  return (
    <div className={`html-reader-shell html-theme-${theme}`} style={shellStyle}>
      {header}
      <div className="reader-progress-track">
        <div className="reader-progress-fill" style={{ width: `${readingProgress}%` }} />
      </div>
      <div className="reader-with-panel">
        <div
          ref={scrollRef}
          className="html-reader"
          style={{ flex: 1, minWidth: 0 }}
          onScroll={handleScroll}
          dangerouslySetInnerHTML={{ __html: content }}
        />
        <TextSelectionPopup
          containerRef={scrollRef}
          onHighlight={handleSelectionHighlight}
          onNote={handleSelectionNote}
        />
        {annotationsPanel}
      </div>
      {noteEditorModal}
    </div>
  )
}
