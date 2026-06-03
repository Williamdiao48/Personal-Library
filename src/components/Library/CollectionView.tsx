import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  DndContext, DragOverlay, closestCenter,
  type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, arrayMove, rectSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { collectionService, libraryService } from '../../services/library'
import { tagService } from '../../services/library'
import ItemCard from './ItemCard'
import Sidebar from './Sidebar'
import TagsModal from './TagsModal'
import ReviewModal from './ReviewModal'
import AddToCollectionModal from './AddToCollectionModal'
import CustomSelect from '../ui/CustomSelect'
import MultiSelect from '../ui/MultiSelect'
import type { Item, Tag, Collection, ReadingStatus } from '../../types'

type CollectionSortBy = 'custom' | 'title' | 'date_saved' | 'last_read' | 'word_count' | 'progress'

// ── Drag handle SVG (6-dot grip) ─────────────────────────────────────────────

function GripIcon() {
  return (
    <svg width="12" height="18" viewBox="0 0 12 18" fill="currentColor" aria-hidden>
      <circle cx="3" cy="3"  r="1.5"/>
      <circle cx="9" cy="3"  r="1.5"/>
      <circle cx="3" cy="9"  r="1.5"/>
      <circle cx="9" cy="9"  r="1.5"/>
      <circle cx="3" cy="15" r="1.5"/>
      <circle cx="9" cy="15" r="1.5"/>
    </svg>
  )
}

// ── SortableItemCard wrapper ──────────────────────────────────────────────────

interface SortableCardProps {
  item: Item
  tags: Tag[]
  dragEnabled: boolean
  onClick: (e: React.MouseEvent) => void
  onDelete: () => Promise<void>
  onEditTags: () => void
  onRemoveFromCollection: () => void
  onTitleChange: (title: string) => void
  onAuthorChange: (author: string | null) => void
  onStatusChange: (status: ReadingStatus | null) => void
  onCoverChange: (path: string) => void
  onTagClick: (tagId: string) => void
  onAuthorClick: (author: string) => void
  onRatingChange: (rating: number | null) => void
  onWriteReview: () => void
}

