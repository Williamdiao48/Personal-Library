import { useState, useEffect } from 'react'
import { captureService } from '../../services/capture'
import { libraryService } from '../../services/library'
import { useAuth } from '../../contexts/AuthContext'
import { useSettings } from '../../contexts/SettingsContext'
import { useToast } from '../../contexts/ToastContext'
import type { BulkSource, CaptureResult, FavoritesDiscovery, Item } from '../../types'

interface Props {
  onClose: () => void
  onSaved: (item: Item) => void // file imports only
  onJobStarted: (jobId: string, url: string) => void // URL captures
  onBatchStarted: (
    batchId: string,
    source: BulkSource,
    label: string,
    total: number,
    titles: Record<string, string>,
  ) => void
  initialUrl?: string
}

const BOOKMARKLET = `javascript:(function(){location.href='personallibrary://save?url='+encodeURIComponent(location.href)})();`

type Mode = 'single' | 'favorites'

const SOURCE_LABEL: Record<BulkSource, string> = { ao3: 'AO3', ffn: 'FanFiction.net' }

export default function AddItemModal({
  onClose,
  onSaved,
  onJobStarted,
  onBatchStarted,
  initialUrl,
}: Props) {
  const [mode, setMode] = useState<Mode>('single')
  const [url, setUrl] = useState(initialUrl ?? '')
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showRange, setShowRange] = useState(false)
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const [duplicate, setDuplicate] = useState<{ id: string; title: string } | null>(null)

  // ── Favorites-import state ──────────────────────────────────────────────────
  const [favSource, setFavSource] = useState<BulkSource>('ao3')
  const [favRef, setFavRef] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [scanMsg, setScanMsg] = useState<string | null>(null)
  const [discovery, setDiscovery] = useState<FavoritesDiscovery | null>(null)
  const [favError, setFavError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const { user, configured } = useAuth()
  const { settings, updateSettings } = useSettings()
  const { addToast } = useToast()
  // The per-capture cloud opt-in only exists when the user is signed in AND has
  // turned the master switch on (Phase 2 Decision 8). Otherwise nothing uploads.
  const cloudEligible = configured && !!user && settings.cloudBackupEnabled
  const cloudBackup = cloudEligible && settings.cloudBackupDefault

  // Live "Scanning page N/M…" from the AO3 multi-page walk, shown while discovering.
  useEffect(() => {
    const off = window.api.onDiscoverProgress(({ page, totalPages, found }) => {
      setScanMsg(
        totalPages > 1
          ? `Scanning page ${page} of ${totalPages}… (${found} found)`
          : `Scanning… (${found} found)`,
      )
    })
    return off
  }, [])

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

  // ── Favorites import: discover, then import ─────────────────────────────────
  async function handleFind(e: React.FormEvent) {
    e.preventDefault()
    if (!favRef.trim()) return
    setFavError(null)
    setDiscovery(null)
    setScanMsg('Scanning…')
    setDiscovering(true)
    try {
      const result = await captureService.discoverFavorites(favSource, favRef.trim())
      setDiscovery(result)
    } catch (err) {
      setFavError(err instanceof Error ? err.message : 'Could not read that account.')
    } finally {
      setDiscovering(false)
      setScanMsg(null)
    }
  }

  async function handleImport() {
    if (!discovery) return
    const toImportWorks = discovery.works.filter((w) => !w.alreadyInLibrary)
    const urls = toImportWorks.map((w) => w.url)
    if (urls.length === 0) return
    setStarting(true)
    setFavError(null)
    try {
      const { batchId, total } = await captureService.startBulk(urls, cloudBackup)
      const label = `${SOURCE_LABEL[discovery.source]} · ${discovery.ref}`
      // Carry titles so the sidebar row can name the book currently downloading.
      const titles = Object.fromEntries(toImportWorks.map((w) => [w.url, w.title]))
      onBatchStarted(batchId, discovery.source, label, total, titles)
      onClose()
    } catch (err) {
      setFavError(err instanceof Error ? err.message : 'Could not start the import.')
      setStarting(false)
    }
  }

  const toImport = discovery ? discovery.total - discovery.alreadyInLibrary : 0

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add item</h2>

        <div className="modal-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'single'}
            className={`modal-tab ${mode === 'single' ? 'modal-tab--active' : ''}`}
            onClick={() => setMode('single')}
          >
            Single URL
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'favorites'}
            className={`modal-tab ${mode === 'favorites' ? 'modal-tab--active' : ''}`}
            onClick={() => setMode('favorites')}
          >
            Import favorites
          </button>
        </div>

        {mode === 'single' && (
          <>
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
          </>
        )}

        {mode === 'favorites' && (
          <div className="fav-import">
            <p className="modal-bookmarklet-hint">
              Pull an account’s whole favorites list in at once. AO3 imports a user’s public{' '}
              <strong>bookmarks</strong>; FanFiction.net imports their favorite{' '}
              <strong>stories</strong>.
            </p>

            <form onSubmit={handleFind}>
              <div className="fav-source-row">
                <select
                  aria-label="Import source"
                  value={favSource}
                  onChange={(e) => {
                    setFavSource(e.target.value as BulkSource)
                    setDiscovery(null)
                    setFavError(null)
                  }}
                >
                  <option value="ao3">AO3</option>
                  <option value="ffn">FanFiction.net</option>
                </select>
                <input
                  type="text"
                  placeholder={favSource === 'ao3' ? 'AO3 username' : 'FanFiction.net user id'}
                  value={favRef}
                  onChange={(e) => setFavRef(e.target.value)}
                  autoFocus
                />
              </div>
              <p className="modal-bookmarklet-hint">
                {favSource === 'ao3'
                  ? 'The username in the profile URL (archiveofourown.org/users/NAME). A pasted profile URL works too.'
                  : 'The number in the profile URL (fanfiction.net/u/12345). A pasted profile URL works too.'}
              </p>

              {favError && <p className="modal-error">{favError}</p>}

              {!discovery && (
                <div className="modal-actions">
                  <button type="button" onClick={onClose}>
                    Cancel
                  </button>
                  <button type="submit" disabled={discovering || !favRef.trim()}>
                    {discovering ? (scanMsg ?? 'Scanning…') : 'Find favorites'}
                  </button>
                </div>
              )}
            </form>

            {discovery && (
              <div className="fav-preview">
                <p className="fav-preview-counts">
                  Found <strong>{discovery.total}</strong>
                  {discovery.total === 1 ? ' work' : ' works'}
                  {discovery.alreadyInLibrary > 0 && (
                    <> · {discovery.alreadyInLibrary} already in library</>
                  )}
                  {toImport > 0 && (
                    <>
                      {' '}
                      · importing <strong>{toImport}</strong>
                    </>
                  )}
                  {(discovery.skippedSeries > 0 || discovery.skippedExternal > 0) && (
                    <span className="fav-preview-skips">
                      {' '}
                      (
                      {[
                        discovery.skippedSeries ? `${discovery.skippedSeries} series` : '',
                        discovery.skippedExternal ? `${discovery.skippedExternal} external` : '',
                      ]
                        .filter(Boolean)
                        .join(', ')}{' '}
                      skipped)
                    </span>
                  )}
                </p>

                {discovery.total === 0 ? (
                  <p className="modal-bookmarklet-hint">
                    No importable works found for that account.
                  </p>
                ) : toImport === 0 ? (
                  <p className="modal-bookmarklet-hint">
                    Everything here is already in your library.
                  </p>
                ) : (
                  <ul className="fav-preview-list">
                    {discovery.works
                      .filter((w) => !w.alreadyInLibrary)
                      .slice(0, 50)
                      .map((w) => (
                        <li key={w.url} title={w.title}>
                          <span className="fav-preview-title">{w.title}</span>
                          {w.author && <span className="fav-preview-author"> — {w.author}</span>}
                        </li>
                      ))}
                    {toImport > 50 && (
                      <li className="fav-preview-more">…and {toImport - 50} more</li>
                    )}
                  </ul>
                )}

                {cloudEligible && toImport > 0 && (
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
                          ? 'Imported files are uploaded to your account.'
                          : 'Imported files stay on this device only.'}
                      </span>
                    </span>
                  </label>
                )}

                <div className="modal-actions">
                  <button type="button" onClick={() => setDiscovery(null)}>
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleImport}
                    disabled={starting || toImport === 0}
                  >
                    {starting
                      ? 'Starting…'
                      : toImport > 0
                        ? `Import ${toImport} ${toImport === 1 ? 'work' : 'works'}`
                        : 'Nothing to import'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
