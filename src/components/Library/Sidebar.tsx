import { useState, useRef, useEffect, memo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { Collection, CaptureJob } from '../../types'

interface CollectionMgmt {
  collections: Collection[]
  itemCounts: Record<string, number>
  onCreate: (name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
}

interface Props {
  collectionMgmt:   CollectionMgmt
  authors:          string[]
  authorItemCounts: Record<string, number>
  captureJobs:      CaptureJob[]
  onDismissJob:     (id: string) => void
}

// Returns the progress percentage (0–100) for a job, or null for indeterminate.
function jobProgress(job: CaptureJob): number | null {
  if (job.status === 'done')  return 100
  if (job.status === 'error') return 0
  if (/saving/i.test(job.msg)) return 99
  if (job.chapter && job.total) return Math.round((job.chapter / job.total) * 100)
  return null
}

// Formats an estimated time remaining based on chapter rate.
function jobEta(job: CaptureJob): string | null {
  if (!job.total || !job.chapter || job.chapter < 2) return null
  const elapsed       = Date.now() - job.startedAt
  const msPerChapter  = elapsed / job.chapter
  const remainingMs   = (job.total - job.chapter) * msPerChapter
  if (remainingMs < 3_000)  return 'almost done'
  if (remainingMs < 60_000) return `~${Math.ceil(remainingMs / 1_000)}s left`
  return `~${Math.ceil(remainingMs / 60_000)}m left`
}

// Truncates a URL to a readable hostname + path for display in the sidebar.
function displayUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.length > 24 ? u.pathname.slice(0, 22) + '…' : u.pathname
    return u.hostname + path
  } catch {
    return url.length > 36 ? url.slice(0, 34) + '…' : url
  }
}

// Renders a live ETA that ticks every second — isolated so only this span re-renders.
function LiveEta({ job }: { job: CaptureJob }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const eta = jobEta(job)
  if (!eta) return null
  return <span className="capture-job-eta">{eta}</span>
}