function SortableItemCard({ item, dragEnabled, ...cardProps }: SortableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled: !dragEnabled })

  return (
    <div
      ref={setNodeRef}
      className={`sortable-card-wrapper${isDragging ? ' sortable-card-wrapper--dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {dragEnabled && (
        <div className="drag-handle" {...attributes} {...listeners} title="Drag to reorder">
          <GripIcon />
        </div>
      )}
      <ItemCard item={item} {...cardProps} />
    </div>
  )
}

// ── CollectionView ────────────────────────────────────────────────────────────

export default function CollectionView() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  // ── Data ────────────────────────────────────────────────────────
  const [collection, setCollection]       = useState<Collection | null>(null)
  const [items, setItems]                 = useState<Item[]>([])
  const [allTags, setAllTags]             = useState<Tag[]>([])
  const [itemTagsMap, setItemTagsMap]     = useState<Record<string, Tag[]>>({})
  const [itemTagIdsMap, setItemTagIdsMap] = useState<Record<string, Set<string>>>({})
  const [allCollections, setAllCollections]             = useState<Collection[]>([])
  const [collectionItemCounts, setCollectionItemCounts] = useState<Record<string, number>>({})
  const [trashedCount, setTrashedCount]   = useState(0)
  const [allLibraryItems, setAllLibraryItems] = useState<Item[]>([])
  const [loading, setLoading]             = useState(true)
  const [loadError, setLoadError]         = useState<string | null>(null)

  // ── Filter / search / sort ───────────────────────────────────────
  const [searchQuery, setSearchQuery]     = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [sortBy, setSortBy]               = useState<CollectionSortBy>('custom')
  const [typeFilters, setTypeFilters]     = useState<string[]>([])
  const [tagFilters, setTagFilters]       = useState<string[]>([])
  const [authorFilters, setAuthorFilters] = useState<string[]>([])

  // ── Drag ─────────────────────────────────────────────────────────
  const [activeId, setActiveId]           = useState<string | null>(null)

  // ── Grid sizing (mirrors LibraryView so card widths are identical) ─
  const mainRef       = useRef<HTMLElement>(null)
  const GRID_GAP      = 20
  const MIN_COL_WIDTH = 160
  const [columnsPerRow, setColumnsPerRow] = useState(4)
  const [colWidth, setColWidth]           = useState(MIN_COL_WIDTH)

  useLayoutEffect(() => {
    const el = mainRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth
      const cols = Math.max(1, Math.floor((width + GRID_GAP) / (MIN_COL_WIDTH + GRID_GAP)))
      setColumnsPerRow(cols)
      setColWidth(Math.floor((width - (cols - 1) * GRID_GAP) / cols))
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // ── Modals ───────────────────────────────────────────────────────
  const [showAddModal, setShowAddModal]               = useState(false)
  const [tagsModalItem, setTagsModalItem]   = useState<Item | null>(null)
  const [reviewModalItem, setReviewModalItem] = useState<Item | null>(null)

  // ── Debounce search ─────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 300)
    return () => clearTimeout(t)
  }, [searchQuery])

  // ── Load ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!id) return
    Promise.all([
      collectionService.getAll(),
      collectionService.getItems(id),
      tagService.getAll(),
      libraryService.getAllItemTags(),
      collectionService.getAllItemCollections(),
      libraryService.getTrashed(),
      libraryService.getAll(),
    ]).then(([cols, its, tags, itemTags, itemCols, trashed, allItems]) => {
      setCollection(cols.find(c => c.id === id) ?? null)
      setAllCollections(cols)
      setAllTags(tags)
      setItems(its)
      setAllLibraryItems(allItems)
      setTrashedCount(trashed.length)

      const tagById = Object.fromEntries(tags.map(t => [t.id, t]))
      const tagsMap: Record<string, Tag[]> = {}
      const tagIdsMap: Record<string, Set<string>> = {}
      for (const { item_id, tag_id } of itemTags) {
        if (!tagsMap[item_id]) { tagsMap[item_id] = []; tagIdsMap[item_id] = new Set() }
        if (tagById[tag_id]) tagsMap[item_id].push(tagById[tag_id])
        tagIdsMap[item_id].add(tag_id)
      }
      setItemTagsMap(tagsMap)
      setItemTagIdsMap(tagIdsMap)

      const counts: Record<string, number> = {}
      for (const { collection_id } of itemCols) {
        counts[collection_id] = (counts[collection_id] ?? 0) + 1
      }
      setCollectionItemCounts(counts)

      if (its.length > 0) collectionService.reorderItems(id, its.map(i => i.id))
    }).catch(err => {
      setLoadError(err instanceof Error ? err.message : 'Failed to load collection.')
    }).finally(() => setLoading(false))
  }, [id])

  async function refreshTagData() {
    const [tags, itemTags] = await Promise.all([
      tagService.getAll(),
      libraryService.getAllItemTags(),
    ])
    const tagById = Object.fromEntries(tags.map(t => [t.id, t]))
    const tagsMap: Record<string, Tag[]> = {}
    const tagIdsMap: Record<string, Set<string>> = {}
    for (const { item_id, tag_id } of itemTags) {
      if (!tagsMap[item_id]) { tagsMap[item_id] = []; tagIdsMap[item_id] = new Set() }
      if (tagById[tag_id]) tagsMap[item_id].push(tagById[tag_id])
      tagIdsMap[item_id].add(tag_id)
    }
    setAllTags(tags)
    setItemTagsMap(tagsMap)
    setItemTagIdsMap(tagIdsMap)
  }


  // ── Sidebar collection handlers ──────────────────────────────────
  const handleCollectionCreate = useCallback(async (name: string) => {
    const col = await collectionService.create(name)
    setAllCollections(prev => [...prev, col].sort((a, b) => a.name.localeCompare(b.name)))
  }, [])

  const handleCollectionDelete = useCallback(async (colId: string) => {
    await collectionService.delete(colId)
    setAllCollections(prev => prev.filter(c => c.id !== colId))
    if (colId === id) navigate('/')
  }, [id, navigate])

  const handleCollectionRename = useCallback(async (colId: string, name: string) => {
    await collectionService.rename(colId, name)
    setAllCollections(prev => prev.map(c => c.id === colId ? { ...c, name } : c))
    if (colId === id) setCollection(prev => prev ? { ...prev, name } : prev)
  }, [id])

  const collectionMgmt = useMemo(() => ({
    collections: allCollections,
    itemCounts:  collectionItemCounts,
    onCreate:    handleCollectionCreate,
    onDelete:    handleCollectionDelete,
    onRename:    handleCollectionRename,
  }), [allCollections, collectionItemCounts, handleCollectionCreate, handleCollectionDelete, handleCollectionRename])

  // ── Sidebar author data (full library, not just this collection) ──
  const sidebarAuthors = useMemo(() =>
    [...new Set(allLibraryItems.map(i => i.author).filter((a): a is string => !!a))].sort()
  , [allLibraryItems])

  const sidebarAuthorCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of allLibraryItems) if (item.author) counts[item.author] = (counts[item.author] ?? 0) + 1
    return counts
  }, [allLibraryItems])

  // ── Filter + sort pipeline ───────────────────────────────────────
  const allAuthors = useMemo(() => {
    const set = new Set<string>()
    for (const item of items) if (item.author) set.add(item.author)
    return [...set].sort()
  }, [items])

  const filteredItems = useMemo(() => {
    let result = items

    if (typeFilters.length > 0)
      result = result.filter(i => typeFilters.includes(i.content_type))

    if (tagFilters.length > 0)
      result = result.filter(i => (itemTagsMap[i.id] ?? []).some(t => tagFilters.includes(t.id)))

    if (authorFilters.length > 0)
      result = result.filter(i => i.author != null && authorFilters.includes(i.author))

    if (debouncedQuery.trim()) {
      const q = debouncedQuery.trim().toLowerCase()
      result = result.filter(i =>
        i.title.toLowerCase().includes(q) ||
        i.author?.toLowerCase().includes(q) ||
        (itemTagsMap[i.id] ?? []).some(t => t.name.toLowerCase().includes(q))
      )
    }

    return result
  }, [items, typeFilters, tagFilters, authorFilters, debouncedQuery, itemTagsMap])

  const displayedItems = useMemo(() => {
    if (sortBy === 'custom') return filteredItems
    const result = [...filteredItems]
    if (sortBy === 'title')
      result.sort((a, b) => a.title.localeCompare(b.title))
    else if (sortBy === 'date_saved')
      result.sort((a, b) => (b.date_saved ?? 0) - (a.date_saved ?? 0))
    else if (sortBy === 'last_read')
      result.sort((a, b) => (b.last_read_at ?? 0) - (a.last_read_at ?? 0))
    else if (sortBy === 'word_count')
      result.sort((a, b) => (b.word_count ?? 0) - (a.word_count ?? 0))
    else if (sortBy === 'progress')
      result.sort((a, b) => (b.scroll_position ?? 0) - (a.scroll_position ?? 0))
    return result
  }, [filteredItems, sortBy])

  // Drag only works when no filters/search are active and sort is custom
  const hasActiveFilters = typeFilters.length > 0 || tagFilters.length > 0 ||
    authorFilters.length > 0 || !!debouncedQuery.trim()
  const dragEnabled = sortBy === 'custom' && !hasActiveFilters

  const hasFilters = typeFilters.length > 0 || tagFilters.length > 0 || authorFilters.length > 0

  // ── Drag handlers ────────────────────────────────────────────────
  function handleDragStart({ active }: DragStartEvent) { setActiveId(active.id as string) }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null)
    if (!over || active.id === over.id) return
    setItems(prev => {
      const oldIndex = prev.findIndex(i => i.id === active.id)
      const newIndex = prev.findIndex(i => i.id === over.id)
      const next = arrayMove(prev, oldIndex, newIndex)
      collectionService.reorderItems(id!, next.map(i => i.id))
      return next
    })
  }

  // ── Item mutations ───────────────────────────────────────────────
  const updateItem = useCallback((itemId: string, patch: Partial<Item>) => {
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, ...patch } : i))
  }, [])

  const activeItem = activeId ? items.find(i => i.id === activeId) ?? null : null
  const existingItemIds = useMemo(() => new Set(items.map(i => i.id)), [items])

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="library-layout">
      <Sidebar
        collectionMgmt={collectionMgmt}
        authors={sidebarAuthors}
        authorItemCounts={sidebarAuthorCounts}
        captureJobs={[]}
        onDismissJob={() => {}}
        trashedCount={trashedCount}
      />

      <main className="library-main" ref={mainRef}>
        <header className="library-header">
          <h1>
            {collection?.name ?? '…'}
            {!loading && (
              <span className="collection-count"> · {items.length} {items.length === 1 ? 'item' : 'items'}</span>
            )}
          </h1>
          <div className="library-header-controls">
            <div className="library-search">
              <svg className="library-search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                <circle cx="6.5" cy="6.5" r="4.5" />
                <line x1="10.5" y1="10.5" x2="14" y2="14" />
              </svg>
              <input
                className="library-search-input"
                type="text"
                placeholder="Search this collection…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button className="library-search-clear" onClick={() => setSearchQuery('')} aria-label="Clear search">✕</button>
              )}
            </div>
            <CustomSelect
              label="Sort"
              includePlaceholder={false}
              value={sortBy}
              onChange={val => setSortBy(val as CollectionSortBy)}
              options={[
                { value: 'custom',     label: 'Custom order' },
                { value: 'date_saved', label: 'Date saved'   },
                { value: 'last_read',  label: 'Last read'    },
                { value: 'title',      label: 'Title'        },
                { value: 'word_count', label: 'Word count'   },
                { value: 'progress',   label: 'Progress'     },
              ]}
            />
            <button className="btn-primary" onClick={() => setShowAddModal(true)}>+ Add</button>
          </div>
        </header>

        <div className="library-filter-bar">
          <MultiSelect
            label="Type"
            values={typeFilters}
            onChange={setTypeFilters}
            options={[
              { value: 'article', label: 'Article' },
              { value: 'epub',    label: 'EPUB'    },
              { value: 'pdf',     label: 'PDF'     },
            ]}
          />
          {allTags.length > 0 && (
            <MultiSelect
              label="Tag"
              values={tagFilters}
              onChange={setTagFilters}
              options={allTags.map(t => ({ value: t.id, label: t.name }))}
            />
          )}
          {allAuthors.length > 0 && (
            <MultiSelect
              label="Author"
              values={authorFilters}
              onChange={setAuthorFilters}
              options={allAuthors.map(a => ({ value: a, label: a }))}
            />
          )}
          {dragEnabled && (
            <span className="collection-drag-hint">Drag cards to reorder</span>
          )}
          {sortBy === 'custom' && hasActiveFilters && (
            <span className="collection-drag-hint collection-drag-hint--muted">Clear filters to reorder</span>
          )}
          {hasFilters && (
            <button
              className="library-filter-clear"
              onClick={() => { setTypeFilters([]); setTagFilters([]); setAuthorFilters([]) }}
            >
              Clear filters
            </button>
          )}
        </div>

        {loading ? (
          <div className="library-state-center"><p className="state-text">Loading…</p></div>
        ) : loadError ? (
          <div className="library-state-center"><p className="state-text">Failed to load collection: {loadError}</p></div>
        ) : items.length === 0 ? (
          <div className="library-state-center">
            <div className="empty-state">
              <h2 className="empty-state-title">This collection is empty</h2>
              <p className="empty-state-body">Click "+ Add" to add items from your library.</p>
              <button className="btn-primary" onClick={() => setShowAddModal(true)}>+ Add items</button>
            </div>
          </div>
        ) : displayedItems.length === 0 ? (
          <div className="library-state-center"><p className="state-text">No items match your filters.</p></div>
        ) : (
          <DndContext
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={displayedItems.map(i => i.id)} strategy={rectSortingStrategy}>
              <div className="collection-grid" style={{ gridTemplateColumns: `repeat(${columnsPerRow}, ${colWidth}px)` }}>
                {displayedItems.map(item => (
                  <SortableItemCard
                    key={item.id}
                    item={item}
                    tags={itemTagsMap[item.id] ?? []}
                    dragEnabled={dragEnabled}
                    onClick={() => navigate(`/read/${item.id}`)}
                    onDelete={async () => {
                      await libraryService.softDelete(item.id)
                      setItems(prev => prev.filter(i => i.id !== item.id))
                    }}
                    onEditTags={() => setTagsModalItem(item)}
                    onRemoveFromCollection={async () => {
                      await collectionService.removeItem(id!, item.id)
                      setItems(prev => prev.filter(i => i.id !== item.id))
                    }}
                    onTitleChange={(title) => {
                      libraryService.setTitle(item.id, title)
                      updateItem(item.id, { title })
                    }}
                    onAuthorChange={(author) => {
                      libraryService.setAuthor(item.id, author)
                      updateItem(item.id, { author: author ?? undefined })
                    }}
                    onStatusChange={async (status) => {
                      await libraryService.setStatus(item.id, status)
                      updateItem(item.id, { status })
                    }}
                    onCoverChange={(cover_path) => updateItem(item.id, { cover_path })}
                    onTagClick={(tagId) => navigate(`/?tag=${tagId}`)}
                    onAuthorClick={(author) => navigate(`/?author=${encodeURIComponent(author)}`)}
                    onRatingChange={(rating) => {
                      libraryService.setRating(item.id, rating)
                      updateItem(item.id, { rating })
                    }}
                    onWriteReview={() => setReviewModalItem(item)}
                  />
                ))}
              </div>
            </SortableContext>

            <DragOverlay>
              {activeItem ? (
                <div className="drag-overlay-card">
                  <ItemCard
                    item={activeItem}
                    tags={itemTagsMap[activeItem.id] ?? []}
                    onClick={() => {}} onDelete={async () => {}} onEditTags={() => {}}
                    onTitleChange={() => {}} onAuthorChange={() => {}}
                    onStatusChange={() => {}} onCoverChange={() => {}} onTagClick={() => {}} onAuthorClick={() => {}}
                    onRatingChange={() => {}} onWriteReview={() => {}}
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </main>

      {showAddModal && collection && (
        <AddToCollectionModal
          collectionId={id!}
          collectionName={collection.name}
          existingItemIds={existingItemIds}
          onAdd={(item) => setItems(prev => [...prev, item])}
          onClose={() => setShowAddModal(false)}
        />
      )}

      {tagsModalItem && (
        <TagsModal
          itemId={tagsModalItem.id}
          itemTitle={tagsModalItem.title}
          allTags={allTags}
          itemTagIds={itemTagIdsMap[tagsModalItem.id] ?? new Set()}
          onClose={() => { setTagsModalItem(null); refreshTagData() }}
        />
      )}


      {reviewModalItem && (
        <ReviewModal
          item={reviewModalItem}
          onClose={() => setReviewModalItem(null)}
          onSave={(review, rating) => {
            updateItem(reviewModalItem.id, { review, rating })
            setReviewModalItem(null)
          }}
        />
      )}
    </div>
  )
}
