import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { libraryService } from '../../services/library'
import type { Item } from '../../types'

const PALETTE = [
  '#e57373',
  '#f06292',
  '#ba68c8',
  '#7986cb',
  '#4fc3f7',
  '#4db6ac',
  '#aed581',
  '#ffb74d',
]
function coverColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0
  return PALETTE[(h >>> 0) % PALETTE.length]
}

function daysAgo(ts: number): number {
  return Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24))
}

function daysUntilPurge(ts: number): number {
  return Math.max(0, 30 - daysAgo(ts))
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

interface TrashRowProps {
  item: Item
  onRestore: () => void
  onDeleteForever: () => void
}

function TrashRow({ item, onRestore, onDeleteForever }: TrashRowProps) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const deletedAt = item.deleted_at ?? Date.now()
  const ago = daysAgo(deletedAt)
  const remaining = daysUntilPurge(deletedAt)

  async function handleDeleteForever() {
    if (!confirming) {
      setConfirming(true)
      return
    }
    setBusy(true)
    try {
      await onDeleteForever()
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  async function handleRestore() {
    setBusy(true)
    try {
      await onRestore()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`trash-row${confirming ? ' trash-row--confirming' : ''}`}>
      <div
        className="trash-row-cover"
        style={!item.cover_path ? { background: coverColor(item.id) } : undefined}
      >
        {item.cover_path ? (
          <img src={`library://${item.cover_path}`} alt="" draggable={false} />
        ) : (
          <span className="trash-row-cover-initial">{item.title[0]?.toUpperCase() ?? '?'}</span>
        )}
      </div>

      <div className="trash-row-info">
        <span className="trash-row-title">{item.title}</span>
        {item.author && <span className="trash-row-author">{item.author}</span>}
        <div className="trash-row-meta">
          <span className="trash-row-type">{item.content_type}</span>
          <span className="trash-row-dates">
            Deleted {ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago} days ago`}
            {' · '}
            {remaining > 0
              ? `${remaining} day${remaining === 1 ? '' : 's'} until permanent deletion`
              : 'Will be purged on next launch'}
            {' · '}
            {formatDate(deletedAt)}
          </span>
        </div>
      </div>

      <div className="trash-row-actions">
        <button className="trash-btn trash-btn--restore" onClick={handleRestore} disabled={busy}>
          Restore
        </button>
        <button
          className={`trash-btn trash-btn--delete${confirming ? ' trash-btn--danger' : ''}`}
          onClick={handleDeleteForever}
          disabled={busy}
        >
          {confirming ? 'Sure?' : 'Delete Forever'}
        </button>
        {confirming && (
          <button
            className="trash-btn trash-btn--cancel"
            onClick={() => setConfirming(false)}
            disabled={busy}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}

export default function TrashView() {
  const navigate = useNavigate()
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [emptyConfirming, setEmptyConfirming] = useState(false)
  const [emptyBusy, setEmptyBusy] = useState(false)

  useEffect(() => {
    libraryService
      .getTrashed()
      .then(setItems)
      .finally(() => setLoading(false))
  }, [])

  async function handleRestore(id: string) {
    await libraryService.restore(id)
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  async function handleDeleteForever(id: string) {
    await libraryService.permanentlyDelete(id)
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  async function handleEmptyTrash() {
    if (!emptyConfirming) {
      setEmptyConfirming(true)
      return
    }
    setEmptyBusy(true)
    try {
      await libraryService.emptyTrash()
      setItems([])
      setEmptyConfirming(false)
      navigate('/')
    } finally {
      setEmptyBusy(false)
    }
  }

  return (
    <div className="trash-layout">
      <header className="trash-header">
        <button className="trash-back-btn" onClick={() => navigate('/')}>
          ← Library
        </button>
        <h1 className="trash-title">Trash</h1>
        <span className="trash-header-spacer" />
        <span className="trash-purge-note">Permanently deleted after 30 days</span>
        {items.length > 0 &&
          (emptyConfirming ? (
            <>
              <button
                className="trash-btn trash-btn--danger"
                onClick={handleEmptyTrash}
                disabled={emptyBusy}
              >
                Empty Trash ({items.length})
              </button>
              <button
                className="trash-btn trash-btn--cancel"
                onClick={() => setEmptyConfirming(false)}
                disabled={emptyBusy}
              >
                Cancel
              </button>
            </>
          ) : (
            <button className="trash-btn" onClick={() => setEmptyConfirming(true)}>
              Empty Trash
            </button>
          ))}
      </header>

      {loading ? (
        <div className="trash-empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="trash-empty">
          <span>Trash is empty</span>
          <button className="trash-back-btn" onClick={() => navigate('/')}>
            ← Back to Library
          </button>
        </div>
      ) : (
        <div className="trash-body">
          <div className="trash-list">
            {items.map((item) => (
              <TrashRow
                key={item.id}
                item={item}
                onRestore={() => handleRestore(item.id)}
                onDeleteForever={() => handleDeleteForever(item.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
