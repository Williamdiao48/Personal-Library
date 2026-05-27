import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { tagService, collectionService, libraryService } from '../../services/library'
import Sidebar from './Sidebar'
import ColorInput from '../ui/ColorInput'
import type { Tag, Collection } from '../../types'

const DEFAULT_COLOR = '#7c6aff'

// ── TagRow ────────────────────────────────────────────────────────────────────

interface TagRowProps {
  tag: Tag
  count: number
  onRename: (id: string, name: string) => void
  onSetColor: (id: string, color: string) => void
  onDelete: (id: string) => void
  onNavigate: (id: string) => void
}

function TagRow({ tag, count, onRename, onSetColor, onDelete, onNavigate }: TagRowProps) {
  const [editingName, setEditingName]     = useState(false)
  const [nameValue, setNameValue]         = useState(tag.name)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingName) inputRef.current?.select()
  }, [editingName])

  function commitRename() {
    setEditingName(false)
    const trimmed = nameValue.trim()
    if (trimmed && trimmed !== tag.name) onRename(tag.id, trimmed)
    else setNameValue(tag.name)
  }

  return (
    <div className="tag-row">
      <ColorInput value={tag.color} onChange={color => onSetColor(tag.id, color)} size={20} />

      <div className="tag-row-name-wrap">
        {editingName ? (
          <input
            ref={inputRef}
            className="tag-row-name-input"
            value={nameValue}
            onChange={e => setNameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') { setEditingName(false); setNameValue(tag.name) }
            }}
          />
        ) : (
          <button className="tag-row-name" onClick={() => setEditingName(true)} title="Click to rename">
            {tag.name}
          </button>
        )}
      </div>

      <button
        className="tag-row-count"
        onClick={() => onNavigate(tag.id)}
        title={`Browse ${count} item${count !== 1 ? 's' : ''} with this tag`}
      >
        {count} {count === 1 ? 'item' : 'items'}
      </button>

      {confirmDelete ? (
        <div className="tag-row-confirm">
          <span className="tag-row-confirm-text">
            {count > 0 ? `Remove from ${count} item${count !== 1 ? 's' : ''}?` : 'Delete?'}
          </span>
          <button className="tag-row-confirm-yes" onClick={() => onDelete(tag.id)}>Delete</button>
          <button className="tag-row-confirm-no" onClick={() => setConfirmDelete(false)}>Cancel</button>
        </div>
      ) : (
        <button
          className="tag-row-delete"
          onClick={() => setConfirmDelete(true)}
          title="Delete tag"
          aria-label={`Delete ${tag.name}`}
        >
          ✕
        </button>
      )}
    </div>
  )
}

// ── TagsView ──────────────────────────────────────────────────────────────────

