import { useState, useRef, useEffect, memo } from 'react'
import type { Item, Tag, RefreshResult, ReadingStatus } from '../../types'
import { getEffectiveStatus } from '../../types'
import { libraryService } from '../../services/library'

const STATUS_LABELS: Record<ReadingStatus, string> = {
  unread:    'Unread',
  reading:   'Reading',
  finished:  'Finished',
  'on-hold': 'On Hold',
  dropped:   'Dropped',
}

const STATUS_OPTIONS: Array<{ value: ReadingStatus | null; label: string }> = [
  { value: 'unread',   label: 'Unread'   },
  { value: 'reading',  label: 'Reading'  },
  { value: 'finished', label: 'Finished' },
  { value: 'on-hold',  label: 'On Hold'  },
  { value: 'dropped',  label: 'Dropped'  },
  { value: null,       label: 'Auto'     },
]

// Deterministic per-item cover color when no cover image is available.
const COVER_COLORS = [
  '#4a6fa8', '#7a5a9e', '#a05060', '#8a7040',
  '#3a8a6e', '#3a7a9e', '#8a5040', '#5a7a3a',
]
function coverColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = Math.imul(31, h) + id.charCodeAt(i) | 0
  return COVER_COLORS[Math.abs(h) % COVER_COLORS.length]
}

interface Props {
  item: Item
  tags: Tag[]
  sourceItem?: Item
  isSelected?: boolean
  onClick: (e: React.MouseEvent) => void
  onDelete: () => Promise<void>
  onOpenSource?: () => void
  onTogglePreferred?: () => void
  onEditTags: () => void
  onEditCollections: () => void
  onCoverChange: (newPath: string) => void
  onAuthorChange: (author: string | null) => void
  onStatusChange: (status: ReadingStatus | null) => void
  onTagClick: (tagId: string) => void
  onAuthorClick: (author: string) => void
  onRefresh?: () => Promise<RefreshResult>
  onAppend?: () => void
}

