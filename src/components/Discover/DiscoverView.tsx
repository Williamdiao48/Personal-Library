import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { discoverService } from '../../services/discover'
import { useToast } from '../../contexts/ToastContext'
import { useSettings } from '../../contexts/SettingsContext'
import { useCaptureJobs } from '../../contexts/CaptureJobsContext'
import AddItemModal from '../Capture/AddItemModal'
import RecommendationCard from './RecommendationCard'
import type { Recommendation } from '../../types'
import '../../styles/discover.css'

/** "just now" / "3h ago" / "2d ago" — the cache freshness line. Exported for tests. */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - ts)
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  return `${days}d ago`
}

/** A shimmering placeholder card shown in the grid while the next page loads. */
function SkeletonCard() {
  return (
    <div className="rec-card rec-card--skeleton" aria-hidden="true">
      <div className="rec-card-cover skeleton-shimmer" />
      <div className="rec-card-body">
        <div className="skeleton-shimmer skeleton-badge" />
        <div className="skeleton-shimmer skeleton-title" />
        <div className="skeleton-shimmer skeleton-line-short" />
        <div className="skeleton-chip-row">
          <div className="skeleton-shimmer skeleton-chip" />
          <div className="skeleton-shimmer skeleton-chip" />
        </div>
      </div>
    </div>
  )
}

