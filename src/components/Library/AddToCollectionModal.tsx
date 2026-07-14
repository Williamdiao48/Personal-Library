import { useState, useEffect, useMemo } from 'react'
import { libraryService, collectionService } from '../../services/library'
import type { Item } from '../../types'

interface Props {
  collectionId: string
  collectionName: string
  existingItemIds: Set<string>
  onAdd: (item: Item) => void
  onClose: () => void
}

const TYPE_LABELS: Record<string, string> = {
  article: 'Article',
  epub: 'EPUB',
  pdf: 'PDF',
}

export default function AddToCollectionModal({
  collectionId,
  collectionName,
  existingItemIds,
  onAdd,
  onClose,
}: Props) {
  const [allItems, setAllItems] = useState<Item[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [adding, setAdding] = useState<Set<string>>(new Set())
  const [added, setAdded] = useState<Set<string>>(new Set())

  useEffect(() => {
    libraryService
      .getAll()
      .then((items) => setAllItems(items.filter((i) => !existingItemIds.has(i.id))))
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load items.'))
      .finally(() => setLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allItems.filter((i) => !added.has(i.id))
    return allItems.filter(
      (i) =>
        !added.has(i.id) &&
        (i.title.toLowerCase().includes(q) || i.author?.toLowerCase().includes(q) || false),
    )
  }, [allItems, query, added])

  async function handleAdd(item: Item) {
    setAdding((prev) => new Set([...prev, item.id]))
    try {
      await collectionService.addItem(collectionId, item.id)
      setAdded((prev) => new Set([...prev, item.id]))
      onAdd(item)
    } finally {
      setAdding((prev) => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal atc-modal">
        <div className="atc-modal-header">
          <h2 className="atc-modal-title">Add to "{collectionName}"</h2>
          <button className="atc-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="library-search atc-search">
          <svg
            className="library-search-icon"
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden
          >
            <circle cx="6.5" cy="6.5" r="4.5" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" />
          </svg>
          <input
            className="library-search-input"
            type="text"
            placeholder="Search by title or author…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {query && (
            <button
              className="library-search-clear"
              onClick={() => setQuery('')}
              aria-label="Clear"
            >
              ✕
            </button>
          )}
        </div>

        <div className="atc-list">
          {loading ? (
            <p className="atc-empty">Loading…</p>
          ) : loadError ? (
            <p className="atc-empty">Failed to load items: {loadError}</p>
          ) : filteredItems.length === 0 ? (
            <p className="atc-empty">
              {query ? 'No matches.' : 'All library items are already in this collection.'}
            </p>
          ) : (
            filteredItems.map((item) => (
              <div key={item.id} className="atc-row">
                <div className="atc-row-info">
                  <span className="atc-row-title">{item.title}</span>
                  {item.author && <span className="atc-row-author">{item.author}</span>}
                </div>
                <span className="atc-row-type">
                  {TYPE_LABELS[item.content_type] ?? item.content_type}
                </span>
                <button
                  className="atc-add-btn"
                  onClick={() => handleAdd(item)}
                  disabled={adding.has(item.id)}
                >
                  {adding.has(item.id) ? '…' : '+ Add'}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
