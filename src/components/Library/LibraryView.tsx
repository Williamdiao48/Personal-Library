import { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { libraryService, tagService, collectionService } from '../../services/library'
import type { Item, Tag, Collection, RefreshResult, CaptureJob, ReadingStatus } from '../../types'
import { getEffectiveStatus } from '../../types'
import { useSettings } from '../../contexts/SettingsContext'
import { useToast } from '../../contexts/ToastContext'
import type { SortBy } from '../../contexts/SettingsContext'
import ItemCard from './ItemCard'
import Sidebar from './Sidebar'
import AddItemModal from '../Capture/AddItemModal'
import AppendModal from '../Capture/AppendModal'
import TagsModal from './TagsModal'
import CollectionsModal from './CollectionsModal'
import CustomSelect from '../ui/CustomSelect'
import MultiSelect from '../ui/MultiSelect'

export default function LibraryView() {
  const { settings, updateSettings } = useSettings()
  const { addToast, updateToast }    = useToast()

  const [items, setItems]                   = useState<Item[]>([])
  const [loading, setLoading]               = useState(true)
  const [loadError, setLoadError]           = useState<string | null>(null)
  const [allTags, setAllTags]               = useState<Tag[]>([])
  const [itemTagsMap, setItemTagsMap]       = useState<Record<string, Tag[]>>({})
  const [allCollections, setAllCollections] = useState<Collection[]>([])
  const [itemCollectionsMap, setItemCollectionsMap] = useState<Record<string, Collection[]>>({})
  const [showAddModal, setShowAddModal]     = useState(false)
  const [pendingUrl, setPendingUrl]         = useState<string | undefined>(undefined)
  const [tagModalItem, setTagModalItem]     = useState<Item | null>(null)
  const [colModalItem, setColModalItem]     = useState<Item | null>(null)
  const [formatPrefs, setFormatPrefs]       = useState<Record<string, 'epub' | 'pdf'>>({})
  const [searchQuery, setSearchQuery]       = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selectedIds, setSelectedIds]       = useState<Set<string>>(new Set())
  const [showBulkTag, setShowBulkTag]       = useState(false)
  const [showBulkCol, setShowBulkCol]       = useState(false)
  const [bulkDeleting, setBulkDeleting]         = useState(false)
  const [bulkDeleteConfirming, setBulkDeleteConfirming] = useState(false)
  const [captureJobs, setCaptureJobs]       = useState<CaptureJob[]>([])
  const [appendModalItem, setAppendModalItem] = useState<Item | null>(null)

  const sortBy = settings.defaultSort

  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const filter           = searchParams.get('filter')
  const tagFilters       = searchParams.getAll('tag')
  const authorFilters    = searchParams.getAll('author')
  const typeFilters      = searchParams.getAll('type')
  const collectionFilter = searchParams.get('collection')
  const tagFiltersKey    = tagFilters.join(',')
  const authorFiltersKey = authorFilters.join(',')
  const typeFiltersKey   = typeFilters.join(',')

  useEffect(() => {
    Promise.all([
      libraryService.getAll(),
      tagService.getAll(),
      libraryService.getAllItemTags(),
      collectionService.getAll(),
      collectionService.getAllItemCollections(),
    ]).then(([itemsData, tagsData, rawItemTags, collectionsData, rawItemCols]) => {
      setItems(itemsData)
      setAllTags(tagsData)
      setItemTagsMap(buildTagsMap(rawItemTags))
      setAllCollections(collectionsData)
      setItemCollectionsMap(buildCollectionsMap(collectionsData, rawItemCols))
    }).catch(err => {
      setLoadError(err instanceof Error ? err.message : 'Failed to load library.')
    }).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    return window.api.onRequestCapture((url) => {
      setPendingUrl(url)
      setShowAddModal(true)
    })
  }, [])

  // Debounce search so every keystroke doesn't trigger a full filter+sort pass
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 300)
    return () => clearTimeout(id)
  }, [searchQuery])

  // ── Capture job management ─────────────────────────────────────

  // Parse "Fetching chapter N of M…" or "Found M chapters…" from progress msg
  function parseChapterProgress(msg: string): { chapter?: number; total?: number } {
    const chMatch = /chapter (\d+) of (\d+)/i.exec(msg)
    if (chMatch) return { chapter: parseInt(chMatch[1]), total: parseInt(chMatch[2]) }
    const totalMatch = /\b(\d+) chapters?\b/i.exec(msg)
    if (totalMatch) return { total: parseInt(totalMatch[1]) }
    return {}
  }

  function handleJobStarted(jobId: string, url: string) {
    setCaptureJobs(prev => [...prev, {
      id: jobId, url, status: 'running', msg: 'Starting…',
      chapter: null, total: null, startedAt: Date.now(),
    }])
  }

  function dismissJob(jobId: string) {
    setCaptureJobs(prev => prev.filter(j => j.id !== jobId))
  }

  useEffect(() => {
    const offProgress = window.api.onCaptureProgress(({ jobId, msg }) => {
      setCaptureJobs(prev => prev.map(j => {
        if (j.id !== jobId) return j
        const { chapter, total } = parseChapterProgress(msg)
        return {
          ...j,
          msg,
          chapter: chapter ?? j.chapter,
          total:   total   ?? j.total,
        }
      }))
    })

    const offComplete = window.api.onCaptureComplete(async ({ jobId, result }) => {
      try {
        const item = await libraryService.getById(result.id)
        if (item) {
          setItems(prev => {
            const exists = prev.some(i => i.id === item.id)
            return exists
              ? prev.map(i => i.id === item.id ? item : i)
              : [item, ...prev]
          })
        }
      } catch { /* item fetch failing shouldn't break the job indicator */ }

      // Mark done, auto-dismiss after 4 s
      setCaptureJobs(prev => prev.map(j =>
        j.id === jobId ? { ...j, status: 'done', title: result.title } : j
      ))
      setTimeout(() => dismissJob(jobId), 4000)
    })

    const offError = window.api.onCaptureError(({ jobId, error }) => {
      setCaptureJobs(prev => prev.map(j =>
        j.id === jobId ? { ...j, status: 'error', error } : j
      ))
    })

    return () => { offProgress(); offComplete(); offError() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Map builders ──────────────────────────────────────────────

  function buildTagsMap(rows: { item_id: string; tag_id: string; name: string; color: string }[]) {
    const map: Record<string, Tag[]> = {}
    for (const { item_id, tag_id, name, color } of rows) {
      if (!map[item_id]) map[item_id] = []
      map[item_id].push({ id: tag_id, name, color })
    }
    return map
  }

  function buildCollectionsMap(
    cols: Collection[],
    rows: { item_id: string; collection_id: string; name: string }[],
  ) {
    const colById: Record<string, Collection> = {}
    for (const c of cols) colById[c.id] = c

    const map: Record<string, Collection[]> = {}
    for (const { item_id, collection_id } of rows) {
      if (!map[item_id]) map[item_id] = []
      if (colById[collection_id]) map[item_id].push(colById[collection_id])
    }
    return map
  }

  // ── Tag data refresh (after TagsModal closes) ─────────────────

  async function refreshTagData() {
    const [tagsData, rawItemTags] = await Promise.all([
      tagService.getAll(),
      libraryService.getAllItemTags(),
    ])
    setAllTags(tagsData)
    setItemTagsMap(buildTagsMap(rawItemTags))
  }

  // ── Collection data refresh (after CollectionsModal closes) ───

  async function refreshCollectionData() {
    const [collectionsData, rawItemCols] = await Promise.all([
      collectionService.getAll(),
      collectionService.getAllItemCollections(),
    ])
    setAllCollections(collectionsData)
    setItemCollectionsMap(buildCollectionsMap(collectionsData, rawItemCols))
  }

  // ── Format-variant group maps ─────────────────────────────────
  // companionBySourceId: PDF id → the EPUB derived from it (if both are in the library)
  // groupedEpubIds:      EPUBs that should be hidden as standalone cards (they're grouped)

  const companionBySourceId = useMemo(() => {
    const map = new Map<string, Item>()
    for (const item of items) {
      if (item.derived_from) map.set(item.derived_from, item)
    }
    return map
  }, [items])

  const groupedEpubIds = useMemo(() => {
    const sourceIds = new Set(items.map(i => i.id))
    return new Set(
      items
        .filter(i => i.derived_from && sourceIds.has(i.derived_from))
        .map(i => i.id)
    )
  }, [items])

  // ── Authors list + counts ─────────────────────────────────────

  const allAuthors = useMemo(() =>
    [...new Set(items.map(i => i.author).filter((a): a is string => !!a))].sort()
  , [items])

  const authorItemCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of items) {
      if (!groupedEpubIds.has(item.id) && item.author) {
        counts[item.author] = (counts[item.author] ?? 0) + 1
      }
    }
    return counts
  }, [items, groupedEpubIds])

  // ── Collection item-count map ─────────────────────────────────
  // Computed client-side so it stays accurate without extra DB calls.

  const collectionItemCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const cols of Object.values(itemCollectionsMap)) {
      for (const col of cols) {
        counts[col.id] = (counts[col.id] ?? 0) + 1
      }
    }
    return counts
  }, [itemCollectionsMap])

  // ── Format preference (per grouped card, persisted in localStorage) ──────────
  // Key: source PDF item ID. Value: 'epub' (default) | 'pdf'.

  useEffect(() => {
    const prefs: Record<string, 'epub' | 'pdf'> = {}
    for (const sourceId of companionBySourceId.keys()) {
      const stored = localStorage.getItem(`format-pref-${sourceId}`)
      if (stored === 'pdf') prefs[sourceId] = 'pdf'
    }
    setFormatPrefs(prefs)
  }, [companionBySourceId])

  function handleTogglePreferred(sourceId: string) {
    const current = formatPrefs[sourceId] ?? 'epub'
    const next = current === 'epub' ? 'pdf' : 'epub'
    localStorage.setItem(`format-pref-${sourceId}`, next)
    setFormatPrefs(prev => ({ ...prev, [sourceId]: next }))
  }

  // ── Collection mutation handlers (passed to Sidebar) ─────────

  async function handleStatusChange(itemId: string, status: ReadingStatus | null) {
    await libraryService.setStatus(itemId, status)
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, status } : i))
  }

  async function handleCollectionCreate(name: string) {
    const col = await collectionService.create(name)
    setAllCollections(prev => [...prev, col].sort((a, b) => a.name.localeCompare(b.name)))
  }

  async function handleCollectionDelete(id: string) {
    await collectionService.delete(id)
    setAllCollections(prev => prev.filter(c => c.id !== id))
    setItemCollectionsMap(prev => {
      const next: Record<string, Collection[]> = {}
      for (const [itemId, cols] of Object.entries(prev)) {
        next[itemId] = cols.filter(c => c.id !== id)
      }
      return next
    })
    // If currently filtered by this collection, clear the filter
    if (collectionFilter === id) {
      const next = new URLSearchParams(searchParams)
      next.delete('collection')
      setSearchParams(next)
    }
  }

  async function handleCollectionRename(id: string, name: string) {
    await collectionService.rename(id, name)
    setAllCollections(prev =>
      prev.map(c => c.id === id ? { ...c, name } : c)
          .sort((a, b) => a.name.localeCompare(b.name))
    )
    setItemCollectionsMap(prev => {
      const next: Record<string, Collection[]> = {}
      for (const [itemId, cols] of Object.entries(prev)) {
        next[itemId] = cols.map(c => c.id === id ? { ...c, name } : c)
      }
      return next
    })
  }

  // ── Bulk selection ───────────────────────────────────────────

  const displayedItemIdsRef = useRef<string[]>([])
  const lastAnchorRef       = useRef<string | null>(null)

  // ── Virtual grid ─────────────────────────────────────────────────
  const mainRef        = useRef<HTMLElement>(null)
  const GRID_GAP       = 20
  const MIN_COL_WIDTH  = 160
  const [columnsPerRow, setColumnsPerRow] = useState(4)
  const [colWidth, setColWidth]           = useState(MIN_COL_WIDTH)

  useLayoutEffect(() => {
    const el = mainRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth
      // Mirror CSS: repeat(auto-fill, minmax(MIN_COL_WIDTH, 1fr))
      const cols = Math.max(1, Math.floor((width + GRID_GAP) / (MIN_COL_WIDTH + GRID_GAP)))
      setColumnsPerRow(cols)
      setColWidth(Math.floor((width - (cols - 1) * GRID_GAP) / cols))
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  function clearSelection() {
    setSelectedIds(new Set())
    setShowBulkTag(false)
    setShowBulkCol(false)
    setBulkDeleteConfirming(false)
    lastAnchorRef.current = null
  }

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(displayedItemIdsRef.current))
    lastAnchorRef.current = displayedItemIdsRef.current[0] ?? null
  }, [])

  function handleCardClick(itemId: string, e: React.MouseEvent, navigateTo: () => void) {
    e.stopPropagation()
    if (e.shiftKey) {
      e.preventDefault()
      const anchor = lastAnchorRef.current
      if (!anchor || selectedIds.size === 0) {
        // First selection — anchor this card
        setSelectedIds(new Set([itemId]))
        lastAnchorRef.current = itemId
      } else {
        // Range select from anchor to clicked card using current display order
        const ids    = displayedItemIdsRef.current
        const aIdx   = ids.indexOf(anchor)
        const bIdx   = ids.indexOf(itemId)
        if (aIdx === -1 || bIdx === -1) {
          // Anchor or target fell out of the filtered list — just toggle
          setSelectedIds(prev => {
            const next = new Set(prev)
            next.has(itemId) ? next.delete(itemId) : next.add(itemId)
            return next
          })
        } else {
          const [lo, hi] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx]
          setSelectedIds(new Set(ids.slice(lo, hi + 1)))
        }
        // Anchor stays fixed so extending works correctly
      }
    } else {
      // Plain click — always navigate and clear any selection
      clearSelection()
      navigateTo()
    }
  }

  // Cmd+A selects all visible items
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        selectAll()
      }
      if (e.key === 'Escape') clearSelection()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [selectAll])

  async function handleBulkDelete() {
    if (bulkDeleting) return
    const ids = [...selectedIds]
    setBulkDeleting(true)
    try {
      for (const id of ids) {
        const companion = companionBySourceId.get(id)
        if (companion) await libraryService.delete(companion.id)
        await libraryService.delete(id)
      }
      setItems(prev => prev.filter(i => {
        if (ids.includes(i.id)) return false
        // also remove companions
        const src = i.derived_from
        return !src || !ids.includes(src)
      }))
      clearSelection()
    } finally {
      setBulkDeleting(false)
      setBulkDeleteConfirming(false)
    }
  }

  async function handleBulkAddTag(tagId: string) {
    const tag = allTags.find(t => t.id === tagId)
    if (!tag) return
    const ids = [...selectedIds]
    for (const id of ids) {
      const companion  = companionBySourceId.get(id)
      const editableId = companion?.id ?? id
      const currentTags = (itemTagsMap[editableId] ?? []).map(t => t.id)
      if (!currentTags.includes(tagId)) {
        await tagService.setForItem(editableId, [...currentTags, tagId])
      }
    }
    // Update only affected entries rather than re-fetching the entire map
    setItemTagsMap(prev => {
      const next = { ...prev }
      for (const id of ids) {
        const editableId = (companionBySourceId.get(id)?.id ?? id)
        const current = next[editableId] ?? []
        if (!current.some(t => t.id === tagId)) next[editableId] = [...current, tag]
      }
      return next
    })
    setShowBulkTag(false)
  }

  async function handleBulkRemoveTag(tagId: string) {
    const ids = [...selectedIds]
    for (const id of ids) {
      const companion  = companionBySourceId.get(id)
      const editableId = companion?.id ?? id
      const currentTags = (itemTagsMap[editableId] ?? []).map(t => t.id)
      await tagService.setForItem(editableId, currentTags.filter(t => t !== tagId))
    }
    // Update only affected entries rather than re-fetching the entire map
    setItemTagsMap(prev => {
      const next = { ...prev }
      for (const id of ids) {
        const editableId = (companionBySourceId.get(id)?.id ?? id)
        next[editableId] = (next[editableId] ?? []).filter(t => t.id !== tagId)
      }
      return next
    })
    setShowBulkTag(false)
  }

  async function handleBulkAddCollection(colId: string) {
    const col = allCollections.find(c => c.id === colId)
    if (!col) return
    const ids = [...selectedIds]
    for (const id of ids) {
      const companion  = companionBySourceId.get(id)
      const editableId = companion?.id ?? id
      const currentCols = (itemCollectionsMap[editableId] ?? []).map(c => c.id)
      if (!currentCols.includes(colId)) {
        await collectionService.setForItem(editableId, [...currentCols, colId])
      }
    }
    // Update only affected entries rather than re-fetching the entire map
    setItemCollectionsMap(prev => {
      const next = { ...prev }
      for (const id of ids) {
        const editableId = (companionBySourceId.get(id)?.id ?? id)
        const current = next[editableId] ?? []
        if (!current.some(c => c.id === colId)) next[editableId] = [...current, col]
      }
      return next
    })
    setShowBulkCol(false)
  }

  async function handleBulkRemoveCollection(colId: string) {
    const ids = [...selectedIds]
    for (const id of ids) {
      const companion  = companionBySourceId.get(id)
      const editableId = companion?.id ?? id
      const currentCols = (itemCollectionsMap[editableId] ?? []).map(c => c.id)
      await collectionService.setForItem(editableId, currentCols.filter(c => c !== colId))
    }
    // Update only affected entries rather than re-fetching the entire map
    setItemCollectionsMap(prev => {
      const next = { ...prev }
      for (const id of ids) {
        const editableId = (companionBySourceId.get(id)?.id ?? id)
        next[editableId] = (next[editableId] ?? []).filter(c => c.id !== colId)
      }
      return next
    })
    setShowBulkCol(false)
  }

  // Which tags/collections every selected item already has (used for toggle state in popovers)
  const universalTagIds = useMemo(() => {
    if (selectedIds.size === 0) return new Set<string>()
    const editableIds = [...selectedIds].map(id => (companionBySourceId.get(id)?.id ?? id))
    const counts = new Map<string, number>()
    for (const eid of editableIds)
      for (const t of (itemTagsMap[eid] ?? []))
        counts.set(t.id, (counts.get(t.id) ?? 0) + 1)
    return new Set([...counts.entries()].filter(([, n]) => n === editableIds.length).map(([id]) => id))
  }, [selectedIds, itemTagsMap, companionBySourceId])

  const universalColIds = useMemo(() => {
    if (selectedIds.size === 0) return new Set<string>()
    const editableIds = [...selectedIds].map(id => (companionBySourceId.get(id)?.id ?? id))
    const counts = new Map<string, number>()
    for (const eid of editableIds)
      for (const c of (itemCollectionsMap[eid] ?? []))
        counts.set(c.id, (counts.get(c.id) ?? 0) + 1)
    return new Set([...counts.entries()].filter(([, n]) => n === editableIds.length).map(([id]) => id))
  }, [selectedIds, itemCollectionsMap, companionBySourceId])

  // ── Filtered + sorted items ───────────────────────────────────
  // Split into two memos so changing sortBy doesn't re-run all filters,
  // and filter/search changes don't re-sort unnecessarily.

  // Step 1: filter only — re-runs when items data or any active filter changes.
  const filteredItems = useMemo(() => {
    // For grouped cards the display item is the EPUB companion; use its data for filters
    const resolveDisplay = (i: Item) => companionBySourceId.get(i.id) ?? i

    // Hide EPUBs that are grouped with their source PDF — the PDF card represents both
    let result = items.filter(i => !groupedEpubIds.has(i.id))

    if (filter === 'unread') {
      result = result.filter(i => getEffectiveStatus(resolveDisplay(i)) === 'unread')
    } else if (filter === 'in-progress') {
      result = result.filter(i => getEffectiveStatus(resolveDisplay(i)) === 'reading')
    } else if (filter === 'finished') {
      result = result.filter(i => getEffectiveStatus(resolveDisplay(i)) === 'finished')
    }

    if (collectionFilter) {
      result = result.filter(i => {
        const d = resolveDisplay(i)
        return (itemCollectionsMap[d.id] ?? []).some(c => c.id === collectionFilter)
      })
    }

    if (tagFilters.length > 0) {
      result = result.filter(i => {
        const d = resolveDisplay(i)
        return (itemTagsMap[d.id] ?? []).some(t => tagFilters.includes(t.id))
      })
    }

    if (authorFilters.length > 0) {
      result = result.filter(i => i.author != null && authorFilters.includes(i.author))
    }

    if (typeFilters.length > 0) {
      result = result.filter(i => {
        const d = resolveDisplay(i)
        return typeFilters.includes(d.content_type)
      })
    }

    if (debouncedQuery.trim()) {
      const q = debouncedQuery.trim().toLowerCase()
      result = result.filter(i => {
        const d = resolveDisplay(i)
        if (d.title.toLowerCase().includes(q))            return true
        if (d.author?.toLowerCase().includes(q))          return true
        if (d.description?.toLowerCase().includes(q))     return true
        if ((itemTagsMap[d.id] ?? []).some(t => t.name.toLowerCase().includes(q))) return true
        return false
      })
    }

    return result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filter, collectionFilter, tagFiltersKey, authorFiltersKey, typeFiltersKey, debouncedQuery, itemTagsMap, itemCollectionsMap, groupedEpubIds, companionBySourceId])

  // Step 2: sort only — re-runs when the sort setting changes or the filtered set changes.
  // Changing sortBy never reruns the filter pass above.
  const displayedItems = useMemo(() => {
    const resolveDisplay = (i: Item) => companionBySourceId.get(i.id) ?? i
    const result = [...filteredItems]

    if (sortBy === 'last_read') {
      result.sort((a, b) => {
        const aRead = Math.max(resolveDisplay(a).last_read_at ?? 0, a.last_read_at ?? 0)
        const bRead = Math.max(resolveDisplay(b).last_read_at ?? 0, b.last_read_at ?? 0)
        return bRead - aRead
      })
    } else if (sortBy === 'title') {
      result.sort((a, b) => a.title.localeCompare(b.title))
    } else if (sortBy === 'word_count') {
      result.sort((a, b) => {
        const aWc = resolveDisplay(a).word_count ?? 0
        const bWc = resolveDisplay(b).word_count ?? 0
        return bWc - aWc
      })
    } else if (sortBy === 'progress') {
      result.sort((a, b) => {
        const aP = resolveDisplay(a).scroll_position ?? 0
        const bP = resolveDisplay(b).scroll_position ?? 0
        return bP - aP
      })
    }
    // default: date_saved — items arrive from the DB already sorted DESC, so no-op

    return result
  }, [filteredItems, sortBy, companionBySourceId])

  // Group items into rows for the virtualizer
  const virtualRows = useMemo(() => {
    const rows: typeof displayedItems[] = []
    for (let i = 0; i < displayedItems.length; i += columnsPerRow) {
      rows.push(displayedItems.slice(i, i + columnsPerRow))
    }
    return rows
  }, [displayedItems, columnsPerRow])

  const virtualizer = useVirtualizer({
    count:         virtualRows.length,
    getScrollElement: () => mainRef.current,
    estimateSize:  () => 280,
    overscan:      3,
  })

  // Keep ref in sync so Cmd+A can read latest without a dep in the effect
  useEffect(() => {
    displayedItemIdsRef.current = displayedItems.map(i => i.id)
  }, [displayedItems])

  // Drop any selected IDs that are no longer visible (e.g. after a delete)
  useEffect(() => {
    const visible = new Set(displayedItems.map(i => i.id))
    setSelectedIds(prev => {
      const cleaned = new Set([...prev].filter(id => visible.has(id)))
      return cleaned.size === prev.size ? prev : cleaned
    })
  }, [displayedItems])

  // ── Active filter labels ──────────────────────────────────────

  const activeCollectionName = collectionFilter
    ? allCollections.find(c => c.id === collectionFilter)?.name
    : null

  const activeAuthorName = authorFilters.length === 1 ? authorFilters[0] : null


  function handleCloseModal() {
    setShowAddModal(false)
    setPendingUrl(undefined)
  }

  return (
    <div className="library-layout" onClick={() => { if (selectedIds.size > 0) clearSelection() }}>
      <Sidebar
        collectionMgmt={{
          collections:  allCollections,
          itemCounts:   collectionItemCounts,
          onCreate:     handleCollectionCreate,
          onDelete:     handleCollectionDelete,
          onRename:     handleCollectionRename,
        }}
        authors={allAuthors}
        authorItemCounts={authorItemCounts}
        captureJobs={captureJobs}
        onDismissJob={dismissJob}
      />
      <main className="library-main" ref={mainRef}>
        <header className="library-header">
          <h1>
            {activeCollectionName ?? (activeAuthorName ? `By ${activeAuthorName}` : 'Library')}
          </h1>
          <div className="library-header-controls">
            <div className="library-search">
              <svg className="library-search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <circle cx="6.5" cy="6.5" r="4.5" />
                <line x1="10.5" y1="10.5" x2="14" y2="14" />
              </svg>
              <input
                className="library-search-input"
                type="text"
                placeholder="Search title, author, tags…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                aria-label="Search library"
              />
              {searchQuery && (
                <button
                  className="library-search-clear"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
            <CustomSelect
              label="Sort"
              includePlaceholder={false}
              value={sortBy}
              onChange={val => updateSettings({ defaultSort: val as SortBy })}
              options={[
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

        {/* Filter bar — type, tag, author dropdowns */}
        <div className="library-filter-bar">
          <MultiSelect
            label="Type"
            values={typeFilters}
            onChange={selected => {
              const next = new URLSearchParams(searchParams)
              next.delete('type')
              for (const t of selected) next.append('type', t)
              setSearchParams(next)
            }}
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
              onChange={selected => {
                const next = new URLSearchParams(searchParams)
                next.delete('tag')
                for (const id of selected) next.append('tag', id)
                setSearchParams(next)
              }}
              options={allTags.map(t => ({ value: t.id, label: t.name }))}
            />
          )}
          {allAuthors.length > 0 && (
            <MultiSelect
              label="Author"
              values={authorFilters}
              onChange={selected => {
                const next = new URLSearchParams(searchParams)
                next.delete('author')
                for (const a of selected) next.append('author', a)
                setSearchParams(next)
              }}
              options={allAuthors.map(a => ({ value: a, label: a }))}
            />
          )}
          {(tagFilters.length > 0 || authorFilters.length > 0 || typeFilters.length > 0) && (
            <button
              className="library-filter-clear"
              onClick={() => {
                const next = new URLSearchParams(searchParams)
                next.delete('tag')
                next.delete('author')
                next.delete('type')
                setSearchParams(next)
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {loading ? (
          <div className="library-state-center">
            <p className="state-text">Loading…</p>
          </div>
        ) : loadError ? (
          <div className="library-state-center">
            <p className="state-text">Failed to load library: {loadError}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="library-state-center">
            <div className="empty-state">
              <h2 className="empty-state-title">Your library is empty</h2>
              <p className="empty-state-body">
                Save a story, article, or import an EPUB to get started.
              </p>
              <button className="btn-primary" onClick={() => setShowAddModal(true)}>
                + Add your first item
              </button>
            </div>
          </div>
        ) : displayedItems.length === 0 ? (
          <div className="library-state-center">
            <p className="state-text">
              {activeCollectionName
                ? `No items in "${activeCollectionName}" yet. Add some using the ⊞ button on any card.`
                : 'No items match this filter.'}
            </p>
          </div>
        ) : (
          <div
            className="library-grid"
            style={{ position: 'relative', height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map(virtualRow => {
              const rowItems = virtualRows[virtualRow.index]
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top:         `${virtualRow.start}px`,
                    width:       '100%',
                    display:     'flex',
                    gap:         `${GRID_GAP}px`,
                    paddingBottom: `${GRID_GAP}px`,
                  }}
                >
                  {rowItems.map(item => {
                    // item is always the PDF source; companion is the derived EPUB (if any)
                    const companion    = companionBySourceId.get(item.id)
                    const pref         = companion ? (formatPrefs[item.id] ?? 'epub') : null
                    const displayItem  = companion && pref === 'pdf' ? item : (companion ?? item)
                    const sourceItem   = companion && pref === 'pdf' ? companion : (companion ? item : undefined)
                    // Tags/collections always live on the EPUB row in the DB
                    const tagsItem     = companion ?? displayItem
                    const editableItem = companion ?? displayItem
                    return (
                      <div key={item.id} style={{ width: `${colWidth}px`, flexShrink: 0 }}>
                        <ItemCard
                          item={displayItem}
                          sourceItem={sourceItem}
                          tags={itemTagsMap[tagsItem.id] ?? []}
                          isSelected={selectedIds.has(item.id)}
                          onClick={e => handleCardClick(item.id, e, () => navigate(`/read/${displayItem.id}`))}
                          onOpenSource={sourceItem ? () => navigate(`/read/${sourceItem.id}`) : undefined}
                          onTogglePreferred={companion ? () => handleTogglePreferred(item.id) : undefined}
                          onDelete={async () => {
                            if (companion) await libraryService.delete(companion.id)
                            await libraryService.delete(item.id)
                            setItems(prev =>
                              prev.filter(i => i.id !== item.id && i.id !== companion?.id)
                            )
                          }}
                          onEditTags={() => setTagModalItem(editableItem)}
                          onEditCollections={() => setColModalItem(editableItem)}
                          onCoverChange={(newPath) =>
                            setItems(prev => prev.map(i =>
                              i.id === displayItem.id ? { ...i, cover_path: newPath } : i
                            ))
                          }
                          onAuthorChange={(author) =>
                            setItems(prev => prev.map(i =>
                              i.id === displayItem.id ? { ...i, author } : i
                            ))
                          }
                          onStatusChange={(status) => handleStatusChange(editableItem.id, status)}
                          onRefresh={displayItem.source_url ? async (): Promise<RefreshResult> => {
                            const title   = displayItem.title
                            const toastId = addToast(`Refreshing "${title}"…`, 'info')
                            try {
                              const result = await libraryService.refresh(displayItem.id)
                              if (result.changed) {
                                setItems(prev => prev.map(i =>
                                  i.id === displayItem.id
                                    ? { ...i, word_count: result.wordCount, date_modified: Date.now() }
                                    : i
                                ))
                                updateToast(toastId, `"${title}" updated`, 'success')
                              } else {
                                updateToast(toastId, `"${title}" already up to date`, 'success')
                              }
                              return result
                            } catch (err) {
                              updateToast(toastId, `Refresh failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
                              throw err
                            }
                          } : undefined}
                          onAppend={displayItem.source_url && displayItem.chapter_end != null
                            ? () => setAppendModalItem(displayItem)
                            : undefined
                          }
                          onTagClick={tagId => {
                            if (tagFilters.includes(tagId)) return
                            const next = new URLSearchParams(searchParams)
                            next.append('tag', tagId)
                            setSearchParams(next)
                          }}
                          onAuthorClick={author => {
                            if (authorFilters.includes(author)) return
                            const next = new URLSearchParams(searchParams)
                            next.append('author', author)
                            setSearchParams(next)
                          }}
                        />
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )}
      </main>

      {/* ── Bulk action bar ──────────────────────────────────── */}
      {selectedIds.size > 0 && (
        <div className="bulk-action-bar" onClick={e => e.stopPropagation()}>
          <span className="bulk-action-count">
            {selectedIds.size} selected
            {selectedIds.size === 1 && <span className="bulk-action-hint"> · Shift+click to add more</span>}
          </span>

          <button className="bulk-action-btn" onClick={selectAll}>
            Select all ({displayedItems.length})
          </button>

          {/* Tag popover */}
          <div style={{ position: 'relative' }}>
            <button className="bulk-action-btn" onClick={() => { setShowBulkTag(s => !s); setShowBulkCol(false) }}>
              Tags
            </button>
            {showBulkTag && (
              <div className="bulk-popover">
                {allTags.length === 0
                  ? <span className="bulk-popover-empty">No tags yet</span>
                  : allTags.map(t => {
                    const applied = universalTagIds.has(t.id)
                    return (
                      <button
                        key={t.id}
                        className={`bulk-popover-item${applied ? ' bulk-popover-item--applied' : ''}`}
                        onClick={() => applied ? handleBulkRemoveTag(t.id) : handleBulkAddTag(t.id)}
                      >
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: t.color, flexShrink: 0 }} />
                        {t.name}
                        {applied && (
                          <svg className="bulk-popover-check" viewBox="0 0 10 8" width="10" height="8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="1,4 4,7 9,1" />
                          </svg>
                        )}
                      </button>
                    )
                  })
                }
              </div>
            )}
          </div>

          {/* Collection popover */}
          <div style={{ position: 'relative' }}>
            <button className="bulk-action-btn" onClick={() => { setShowBulkCol(s => !s); setShowBulkTag(false) }}>
              Collections
            </button>
            {showBulkCol && (
              <div className="bulk-popover">
                {allCollections.length === 0
                  ? <span className="bulk-popover-empty">No collections yet</span>
                  : allCollections.map(c => {
                    const applied = universalColIds.has(c.id)
                    return (
                      <button
                        key={c.id}
                        className={`bulk-popover-item${applied ? ' bulk-popover-item--applied' : ''}`}
                        onClick={() => applied ? handleBulkRemoveCollection(c.id) : handleBulkAddCollection(c.id)}
                      >
                        {c.name}
                        {applied && (
                          <svg className="bulk-popover-check" viewBox="0 0 10 8" width="10" height="8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="1,4 4,7 9,1" />
                          </svg>
                        )}
                      </button>
                    )
                  })
                }
              </div>
            )}
          </div>

          {bulkDeleteConfirming ? (
            <>
              <span className="bulk-action-confirm-text">Delete {selectedIds.size} item{selectedIds.size !== 1 ? 's' : ''}?</span>
              <button
                className="bulk-action-btn bulk-action-btn--danger"
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
              >
                {bulkDeleting ? 'Deleting…' : 'Confirm'}
              </button>
              <button
                className="bulk-action-btn"
                onClick={() => setBulkDeleteConfirming(false)}
                disabled={bulkDeleting}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="bulk-action-btn bulk-action-btn--danger"
              onClick={() => setBulkDeleteConfirming(true)}
            >
              Delete {selectedIds.size}
            </button>
          )}

          <button className="bulk-action-dismiss" onClick={clearSelection} aria-label="Clear selection">✕</button>
        </div>
      )}

      {showAddModal && (
        <AddItemModal
          initialUrl={pendingUrl}
          onClose={handleCloseModal}
          onSaved={(item) => {
            setItems(prev => [item, ...prev])
            handleCloseModal()
          }}
          onJobStarted={(jobId, url) => {
            handleJobStarted(jobId, url)
            handleCloseModal()
          }}
        />
      )}

      {tagModalItem && (
        <TagsModal
          itemId={tagModalItem.id}
          itemTitle={tagModalItem.title}
          allTags={allTags}
          itemTagIds={new Set((itemTagsMap[tagModalItem.id] ?? []).map(t => t.id))}
          onClose={() => {
            setTagModalItem(null)
            refreshTagData()
          }}
        />
      )}

      {colModalItem && (
        <CollectionsModal
          itemId={colModalItem.id}
          itemTitle={colModalItem.title}
          allCollections={allCollections}
          itemCollectionIds={new Set((itemCollectionsMap[colModalItem.id] ?? []).map(c => c.id))}
          onClose={() => {
            setColModalItem(null)
            refreshCollectionData()
          }}
        />
      )}


      {appendModalItem && (
        <AppendModal
          item={appendModalItem}
          onClose={() => setAppendModalItem(null)}
          onJobStarted={(jobId, url) => {
            handleJobStarted(jobId, url)
            setAppendModalItem(null)
          }}
        />
      )}
    </div>
  )
}
