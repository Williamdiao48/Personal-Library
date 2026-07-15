import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { collectionService, libraryService } from '../../services/library'
import Sidebar from './Sidebar'
import type { Collection, Item } from '../../types'

type SortMode = 'az' | 'count'

export default function AuthorsView() {
  const navigate = useNavigate()

  const [allLibraryItems, setAllLibraryItems] = useState<Item[]>([])
  const [allCollections, setAllCollections] = useState<Collection[]>([])
  const [collectionItemCounts, setCollectionItemCounts] = useState<Record<string, number>>({})
  const [trashedCount, setTrashedCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('az')

  useEffect(() => {
    Promise.all([
      libraryService.getAll(),
      collectionService.getAll(),
      collectionService.getAllItemCollections(),
      libraryService.getTrashed(),
    ])
      .then(([allItems, cols, itemCols, trashed]) => {
        setAllLibraryItems(allItems)
        setAllCollections(cols)
        setTrashedCount(trashed.length)

        const colCounts: Record<string, number> = {}
        for (const { collection_id } of itemCols)
          colCounts[collection_id] = (colCounts[collection_id] ?? 0) + 1
        setCollectionItemCounts(colCounts)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load authors.'))
      .finally(() => setLoading(false))
  }, [])

  // ── Author list + counts (derived from the full library) ──────────
  // One row per distinct non-empty author, tallying every authored item
  // (a PDF and its derived EPUB each count — matches the library grid).
  const authors = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of allLibraryItems) {
      if (item.author) counts.set(item.author, (counts.get(item.author) ?? 0) + 1)
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count }))
  }, [allLibraryItems])

  const visibleAuthors = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q ? authors.filter((a) => a.name.toLowerCase().includes(q)) : authors
    const sorted = [...filtered]
    if (sortMode === 'count') {
      sorted.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name))
    }
    return sorted
  }, [authors, query, sortMode])

  // ── Sidebar collection management (mirrors TagsView) ──────────────
  const handleCollectionCreate = useCallback(async (name: string) => {
    const col = await collectionService.create(name)
    setAllCollections((prev) => [...prev, col].sort((a, b) => a.name.localeCompare(b.name)))
  }, [])

  const handleCollectionDelete = useCallback(async (colId: string) => {
    await collectionService.delete(colId)
    setAllCollections((prev) => prev.filter((c) => c.id !== colId))
  }, [])

  const handleCollectionRename = useCallback(async (colId: string, name: string) => {
    await collectionService.rename(colId, name)
    setAllCollections((prev) => prev.map((c) => (c.id === colId ? { ...c, name } : c)))
  }, [])

  const collectionMgmt = useMemo(
    () => ({
      collections: allCollections,
      itemCounts: collectionItemCounts,
      onCreate: handleCollectionCreate,
      onDelete: handleCollectionDelete,
      onRename: handleCollectionRename,
    }),
    [
      allCollections,
      collectionItemCounts,
      handleCollectionCreate,
      handleCollectionDelete,
      handleCollectionRename,
    ],
  )

  return (
    <div className="library-layout">
      <Sidebar
        collectionMgmt={collectionMgmt}
        captureJobs={[]}
        onDismissJob={() => {}}
        trashedCount={trashedCount}
      />

      <main className="library-main">
        <header className="library-header">
          <h1>
            Authors
            {!loading && (
              <span className="collection-count">
                · {authors.length} {authors.length === 1 ? 'author' : 'authors'}
              </span>
            )}
          </h1>
        </header>

        <div className="authors-view-body">
          {loading ? (
            <div className="library-state-center">
              <p className="state-text">Loading…</p>
            </div>
          ) : loadError ? (
            <div className="library-state-center">
              <p className="state-text">Failed to load authors: {loadError}</p>
            </div>
          ) : authors.length === 0 ? (
            <div className="authors-empty">
              No authors yet. Set an author on an item to see it here.
            </div>
          ) : (
            <>
              <div className="authors-controls">
                <input
                  className="authors-search"
                  type="text"
                  placeholder="Search authors…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <div className="authors-sort" role="group" aria-label="Sort authors">
                  <button
                    className={`authors-sort-btn${sortMode === 'az' ? ' active' : ''}`}
                    onClick={() => setSortMode('az')}
                  >
                    A–Z
                  </button>
                  <button
                    className={`authors-sort-btn${sortMode === 'count' ? ' active' : ''}`}
                    onClick={() => setSortMode('count')}
                  >
                    By count
                  </button>
                </div>
              </div>

              {visibleAuthors.length === 0 ? (
                <div className="authors-empty">No authors match "{query}".</div>
              ) : (
                <div className="authors-list">
                  {visibleAuthors.map(({ name, count }) => (
                    <button
                      key={name}
                      className="author-row"
                      onClick={() => navigate(`/?author=${encodeURIComponent(name)}`)}
                      title={`Browse ${count} item${count !== 1 ? 's' : ''} by ${name}`}
                    >
                      <span className="author-row-name">{name}</span>
                      <span className="author-row-count">
                        {count} {count === 1 ? 'item' : 'items'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}
