import { useState } from 'react'
import type { Item } from '../../types'
import { captureService } from '../../services/capture'

interface Props {
  item:         Item
  onClose:      () => void
  onJobStarted: (jobId: string, url: string) => void
}

export default function AppendModal({ item, onClose, onJobStarted }: Props) {
  const [newEnd, setNewEnd] = useState('')
  const [error, setError]   = useState<string | null>(null)

  const currentEnd = item.chapter_end ?? 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const end = parseInt(newEnd)
    if (!end || end <= currentEnd) {
      setError(`Enter a chapter number higher than ${currentEnd}.`)
      return
    }
    try {
      const jobId = await captureService.append(item.id, end)
      onJobStarted(jobId, item.source_url ?? item.title)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start append.')
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Append chapters</h2>
        <p className="modal-hint">Currently saved: Chapters {item.chapter_start ?? 1}–{currentEnd}</p>
        <form onSubmit={handleSubmit}>
          <label className="modal-label">
            Append through chapter
            <input
              type="number"
              min={currentEnd + 1}
              placeholder={String(currentEnd + 50)}
              value={newEnd}
              onChange={e => setNewEnd(e.target.value)}
              autoFocus
            />
          </label>
          {error && <p className="modal-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit">Append</button>
          </div>
        </form>
      </div>
    </div>
  )
}