export default function DiscoverView() {
  const navigate = useNavigate()
  const { addToast, updateToast } = useToast()
  const { settings } = useSettings()
  const { startJob } = useCaptureJobs()

  const [cards, setCards] = useState<Recommendation[]>([])
  const [generatedAt, setGeneratedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [coldStart, setColdStart] = useState(false)

  // Infinite scroll: reveal `visibleCount` of the loaded pool, growing a page at a
  // time as a sentinel nears the viewport; when the whole loaded pool is on screen,
  // auto-fetch the next page (`more`) and append. `exhausted` latches when a fetch
  // returns nothing new so we stop pestering the engine.
  const PAGE_SIZE = 12
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // Modal (Add to Library) — same parent-owned pattern as LibraryView. We track the
  // rec being added (not just its URL) so we can drop it from the feed once it's
  // saved (it's now owned — it'd be filtered on the next refresh anyway).
  const [showAddModal, setShowAddModal] = useState(false)
  const [pendingUrl, setPendingUrl] = useState<string | undefined>(undefined)
  const [pendingRec, setPendingRec] = useState<Recommendation | undefined>(undefined)
  const closeModal = () => {
    setShowAddModal(false)
    setPendingUrl(undefined)
    setPendingRec(undefined)
  }

  const removeCard = useCallback((sourceId: string) => {
    setCards((prev) => prev.filter((c) => c.sourceId !== sourceId))
  }, [])

  // On mount: show the cached snapshot instantly (no fetch).
  useEffect(() => {
    discoverService
      .get()
      .then((cached) => {
        if (cached) {
          setCards(cached.cards)
          setGeneratedAt(cached.generatedAt)
        }
      })
      .catch((err) =>
        setLoadError(err instanceof Error ? err.message : 'Failed to load recommendations.'),
      )
      .finally(() => setLoading(false))
  }, [])

  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    // The first run (no cards yet) hits the cold path — sources + model are
    // uncached, so it can take a while. Set expectations in the persistent toast.
    const firstRun = cards.length === 0
    const toastId = addToast(
      firstRun
        ? 'Finding your first recommendations — this can take a moment…'
        : 'Finding recommendations…',
      'info',
    )
    try {
      // Pass the feed currently on screen so a still-warm refresh rotates to the
      // next-best slice (the engine excludes these) instead of returning a repeat.
      const res = await discoverService.refresh(cards.map((c) => c.sourceId))
      setCards(res.cards)
      setGeneratedAt(res.generatedAt)
      setColdStart(res.coldStart)
      // Fresh feed → restart the scroll pagination.
      setVisibleCount(PAGE_SIZE)
      setExhausted(false)
      if (res.coldStart) {
        updateToast(toastId, 'Read and rate a few items first', 'success')
      } else {
        updateToast(toastId, `Found ${res.cards.length} recommendations`, 'success')
      }
    } catch {
      updateToast(toastId, 'Could not load recommendations', 'error')
    } finally {
      setRefreshing(false)
    }
  }, [refreshing, cards, addToast, updateToast])

  // Fetch the next page: exclude everything already shown so the engine returns the
  // NEXT best picks (never repeats). No new cards = the pool is exhausted.
  const loadMore = useCallback(async () => {
    setLoadingMore(true)
    try {
      const shownIds = cards.map((c) => c.sourceId)
      const res = await discoverService.more(shownIds)
      const seen = new Set(shownIds)
      const fresh = res.cards.filter((c) => !seen.has(c.sourceId))
      if (fresh.length === 0) {
        setExhausted(true)
      } else {
        setCards((prev) => [...prev, ...fresh])
        setVisibleCount((c) => c + Math.min(PAGE_SIZE, fresh.length))
      }
    } catch {
      setExhausted(true) // don't hammer the engine on a failed page
    } finally {
      setLoadingMore(false)
    }
  }, [cards])

  // Sentinel reached: first reveal more of the already-loaded pool (instant), and
  // only once it's all on screen fetch the next page from the engine.
  const onReachEnd = useCallback(() => {
    if (loading || refreshing || coldStart || cards.length === 0) return
    if (visibleCount < cards.length) {
      setVisibleCount((c) => Math.min(c + PAGE_SIZE, cards.length))
      return
    }
    if (!loadingMore && !exhausted) void loadMore()
  }, [loading, refreshing, coldStart, cards.length, visibleCount, loadingMore, exhausted, loadMore])

  // Observe the sentinel against the viewport, prefetching ~a screen early.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onReachEnd()
      },
      { rootMargin: '600px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [onReachEnd])

  const handleAdd = (rec: Recommendation) => {
    setPendingUrl(rec.url)
    setPendingRec(rec)
    setShowAddModal(true)
  }

  const handleDismiss = (rec: Recommendation, _reason: 'not-interested' | 'already-read') => {
    setCards((prev) => prev.filter((c) => c.sourceId !== rec.sourceId))
    void discoverService.dismiss(rec)
  }

  const handleOpen = (rec: Recommendation) => {
    void discoverService.openExternal(rec.url)
  }

  const subtitle =
    generatedAt !== null && cards.length > 0
      ? `Updated ${formatRelativeTime(generatedAt)} · ${cards.length} picks`
      : ''

  // Guard: if the feature is disabled in Settings, the route is unreachable
  // (belt-and-suspenders with the hidden Sidebar nav entry).
  if (!settings.enableDiscover) return <Navigate to="/" replace />

  return (
    <div className="discover-layout">
      <header className="discover-header">
        <button className="discover-back-btn" onClick={() => navigate('/')}>
          ← Library
        </button>
        <h1 className="discover-title">Discover</h1>
        {/* Only offer the header Refresh once there are cards to refresh — while the
            feed is empty (cold start / "no recommendations yet") the empty state
            carries its own "Find recommendations" call to action. */}
        {cards.length > 0 && (
          <button
            className="btn-primary discover-refresh-btn"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            {refreshing ? 'Refreshing…' : '⟳ Refresh'}
          </button>
        )}
      </header>

      <p className="discover-subtitle">{subtitle}</p>

      {loading ? (
        <div className="library-state-center">
          <p className="state-text">Loading…</p>
        </div>
      ) : loadError && cards.length === 0 ? (
        <div className="library-state-center">
          <p className="state-text">Failed to load recommendations: {loadError}</p>
        </div>
      ) : refreshing && cards.length === 0 ? (
        // Cold first refresh: fill the grid with shimmer placeholders so the long
        // uncached wait reads as "working" instead of a bare empty state.
        <div className="discover-grid">
          {Array.from({ length: PAGE_SIZE }, (_, i) => (
            <SkeletonCard key={`refresh-skeleton-${i}`} />
          ))}
        </div>
      ) : coldStart ? (
        <div className="empty-state">
          <h2 className="empty-state-title">Discover is learning your taste</h2>
          <p className="empty-state-body">
            Read and rate a few items in your library, then refresh — recommendations are built from
            what you like.
          </p>
        </div>
      ) : cards.length === 0 ? (
        <div className="empty-state">
          <h2 className="empty-state-title">No recommendations yet</h2>
          <p className="empty-state-body">
            Tap Find recommendations to discover fics and books based on the library you&apos;ve
            built.
          </p>
          <button className="btn-primary" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Find recommendations'}
          </button>
        </div>
      ) : (
        <>
          <div className="discover-grid">
            {cards.slice(0, visibleCount).map((rec) => (
              <RecommendationCard
                key={rec.sourceId}
                rec={rec}
                onAdd={handleAdd}
                onDismiss={handleDismiss}
                onOpen={handleOpen}
              />
            ))}
            {/* Shimmering placeholders so a fetch that takes a beat reads as "loading". */}
            {loadingMore &&
              Array.from({ length: 3 }, (_, i) => <SkeletonCard key={`skeleton-${i}`} />)}
          </div>
          {/* Sentinel: reveals more of the pool, then auto-loads the next page. */}
          <div ref={sentinelRef} className="discover-sentinel" aria-hidden="true" />
          {loadingMore && (
            <p className="discover-more-status">
              <span className="discover-spinner" aria-hidden="true" />
              Finding more…
            </p>
          )}
          {exhausted && (
            <p className="discover-more-status discover-more-end">You&apos;re all caught up</p>
          )}
        </>
      )}

      {showAddModal && (
        <AddItemModal
          initialUrl={pendingUrl}
          onClose={closeModal}
          onSaved={(item) => {
            if (pendingRec) removeCard(pendingRec.sourceId)
            addToast(`Added “${item.title}”`, 'success')
            closeModal()
          }}
          onJobStarted={(jobId, url) => {
            // Track the job globally so it shows in the Library sidebar and its
            // completion/error is handled regardless of the current route.
            startJob(jobId, url)
            if (pendingRec) removeCard(pendingRec.sourceId)
            addToast('Adding to library…', 'success')
            closeModal()
          }}
        />
      )}
    </div>
  )
}