export default function TagsView() {
  const navigate = useNavigate()

  const [tags, setTags]                   = useState<Tag[]>([])
  const [itemCounts, setItemCounts]       = useState<Record<string, number>>({})
  const [allCollections, setAllCollections]             = useState<Collection[]>([])
  const [collectionItemCounts, setCollectionItemCounts] = useState<Record<string, number>>({})
  const [allLibraryItems, setAllLibraryItems]           = useState<import('../../types').Item[]>([])
  const [trashedCount, setTrashedCount]   = useState(0)
  const [loading, setLoading]             = useState(true)

  // New tag form
  const [newName, setNewName]   = useState('')
  const [newColor, setNewColor] = useState(DEFAULT_COLOR)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    Promise.all([
      tagService.getAll(),
      tagService.getItemCounts(),
      collectionService.getAll(),
      collectionService.getAllItemCollections(),
      libraryService.getAll(),
      libraryService.getTrashed(),
    ]).then(([allTags, counts, cols, itemCols, allItems, trashed]) => {
      setTags(allTags)
      setAllLibraryItems(allItems)
      setTrashedCount(trashed.length)

      const countsMap: Record<string, number> = {}
      for (const { tag_id, count } of counts) countsMap[tag_id] = count
      setItemCounts(countsMap)

      setAllCollections(cols)
      const colCounts: Record<string, number> = {}
      for (const { collection_id } of itemCols) colCounts[collection_id] = (colCounts[collection_id] ?? 0) + 1
      setCollectionItemCounts(colCounts)
    }).finally(() => setLoading(false))
  }, [])

  const sidebarAuthors = useMemo(() =>
    [...new Set(allLibraryItems.map(i => i.author).filter((a): a is string => !!a))].sort()
  , [allLibraryItems])

  const sidebarAuthorCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of allLibraryItems) if (item.author) counts[item.author] = (counts[item.author] ?? 0) + 1
    return counts
  }, [allLibraryItems])

  const handleCollectionCreate = useCallback(async (name: string) => {
    const col = await collectionService.create(name)
    setAllCollections(prev => [...prev, col].sort((a, b) => a.name.localeCompare(b.name)))
  }, [])

  const handleCollectionDelete = useCallback(async (colId: string) => {
    await collectionService.delete(colId)
    setAllCollections(prev => prev.filter(c => c.id !== colId))
  }, [])

  const handleCollectionRename = useCallback(async (colId: string, name: string) => {
    await collectionService.rename(colId, name)
    setAllCollections(prev => prev.map(c => c.id === colId ? { ...c, name } : c))
  }, [])

  const collectionMgmt = useMemo(() => ({
    collections: allCollections,
    itemCounts:  collectionItemCounts,
    onCreate:    handleCollectionCreate,
    onDelete:    handleCollectionDelete,
    onRename:    handleCollectionRename,
  }), [allCollections, collectionItemCounts, handleCollectionCreate, handleCollectionDelete, handleCollectionRename])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setCreating(true)
    try {
      const tag = await tagService.create(newName.trim(), newColor)
      setTags(prev => [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)))
      setNewName('')
      setNewColor(DEFAULT_COLOR)
    } finally {
      setCreating(false)
    }
  }

  function handleRename(id: string, name: string) {
    tagService.rename(id, name)
    setTags(prev => prev.map(t => t.id === id ? { ...t, name } : t).sort((a, b) => a.name.localeCompare(b.name)))
  }

  function handleSetColor(id: string, color: string) {
    tagService.setColor(id, color)
    setTags(prev => prev.map(t => t.id === id ? { ...t, color } : t))
  }

  function handleDelete(id: string) {
    tagService.delete(id)
    setTags(prev => prev.filter(t => t.id !== id))
    setItemCounts(prev => { const next = { ...prev }; delete next[id]; return next })
  }

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

      <main className="library-main">
        <header className="library-header">
          <h1>
            Tags
            {!loading && (
              <span className="collection-count"> · {tags.length} {tags.length === 1 ? 'tag' : 'tags'}</span>
            )}
          </h1>
        </header>

        <div className="tags-view-body">
          {/* Tag list */}
          {loading ? (
            <div className="library-state-center"><p className="state-text">Loading…</p></div>
          ) : tags.length === 0 ? (
            <div className="tags-empty">No tags yet. Create one below.</div>
          ) : (
            <div className="tags-list">
              {tags.map(tag => (
                <TagRow
                  key={tag.id}
                  tag={tag}
                  count={itemCounts[tag.id] ?? 0}
                  onRename={handleRename}
                  onSetColor={handleSetColor}
                  onDelete={handleDelete}
                  onNavigate={id => navigate(`/?tag=${id}`)}
                />
              ))}
            </div>
          )}

          {/* Create new tag */}
          <div className="tags-create-section">
            <h2 className="tags-create-title">New tag</h2>
            <form className="tags-create-form" onSubmit={handleCreate}>
              <input
                className="tags-create-input"
                type="text"
                placeholder="Tag name"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                maxLength={40}
              />
              <div className="tags-create-color-row">
                <ColorInput value={newColor} onChange={setNewColor} size={24} />
                <span className="tags-modal-color-hint">Pick color</span>
              </div>
              <button type="submit" className="btn-primary" disabled={creating || !newName.trim()}>
                {creating ? 'Creating…' : '+ Create'}
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  )
}
