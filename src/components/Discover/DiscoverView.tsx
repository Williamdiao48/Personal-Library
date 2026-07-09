import { useState, useEffect, useCallback } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { discoverService } from '../../services/discover'
import { useToast } from '../../contexts/ToastContext'
import { useSettings } from '../../contexts/SettingsContext'
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

export default function DiscoverView() {
  const navigate = useNavigate()
  const { addToast, updateToast } = useToast()
  const { settings } = useSettings()

  const [cards, setCards] = useState<Recommendation[]>([])
  const [generatedAt, setGeneratedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [coldStart, setColdStart] = useState(false)

  // Modal (Add to Library) — same parent-owned pattern as LibraryView.
  const [showAddModal, setShowAddModal] = useState(false)
  const [pendingUrl, setPendingUrl] = useState<string | undefined>(undefined)
  const closeModal = () => {
    setShowAddModal(false)
    setPendingUrl(undefined)
  }

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
      .finally(() => setLoading(false))
  }, [])

  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    const toastId = addToast('Finding recommendations…', 'info')
    try {
      const res = await discoverService.refresh()
      setCards(res.cards)
      setGeneratedAt(res.generatedAt)
      setColdStart(res.coldStart)
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
  }, [refreshing, addToast, updateToast])

  const handleAdd = (rec: Recommendation) => {
    setPendingUrl(rec.url)
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
        <button
          className="btn-primary discover-refresh-btn"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing ? 'Refreshing…' : '⟳ Refresh'}
        </button>
      </header>

      <p className="discover-subtitle">{subtitle}</p>

      {loading ? (
        <div className="library-state-center">
          <p className="state-text">Loading…</p>
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
            Tap Refresh to find fics and books based on the library you&apos;ve built.
          </p>
          <button className="btn-primary" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Find recommendations'}
          </button>
        </div>
      ) : (
        <div className="discover-grid">
          {cards.map((rec) => (
            <RecommendationCard
              key={rec.sourceId}
              rec={rec}
              onAdd={handleAdd}
              onDismiss={handleDismiss}
              onOpen={handleOpen}
            />
          ))}
        </div>
      )}

      {showAddModal && (
        <AddItemModal
          initialUrl={pendingUrl}
          onClose={closeModal}
          onSaved={(item) => {
            addToast(`Added “${item.title}”`, 'success')
            closeModal()
          }}
          onJobStarted={(_jobId, _url) => {
            addToast('Adding to library…', 'success')
            closeModal()
          }}
        />
      )}
    </div>
  )
}