function ItemCard({ item, tags, sourceItem, isSelected, onClick, onDelete, onOpenSource, onTogglePreferred, onEditTags, onEditCollections, onCoverChange, onAuthorChange, onStatusChange, onTagClick, onAuthorClick, onRefresh, onAppend }: Props) {
  const [confirming, setConfirming]   = useState(false)
  const [deleting, setDeleting]       = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen]       = useState(false)
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [authorEditing, setAuthorEditing] = useState(false)
  const [authorDraft, setAuthorDraft]     = useState('')
  const [refreshing, setRefreshing]       = useState(false)
  const menuRef        = useRef<HTMLDivElement>(null)
  const statusMenuRef  = useRef<HTMLDivElement>(null)
  const tagsRef        = useRef<HTMLDivElement>(null)
  const authorInputRef = useRef<HTMLInputElement>(null)
  const progress = item.scroll_position ? Math.round(item.scroll_position * 100) : 0
  const effectiveStatus = getEffectiveStatus(item)

  function formatWordCount(n: number) {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K words`
    return `${n} words`
  }

  function startAuthorEdit(e?: React.MouseEvent) {
    e?.stopPropagation()
    setMenuOpen(false)
    setAuthorDraft(item.author ?? '')
    setAuthorEditing(true)
  }

  async function commitAuthorEdit() {
    setAuthorEditing(false)
    const trimmed = authorDraft.trim() || null
    if (trimmed === (item.author ?? null)) return // no change
    await libraryService.setAuthor(item.id, trimmed)
    onAuthorChange(trimmed)
  }

  function cancelAuthorEdit() {
    setAuthorEditing(false)
  }

  // Close dropdowns when clicking outside them
  useEffect(() => {
    if (!menuOpen) return
    function handleOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [menuOpen])

  useEffect(() => {
    if (!statusMenuOpen) return
    function handleOutside(e: MouseEvent) {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setStatusMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [statusMenuOpen])

  function handleMenuToggle(e: React.MouseEvent) {
    e.stopPropagation()
    setMenuOpen(prev => !prev)
  }

  async function handlePickCover(e: React.MouseEvent) {
    e.stopPropagation()
    setMenuOpen(false)
    const newPath = await libraryService.pickCover(item.id)
    if (newPath) onCoverChange(newPath)
  }

  async function handleRefresh(e: React.MouseEvent) {
    e.stopPropagation()
    setMenuOpen(false)
    setRefreshing(true)
    try {
      await onRefresh!()
    } finally {
      setRefreshing(false)
    }
  }

  function handleDeleteClick(e: React.MouseEvent) {
    e.stopPropagation()
    setMenuOpen(false)
    setConfirming(true)
    setDeleteError(null)
  }

  async function handleConfirm(e: React.MouseEvent) {
    e.stopPropagation()
    setDeleting(true)
    try {
      await onDelete()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed.')
      setDeleting(false)
    }
  }

  function handleCancel(e: React.MouseEvent) {
    e.stopPropagation()
    setConfirming(false)
    setDeleteError(null)
  }

  const card = (
    <div
      className={`item-card${confirming ? ' item-card--confirming' : ''}${isSelected ? ' item-card--selected' : ''}`}
      onClick={confirming ? undefined : e => onClick(e)}
    >
      <div
        className="item-card-cover"
        style={!item.cover_path ? { background: coverColor(item.id) } : undefined}
      >
        {item.cover_path
          ? <img
              src={`library://${item.cover_path}`}
              alt={item.title}
              loading="lazy"
              onLoad={e => (e.currentTarget as HTMLImageElement).classList.add('loaded')}
            />
          : <div className="item-card-cover-placeholder">{item.title[0]?.toUpperCase() ?? '?'}</div>
        }
        {tags.length > 0 && (
          <div className="item-card-tag-overlay" ref={tagsRef}>
            {tags.map(t => (
              <button
                key={t.id}
                className="item-card-tag-pill"
                title={`Filter by ${t.name}`}
                style={{ '--pill-color': t.color } as React.CSSProperties}
                onClick={e => { e.stopPropagation(); if (!e.shiftKey) onTagClick(t.id) }}
              >
                {t.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="item-card-meta">
        <p className="item-card-title" title={item.title}>{item.title}</p>

        {authorEditing ? (
          <input
            ref={authorInputRef}
            className="item-card-author-input"
            value={authorDraft}
            autoFocus
            placeholder="Author name…"
            onChange={e => setAuthorDraft(e.target.value)}
            onBlur={commitAuthorEdit}
            onKeyDown={e => {
              if (e.key === 'Enter')  { e.preventDefault(); commitAuthorEdit() }
              if (e.key === 'Escape') { e.preventDefault(); cancelAuthorEdit() }
            }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <div className="item-card-author-row">
            {item.author ? (
              <button
                className="item-card-author item-card-author--clickable"
                title={`Filter by ${item.author}`}
                onClick={e => { e.stopPropagation(); if (!e.shiftKey) onAuthorClick(item.author!) }}
              >
                {item.author}
              </button>
            ) : (
              <span className="item-card-author item-card-author--unknown">Unknown</span>
            )}
            <button
              className="item-card-author-edit-btn"
              onClick={startAuthorEdit}
              aria-label="Edit author"
              title="Edit author"
            >
              <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8.5 1.5l2 2-6 6H2.5v-2l6-6z" />
              </svg>
            </button>
          </div>
        )}

        <div className="item-card-status-row">
          <div ref={statusMenuRef} style={{ position: 'relative' }}>
            <button
              className={`item-card-status item-card-status--${effectiveStatus}`}
              onClick={e => { e.stopPropagation(); setStatusMenuOpen(s => !s) }}
              title="Change reading status"
            >
              {STATUS_LABELS[effectiveStatus]}
            </button>
            {statusMenuOpen && (
              <div className="item-card-status-menu">
                {STATUS_OPTIONS.map(opt => (
                  <button
                    key={opt.value ?? '__auto'}
                    className={`item-card-status-menu-item${(item.status ?? null) === opt.value ? ' active' : ''}`}
                    onClick={e => {
                      e.stopPropagation()
                      setStatusMenuOpen(false)
                      onStatusChange(opt.value)
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {item.word_count != null && item.word_count > 0 && (
            <span className="item-card-wordcount">{formatWordCount(item.word_count)}</span>
          )}
          {item.chapter_end != null && (
            <span className="item-card-chapter-range">
              Ch. {item.chapter_start ?? 1}–{item.chapter_end}
            </span>
          )}
        </div>

        <div className="item-card-progress">
          <div className="item-card-progress-bar" style={{ width: `${progress}%` }} />
        </div>
      </div>

      {/* ⋯ menu — hidden until card is hovered */}
      {!confirming && (
        <div className="item-card-menu-wrapper" ref={menuRef}>
          <button
            className="item-card-menu-btn"
            onClick={handleMenuToggle}
            aria-label="More options"
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="item-card-dropdown">
              {onOpenSource && sourceItem && (
                <>
                  <button className="item-card-dropdown-item" onClick={e => { e.stopPropagation(); setMenuOpen(false); onOpenSource() }}>
                    Open as {sourceItem.content_type.toUpperCase()}
                  </button>
                  <button className="item-card-dropdown-item" onClick={e => { e.stopPropagation(); setMenuOpen(false); onTogglePreferred?.() }}>
                    Make {sourceItem.content_type.toUpperCase()} default
                  </button>
                </>
              )}
              <button className="item-card-dropdown-item" onClick={e => { e.stopPropagation(); setMenuOpen(false); onEditCollections() }}>
                Add to collection
              </button>
              <button className="item-card-dropdown-item" onClick={e => { e.stopPropagation(); setMenuOpen(false); onEditTags() }}>
                Edit tags
              </button>
              <button className="item-card-dropdown-item" onClick={handlePickCover}>
                Change cover
              </button>
              {onAppend && (
                <button className="item-card-dropdown-item" onClick={e => { e.stopPropagation(); setMenuOpen(false); onAppend() }}>
                  Append chapters…
                </button>
              )}
              {onRefresh && (
                <button
                  className="item-card-dropdown-item"
                  onClick={handleRefresh}
                  disabled={refreshing}
                >
                  {refreshing ? 'Refreshing…' : 'Refresh from source'}
                </button>
              )}
              <button className="item-card-dropdown-item item-card-dropdown-item--danger" onClick={handleDeleteClick}>
                Delete
              </button>
            </div>
          )}
        </div>
      )}

      {/* Inline delete confirmation overlay */}
      {confirming && (
        <div className="item-card-confirm" onClick={e => e.stopPropagation()}>
          <p className="item-card-confirm-text">
            {deleteError ?? (sourceItem ? 'Delete both EPUB and PDF?' : 'Delete this item?')}
          </p>
          <div className="item-card-confirm-actions">
            <button onClick={handleCancel} disabled={deleting}>Cancel</button>
            <button className="btn-danger" onClick={handleConfirm} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      )}
    </div>
  )

  if (sourceItem) {
    return (
      <div className="item-card-group-wrapper">
        <div className="item-card-ghost" aria-hidden="true" />
        {card}
      </div>
    )
  }
  return card
}

export default memo(ItemCard, (prev, next) => {
  // Compare item by value so reference changes from setItems spreads don't cause re-renders
  // when the actual displayed data hasn't changed.
  const pi = prev.item, ni = next.item
  return (
    pi.id            === ni.id            &&
    pi.title         === ni.title         &&
    pi.author        === ni.author        &&
    pi.cover_path    === ni.cover_path    &&
    pi.word_count    === ni.word_count    &&
    pi.chapter_end   === ni.chapter_end   &&
    pi.scroll_position === ni.scroll_position &&
    pi.status        === ni.status        &&
    pi.date_modified === ni.date_modified &&
    prev.tags        === next.tags        &&
    prev.isSelected  === next.isSelected  &&
    prev.sourceItem  === next.sourceItem
  )
})
