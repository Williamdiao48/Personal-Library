import { useEffect, useState } from 'react'
import { useSettings } from '../../contexts/SettingsContext'
import type { Theme, GridDensity, SortBy } from '../../contexts/SettingsContext'
import CustomSelect from '../ui/CustomSelect'
import { backupService } from '../../services/backup'

// ── Theme preview data ──────────────────────────────────────────────────────

const THEMES: {
  value:   Theme
  label:   string
  bg:      string
  surface: string
  accent:  string
}[] = [
  { value: 'dark',          label: 'Dark',     bg: '#1a1a1a', surface: '#2e2e2e', accent: '#7c6aff' },
  { value: 'darker',        label: 'Darker',   bg: '#0d0d0d', surface: '#1a1a1a', accent: '#5b8dee' },
  { value: 'light',         label: 'Light',    bg: '#f0eff5', surface: '#ffffff', accent: '#6253c9' },
  { value: 'sepia',         label: 'Sepia',    bg: '#f5f0e8', surface: '#ede8dc', accent: '#9b6b3e' },
  { value: 'ocean',         label: 'Ocean',    bg: '#0f1923', surface: '#162433', accent: '#38bdf8' },
  { value: 'nord',          label: 'Nord',     bg: '#2e3440', surface: '#3b4252', accent: '#88c0d0' },
  { value: 'rose',          label: 'Rose',     bg: '#1a1015', surface: '#251820', accent: '#f472b6' },
  { value: 'forest',        label: 'Forest',   bg: '#131a12', surface: '#1c2a1b', accent: '#4ade80' },
  { value: 'high-contrast', label: 'Hi-Con',   bg: '#000000', surface: '#0d0d0d', accent: '#03fcf4' },
]

const DENSITY_OPTIONS: { value: GridDensity; label: string }[] = [
  { value: 'compact',     label: 'Compact'     },
  { value: 'normal',      label: 'Normal'      },
  { value: 'comfortable', label: 'Comfortable' },
]

const SORT_OPTIONS = [
  { value: 'date_saved', label: 'Date saved' },
  { value: 'last_read',  label: 'Last read'  },
  { value: 'title',      label: 'Title'      },
]

// ── Toggle switch ───────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  id,
}: {
  checked:  boolean
  onChange: (value: boolean) => void
  id:       string
}) {
  return (
    <button
      id={id}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`settings-toggle${checked ? ' on' : ''}`}
    >
      <span className="settings-toggle-thumb" aria-hidden="true" />
    </button>
  )
}

// ── Settings modal ──────────────────────────────────────────────────────────