const Sidebar = memo(function Sidebar({ collectionMgmt, authors, authorItemCounts, captureJobs, onDismissJob }: Props) {
  const { collections, itemCounts, onCreate, onDelete, onRename } = collectionMgmt

  const [searchParams] = useSearchParams()
  const currentFilter     = searchParams.get('filter')
  const currentTag        = searchParams.get('tag')
  const currentAuthor     = searchParams.get('author')
  const currentCollection = searchParams.get('collection')

  const [authorsExpanded, setAuthorsExpanded] = useState(true)

  const isAllActive = !currentFilter && !currentTag && !currentAuthor && !currentCollection

  // ── Collection editing state ────────────────────────────────────
  const [editingId, setEditingId]             = useState<string | null>(null)
  const [editingName, setEditingName]         = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [showNewInput, setShowNewInput]       = useState(false)
  const [newName, setNewName]                 = useState('')
  const [saving, setSaving]                   = useState(false)
  const [collectionError, setCollectionError] = useState<string | null>(null)
  const [contextMenu, setContextMenu]         = useState<{ id: string; x: number; y: number } | null>(null)

  useEffect(() => {
    if (!contextMenu) return
    function close() { setContextMenu(null) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [contextMenu])

  // Tracks whether Escape was pressed so onBlur knows not to commit
  const editCancelled = useRef(false)
  const newCancelled  = useRef(false)

  function startEdit(col: Collection) {
    setConfirmDeleteId(null)
    setEditingId(col.id)
    setEditingName(col.name)
    editCancelled.current = false
  }

  async function commitRename(id: string) {
    if (editCancelled.current) { editCancelled.current = false; return }
    const trimmed = editingName.trim()
    if (trimmed && trimmed !== collections.find(c => c.id === id)?.name) {
      setSaving(true)
      try {
        await onRename(id, trimmed)
        setCollectionError(null)
      } catch {
        setCollectionError('Failed to rename collection.')
      } finally {
        setSaving(false)
      }
    }
    setEditingId(null)
  }

  async function commitCreate() {
    if (newCancelled.current) { newCancelled.current = false; return }
    const trimmed = newName.trim()
    if (trimmed) {
      setSaving(true)
      try {
        await onCreate(trimmed)
        setCollectionError(null)
      } catch {
        setCollectionError('Failed to create collection.')
      } finally {
        setSaving(false)
      }
    }
    setShowNewInput(false)
    setNewName('')
  }

  async function confirmDelete(id: string) {
    setSaving(true)
    try {
      await onDelete(id)
      setCollectionError(null)
    } catch {
      setCollectionError('Failed to delete collection.')
    } finally {
      setSaving(false)
    }
    setConfirmDeleteId(null)
  }

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        <Link className={`sidebar-link${isAllActive ? ' active' : ''}`} to="/">
          All Items
        </Link>
        <Link className={`sidebar-link${currentFilter === 'unread' ? ' active' : ''}`} to="/?filter=unread">
          Unread
        </Link>
        <Link className={`sidebar-link${currentFilter === 'in-progress' ? ' active' : ''}`} to="/?filter=in-progress">
          In Progress
        </Link>
        <Link className={`sidebar-link${currentFilter === 'finished' ? ' active' : ''}`} to="/?filter=finished">
          Finished
        </Link>
      </nav>

      {/* ── Collections ─────────────────────────────── */}
      <section className="sidebar-collections">
        <div className="sidebar-section-header">
          <h2 className="sidebar-section-title">Collections</h2>
          <button
            className="sidebar-section-add"
            onClick={() => { setShowNewInput(true); setEditingId(null); setConfirmDeleteId(null); newCancelled.current = false }}
            title="New collection"
            disabled={saving}
          >
            +
          </button>
        </div>

        {collections.map(col => {
          const count = itemCounts[col.id] ?? 0

          if (editingId === col.id) {
            return (
              <form
                key={col.id}
                className="sidebar-collection-edit-form"
                onSubmit={e => { e.preventDefault(); commitRename(col.id) }}
              >
                <input
                  autoFocus
                  className="sidebar-collection-input"
                  value={editingName}
                  onChange={e => setEditingName(e.target.value)}
                  onBlur={() => commitRename(col.id)}
                  onKeyDown={e => {
                    if (e.key === 'Escape') {
                      editCancelled.current = true
                      setEditingId(null)
                    }
                  }}
                  maxLength={60}
                />
              </form>
            )
          }

          if (confirmDeleteId === col.id) {
            return (
              <div key={col.id} className="sidebar-collection-confirm">
                <span className="sidebar-collection-confirm-text">Delete "{col.name}"?</span>
                <button className="sidebar-collection-confirm-yes" onClick={() => confirmDelete(col.id)} disabled={saving}>Yes</button>
                <button className="sidebar-collection-confirm-no" onClick={() => setConfirmDeleteId(null)} disabled={saving}>No</button>
              </div>
            )
          }

          return (
            <div
              key={col.id}
              className={`sidebar-collection-row${currentCollection === col.id ? ' active' : ''}`}
              onContextMenu={e => {
                e.preventDefault()
                setContextMenu({ id: col.id, x: e.clientX, y: e.clientY })
              }}
            >
              <Link className="sidebar-collection-link" to={`/?collection=${col.id}`}>
                <span className="sidebar-collection-name">{col.name}</span>
              </Link>
            </div>
          )
        })}

        {showNewInput && (
          <form
            className="sidebar-collection-edit-form"
            onSubmit={e => { e.preventDefault(); commitCreate() }}
          >
            <input
              autoFocus
              className="sidebar-collection-input"
              placeholder="Collection name…"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onBlur={commitCreate}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  newCancelled.current = true
                  setShowNewInput(false)
                  setNewName('')
                }
              }}
              maxLength={60}
            />
          </form>
        )}

        {collections.length === 0 && !showNewInput && (
          <p className="sidebar-collections-empty">No collections yet</p>
        )}

        {collectionError && (
          <p className="sidebar-collections-error" onClick={() => setCollectionError(null)}>
            {collectionError}
          </p>
        )}
      </section>

      {/* ── Authors ─────────────────────────────────── */}
      {authors.length > 0 && (
        <section className="sidebar-authors">
          <div className="sidebar-authors-header">
            <h2 className="sidebar-authors-title">Authors</h2>
            <button
              className="sidebar-authors-toggle"
              onClick={() => setAuthorsExpanded(s => !s)}
              aria-label={authorsExpanded ? 'Collapse authors' : 'Expand authors'}
            >
              {authorsExpanded ? '▾' : '▸'}
            </button>
          </div>
          {authorsExpanded && authors.map(author => {
            const encoded = encodeURIComponent(author)
            const isActive = currentAuthor === author
            return (
              <div key={author} className={`sidebar-author-row${isActive ? ' active' : ''}`}>
                <Link
                  className="sidebar-author-link"
                  to={`/?author=${encoded}`}
                  title={author}
                >
                  {author}
                </Link>
                <span className="sidebar-author-count">{authorItemCounts[author] ?? 0}</span>
              </div>
            )
          })}
        </section>
      )}

      {/* ── Capture jobs ─────────────────────────────── */}
      {captureJobs.length > 0 && (
        <section className="sidebar-captures">
          <h2 className="sidebar-section-title sidebar-captures-title">
            Capturing
            {captureJobs.some(j => j.status === 'running') && (
              <span className="sidebar-captures-pulse" aria-hidden="true" />
            )}
          </h2>

          {captureJobs.map(job => {
            const pct = jobProgress(job)

            return (
              <div key={job.id} className={`capture-job capture-job--${job.status}`}>
                <div className="capture-job-header">
                  <span className="capture-job-url" title={job.url}>
                    {job.status === 'done'  ? `✓ ${job.title ?? displayUrl(job.url)}` :
                     job.status === 'error' ? `✗ ${displayUrl(job.url)}` :
                     displayUrl(job.url)}
                  </span>
                  {(job.status === 'error' || job.status === 'done') && (
                    <button
                      className="capture-job-dismiss"
                      onClick={() => onDismissJob(job.id)}
                      aria-label="Dismiss"
                    >✕</button>
                  )}
                </div>

                {/* Progress bar */}
                <div className="capture-job-track">
                  {pct !== null ? (
                    <div
                      className="capture-job-bar"
                      style={{ width: `${pct}%` }}
                    />
                  ) : (
                    <div className="capture-job-bar capture-job-bar--indeterminate" />
                  )}
                </div>

                {/* Status line: message + ETA */}
                <div className="capture-job-status">
                  <span className="capture-job-msg">
                    {job.status === 'error'
                      ? (job.error ?? 'Capture failed.')
                      : job.status === 'done'
                        ? 'Saved to library'
                        : job.msg}
                  </span>
                  {job.status === 'running' && <LiveEta job={job} />}
                  {job.status === 'running' && job.chapter && job.total && (
                    <span className="capture-job-count">
                      {job.chapter}/{job.total}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </section>
      )}

      {/* ── Collection context menu ─────────────────── */}
      {contextMenu && (
        <div
          className="sidebar-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onMouseDown={e => e.stopPropagation()}
        >
          <button
            className="sidebar-context-menu-item"
            onClick={() => {
              const col = collections.find(c => c.id === contextMenu.id)
              if (col) startEdit(col)
              setContextMenu(null)
            }}
          >
            Rename
          </button>
          <button
            className="sidebar-context-menu-item sidebar-context-menu-item--danger"
            onClick={() => {
              setConfirmDeleteId(contextMenu.id)
              setEditingId(null)
              setContextMenu(null)
            }}
          >
            Delete
          </button>
        </div>
      )}

      {/* ── Footer ──────────────────────────────────── */}
      <div className="sidebar-footer">
        <Link
          className="sidebar-settings-btn"
          to="/stats"
          aria-label="Reading stats"
          title="Reading Stats"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3"  y="12" width="4" height="9" rx="1" />
            <rect x="10" y="7"  width="4" height="14" rx="1" />
            <rect x="17" y="3"  width="4" height="18" rx="1" />
          </svg>
          Stats
        </Link>
        <Link
          className="sidebar-settings-btn"
          to="/settings"
          aria-label="Settings"
          title="Settings"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Settings
        </Link>
      </div>
    </aside>
  )
})

export default Sidebar
