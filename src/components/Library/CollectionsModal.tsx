import { useState } from 'react'
import { collectionService } from '../../services/library'
import type { Collection } from '../../types'

interface Props {
  itemId: string
  itemTitle: string
  allCollections: Collection[]
  itemCollectionIds: Set<string>
  onClose: () => void
}

export default function CollectionsModal({
  itemId,
  itemTitle,
  allCollections: initialAllCollections,
  itemCollectionIds: initialItemCollectionIds,
  onClose,
}: Props) {
  const [allCollections, setAllCollections] = useState(initialAllCollections)
  const [selectedIds, setSelectedIds]       = useState(new Set(initialItemCollectionIds))
  const [newName, setNewName]               = useState('')
  const [creating, setCreating]             = useState(false)
  const [saving, setSaving]                 = useState(false)

  function toggle(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function createCollection(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setCreating(true)
    try {
      const col = await collectionService.create(newName.trim())
      setAllCollections(prev => [...prev, col].sort((a, b) => a.name.localeCompare(b.name)))
      setSelectedIds(prev => new Set([...prev, col.id]))
      setNewName('')
    } finally {
      setCreating(false)
    }
  }

  async function save() {
    setSaving(true)
    try {
      await collectionService.setForItem(itemId, Array.from(selectedIds))
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal tags-modal" onClick={e => e.stopPropagation()}>
        <div className="tags-modal-header">
          <h2>Collections</h2>
          <p className="tags-modal-subtitle">{itemTitle}</p>
        </div>

        <div className="tags-modal-list">
          {allCollections.length === 0 ? (
            <p className="tags-modal-empty">No collections yet. Create one below.</p>
          ) : (
            allCollections.map(col => (
              <div key={col.id} className="tags-modal-row">
                <label className="tags-modal-check">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(col.id)}
                    onChange={() => toggle(col.id)}
                  />
                  <span className="tags-modal-name">{col.name}</span>
                </label>
              </div>
            ))
          )}
        </div>

        <form className="tags-modal-new" onSubmit={createCollection}>
          <p className="tags-modal-section-label">New collection</p>
          <div className="tags-modal-new-row">
            <input
              type="text"
              className="tags-modal-input"
              placeholder="Collection name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              maxLength={60}
            />
            <button type="submit" className="btn-primary" disabled={creating || !newName.trim()}>
              {creating ? 'Creating…' : '+ Create'}
            </button>
          </div>
        </form>

        <div className="modal-actions">
          <button onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