type ExportState = 'idle' | 'busy' | 'success' | 'error'
type ImportState = 'idle' | 'confirming' | 'busy' | 'error'

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const { settings, updateSettings } = useSettings()

  const [exportState,   setExportState]   = useState<ExportState>('idle')
  const [exportMessage, setExportMessage] = useState('')
  const [importState,   setImportState]   = useState<ImportState>('idle')
  const [importError,   setImportError]   = useState('')

  async function handleExport() {
    setExportState('busy')
    setExportMessage('')
    try {
      const result = await backupService.export()
      if (!result) { setExportState('idle'); return }
      const mb = (result.fileSizeBytes / 1024 / 1024).toFixed(1)
      setExportMessage(`Saved — ${result.itemCount} items, ${mb} MB`)
      setExportState('success')
      setTimeout(() => setExportState('idle'), 4000)
    } catch (err: any) {
      setExportMessage(err?.message ?? 'Export failed')
      setExportState('error')
    }
  }

  async function handleImportConfirm() {
    setImportState('busy')
    setImportError('')
    try {
      await backupService.import()
      // app relaunches — this line never runs
    } catch (err: any) {
      setImportError(err?.message ?? 'Import failed')
      setImportState('error')
    }
  }

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="settings-modal-header">
          <h2 id="settings-title">Settings</h2>
          <button
            className="settings-modal-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <path d="M1 1l10 10M11 1L1 11" />
            </svg>
          </button>
        </div>

        {/* ── Appearance ── */}
        <section className="settings-section">
          <h3 className="settings-section-title">Appearance</h3>

          <div className="settings-row settings-row--column">
            <span className="settings-row-label">Theme</span>
            <div className="settings-theme-swatches">
              {THEMES.map(t => (
                <button
                  key={t.value}
                  className={`settings-theme-swatch${settings.theme === t.value ? ' selected' : ''}`}
                  onClick={() => updateSettings({ theme: t.value })}
                  aria-pressed={settings.theme === t.value}
                  title={t.label}
                >
                  <span
                    className="settings-theme-preview"
                    style={{ background: t.bg }}
                    aria-hidden="true"
                  >
                    <span className="settings-theme-preview-stripe" style={{ background: t.surface }} />
                    <span className="settings-theme-preview-accent" style={{ background: t.accent }} />
                  </span>
                  <span className="settings-theme-label">{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="settings-row">
            <span className="settings-row-label">Grid density</span>
            <div className="settings-segment" role="group" aria-label="Grid density">
              {DENSITY_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  className={`settings-segment-btn${settings.gridDensity === value ? ' selected' : ''}`}
                  onClick={() => updateSettings({ gridDensity: value })}
                  aria-pressed={settings.gridDensity === value}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* ── Display ── */}
        <section className="settings-section">
          <h3 className="settings-section-title">Display</h3>

          <div className="settings-row">
            <label className="settings-row-label" htmlFor="toggle-authors">
              Show authors
            </label>
            <Toggle
              id="toggle-authors"
              checked={settings.showAuthors}
              onChange={v => updateSettings({ showAuthors: v })}
            />
          </div>

          <div className="settings-row">
            <label className="settings-row-label" htmlFor="toggle-progress">
              Show progress bar
            </label>
            <Toggle
              id="toggle-progress"
              checked={settings.showProgress}
              onChange={v => updateSettings({ showProgress: v })}
            />
          </div>
        </section>

        {/* ── Reading ── */}
        <section className="settings-section">
          <h3 className="settings-section-title">Reading</h3>

          <div className="settings-row">
            <span className="settings-row-label">Default sort</span>
            <CustomSelect
              label=""
              includePlaceholder={false}
              value={settings.defaultSort}
              onChange={val => updateSettings({ defaultSort: val as SortBy })}
              options={SORT_OPTIONS}
            />
          </div>
        </section>

        {/* ── Data ── */}
        <section className="settings-section">
          <h3 className="settings-section-title">Data</h3>

          {/* Export */}
          <div className="settings-row settings-row--top">
            <div className="settings-row-stack">
              <span className="settings-row-label">Export library</span>
              <span className="settings-row-hint">
                Saves a .plbackup file with all items, covers, tags, collections, and reading progress.
              </span>
              {exportState === 'success' && (
                <span className="settings-feedback settings-feedback--ok">{exportMessage}</span>
              )}
              {exportState === 'error' && (
                <span className="settings-feedback settings-feedback--err">{exportMessage}</span>
              )}
            </div>
            <button
              className="settings-action-btn"
              onClick={handleExport}
              disabled={exportState === 'busy'}
            >
              {exportState === 'busy' ? 'Exporting…' : 'Export'}
            </button>
          </div>

          {/* Import */}
          <div className="settings-row settings-row--top">
            <div className="settings-row-stack">
              <span className="settings-row-label">Import library</span>
              <span className="settings-row-hint">
                Replaces your current library. Export first to keep existing data.
              </span>
              {importState === 'confirming' && (
                <span className="settings-feedback settings-feedback--warn">
                  Replace your entire library? This cannot be undone.
                </span>
              )}
              {importState === 'error' && (
                <span className="settings-feedback settings-feedback--err">{importError}</span>
              )}
            </div>
            {importState === 'confirming' ? (
              <div className="settings-confirm-row">
                <button
                  className="settings-action-btn settings-action-btn--danger"
                  onClick={handleImportConfirm}
                >
                  Replace
                </button>
                <button
                  className="settings-action-btn settings-action-btn--ghost"
                  onClick={() => setImportState('idle')}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="settings-action-btn"
                onClick={() => { setImportError(''); setImportState('confirming') }}
                disabled={importState === 'busy'}
              >
                {importState === 'busy' ? 'Importing…' : 'Import'}
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
