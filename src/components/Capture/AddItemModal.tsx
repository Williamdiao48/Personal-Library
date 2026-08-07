import { useState } from 'react'
import { captureService } from '../../services/capture'
import { libraryService } from '../../services/library'
import { useAuth } from '../../contexts/AuthContext'
import { useSettings } from '../../contexts/SettingsContext'
import { useToast } from '../../contexts/ToastContext'
import type { CaptureResult, Item } from '../../types'

interface Props {
  onClose: () => void
  onSaved: (item: Item) => void // file imports only
  onJobStarted: (jobId: string, url: string) => void // URL captures
  initialUrl?: string
}

const BOOKMARKLET = `javascript:(function(){location.href='personallibrary://save?url='+encodeURIComponent(location.href)})();`

export default function AddItemModal({ onClose, onSaved, onJobStarted, initialUrl }: Props) {
  const [url, setUrl] = useState(initialUrl ?? '')
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showRange, setShowRange] = useState(false)
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const [duplicate, setDuplicate] = useState<{ id: string; title: string } | null>(null)

  const { user, configured } = useAuth()
  const { settings, updateSettings } = useSettings()
  const { addToast } = useToast()
  // The per-capture cloud opt-in only exists when the user is signed in AND has
  // turned the master switch on (Phase 2 Decision 8). Otherwise nothing uploads.
  const cloudEligible = configured && !!user && settings.cloudBackupEnabled
  const cloudBackup = cloudEligible && settings.cloudBackupDefault

  // URL capture: fire-and-forget — modal closes immediately, job tracked in sidebar
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = url.trim()
    if (!trimmed) return
    setError(null)
    try {
      // Check for an existing item with the same source URL before starting capture
      const existing = await libraryService.findBySourceUrl(trimmed)
      if (existing) {
        setDuplicate({ id: existing.id, title: existing.title })
        return
      }
      await startCapture(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start capture.')
    }
  }

  async function startCapture(trimmed: string) {
    const start = showRange && rangeStart ? parseInt(rangeStart) : undefined
    const end = showRange && rangeEnd ? parseInt(rangeEnd) : undefined
    const jobId = await captureService.start(trimmed, start, end, cloudBackup)
    onJobStarted(jobId, trimmed)
    onClose()
  }

  // File import: blocking — stays open until complete (near-instant, no network)
  async function handleFileImport() {
    setImporting(true)
    setError(null)
    try {
      const result: CaptureResult | null = await captureService.fromFile(cloudBackup)
      if (!result) {
        setImporting(false)
        return
      } // user cancelled picker
      // A duplicate import created NO new item — just say so and close. Calling
      // onSaved here would prepend a second card for the already-present item (a
      // phantom that vanishes on the next library refetch), so we must not.
      if (result.duplicate) {
        addToast(`“${result.title}” is already in your library.`, 'success')
        onClose()
        return
      }
      const item = await libraryService.getById(result.id)
      if (!item) throw new Error('Item was saved but could not be retrieved.')
      onSaved(item)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.')
      setImporting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add item</h2>

        <form onSubmit={handleSubmit}>
          <input
            type="url"
            placeholder="https://..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
          />
          <div className="modal-range-toggle">
            <button
              type="button"
              className="modal-range-toggle-btn"
              onClick={() => setShowRange((s) => !s)}
            >
              {showRange ? '− Chapter range' : '+ Chapter range'}
            </button>
          </div>
          {showRange && (
            <div className="modal-range-inputs">
              <label>
                From
                <input
                  type="number"
                  min="1"
                  placeholder="1"
                  value={rangeStart}
                  onChange={(e) => setRangeStart(e.target.value)}
                />
              </label>
              <span className="modal-range-dash">–</span>
              <label>
                To
                <input
                  type="number"
                  min="1"
                  placeholder="last"
                  value={rangeEnd}
                  onChange={(e) => setRangeEnd(e.target.value)}
                />
              </label>
            </div>
          )}
          {cloudEligible && (
            <label className="modal-cloud-backup">
              <input
                type="checkbox"
                checked={settings.cloudBackupDefault}
                onChange={(e) => updateSettings({ cloudBackupDefault: e.target.checked })}
              />
              <span className="modal-cloud-backup-text">
                Back up to cloud
                <span className="modal-cloud-backup-hint">
                  {settings.cloudBackupDefault
                    ? 'This item’s file is uploaded to your account.'
                    : 'This item stays on this device only.'}
                </span>
              </span>
            </label>
          )}
          {error && <p className="modal-error">{error}</p>}
          {duplicate && (
            <div className="modal-duplicate-warning">
              <p>
                <strong>{duplicate.title}</strong> is already in your library.
              </p>
              <div className="modal-actions">
                <button type="button" onClick={() => setDuplicate(null)}>
                  Back
                </button>
                <button type="button" onClick={() => startCapture(url.trim())}>
                  Add anyway
                </button>
              </div>
            </div>
          )}
          {!duplicate && (
            <div className="modal-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit">Save</button>
            </div>
          )}
        </form>

        <div className="modal-divider" />

        <div className="modal-bookmarklet">
          <p className="modal-bookmarklet-label">Import a local file</p>
          <p className="modal-bookmarklet-hint">EPUB and PDF files are supported.</p>
          <button type="button" onClick={handleFileImport} disabled={importing}>
            {importing ? 'Importing…' : 'Browse files...'}
          </button>
        </div>

        <div className="modal-divider" />

        <div className="modal-bookmarklet">
          <p className="modal-bookmarklet-label">Save from your browser</p>
          <p className="modal-bookmarklet-hint">
            Drag this to your bookmarks bar. Click it on any page to send it here instantly.
          </p>
          <a
            href={BOOKMARKLET}
            className="bookmarklet-btn"
            draggable
            onClick={(e) => e.preventDefault()}
          >
            Save to Library
          </a>
        </div>
      </div>
    </div>
  )
}
