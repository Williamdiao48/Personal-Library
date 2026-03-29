import { useState } from 'react'
import { tagService } from '../../services/library'
import type { Tag } from '../../types'

const PRESET_COLORS = [
  '#e05252', '#e08c52', '#d4c244', '#52c05a',
  '#5289e0', '#7c6aff', '#c052e0', '#888888',
]

interface Props {
  itemId: string
  itemTitle: string
  allTags: Tag[]
  itemTagIds: Set<string>
  onClose: () => void
}

export default function TagsModal({ itemId, itemTitle, allTags: initialAllTags, itemTagIds: initialItemTagIds, onClose }: Props) {
  const [allTags, setAllTags]       = useState(initialAllTags)
  const [selectedIds, setSelectedIds] = useState(new Set(initialItemTagIds))
  const [newName, setNewName]       = useState('')
  const [newColor, setNewColor]     = useState(PRESET_COLORS[5])
  const [creating, setCreating]     = useState(false)
  const [saving, setSaving]         = useState(false)

  function toggleTag(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function createTag(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setCreating(true)
    try {
      const tag = await tagService.create(newName.trim(), newColor)
      setAllTags(prev => [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)))
      setSelectedIds(prev => new Set([...prev, tag.id]))
      setNewName('')
    } finally {
      setCreating(false)
    }
  }

  async function deleteTag(id: string) {
    await tagService.delete(id)
    setAllTags(prev => prev.filter(t => t.id !== id))
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  async function save() {
    setSaving(true)
    try {
      await tagService.setForItem(itemId, Array.from(selectedIds))
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal tags-modal" onClick={e => e.stopPropagation()}>
        <div className="tags-modal-header">
          <h2>Tags</h2>
          <p className="tags-modal-subtitle">{itemTitle}</p>
        </div>

        <div className="tags-modal-list">
          {allTags.length === 0 ? (
            <p className="tags-modal-empty">No tags yet. Create one below.</p>
          ) : (
            allTags.map(tag => (
              <div key={tag.id} className="tags-modal-row">
                <label className="tags-modal-check">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(tag.id)}
                    onChange={() => toggleTag(tag.id)}
                  />
                  <span className="tags-modal-dot" style={{ backgroundColor: tag.color }} />
                  <span className="tags-modal-name">{tag.name}</span>
                </label>
                <button
                  className="tags-modal-delete-tag"
                  onClick={() => deleteTag(tag.id)}
                  title="Delete tag from library"
                  aria-label={`Delete ${tag.name}`}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        <form className="tags-modal-new" onSubmit={createTag}>
          <p className="tags-modal-section-label">New tag</p>
          <div className="tags-modal-new-row">
            <input
              type="text"
              className="tags-modal-input"
              placeholder="Tag name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              maxLength={40}
            />
            <button type="submit" className="btn-primary" disabled={creating || !newName.trim()}>
              {creating ? 'Adding…' : '+ Add'}
            </button>
          </div>
          <div className="tags-modal-colors">
            {PRESET_COLORS.map(c => (
              <button
                key={c}
                type="button"
                className={`tags-modal-swatch${newColor === c ? ' selected' : ''}`}
                style={{ backgroundColor: c }}
                onClick={() => setNewColor(c)}
                aria-label={`Color ${c}`}
              />
            ))}
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
