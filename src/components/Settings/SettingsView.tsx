import { useState, useId } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSettings } from '../../contexts/SettingsContext'
import type { Theme, GridDensity, SortBy, CustomTheme } from '../../contexts/SettingsContext'
import CustomSelect from '../ui/CustomSelect'
import { backupService } from '../../services/backup'
import { deriveCustomTheme, isValidHex } from '../../utils/themeDerive'
import '../../styles/settings.css'

// ── Built-in theme preview data ──────────────────────────────────────────────

const BUILTIN_THEMES: {
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
  { value: 'ivory',         label: 'Ivory',    bg: '#faf7f0', surface: '#f3ede0', accent: '#b5601a' },
  { value: 'slate',         label: 'Slate',    bg: '#f2f4f7', surface: '#ffffff', accent: '#4a6fa5' },
  { value: 'lavender',      label: 'Lavender', bg: '#f4f2fa', surface: '#ece9f5', accent: '#7c5cbf' },
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

// ── Toggle switch ────────────────────────────────────────────────────────────

function Toggle({
  checked, onChange, id,
}: {
  checked: boolean; onChange: (v: boolean) => void; id: string
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

// ── Custom theme editor form ─────────────────────────────────────────────────

interface EditorState {
  id:      string | null   // null = creating new
  name:    string
  bg:      string
  accent:  string
  isLight: boolean
}

function CustomThemeEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial:  EditorState
  onSave:   (theme: CustomTheme) => void
  onCancel: () => void
}) {
  const uid = useId()
  const [name,    setName]    = useState(initial.name)
  const [bg,      setBg]      = useState(initial.bg)
  const [accent,  setAccent]  = useState(initial.accent)
  const [isLight, setIsLight] = useState(initial.isLight)

  const bgValid     = isValidHex(bg)
  const accentValid = isValidHex(accent)
  const canSave     = name.trim().length > 0 && bgValid && accentValid

  const preview = (bgValid && accentValid)
    ? deriveCustomTheme(initial.id ?? 'preview', name || 'Preview', bg, accent, isLight)
    : null

  function handleSave() {
    if (!canSave) return
    const id = initial.id ?? crypto.randomUUID()
    onSave(deriveCustomTheme(id, name.trim(), bg, accent, isLight))
  }

  return (
    <div className="custom-theme-editor">
      <div className="custom-theme-editor-fields">
        <label className="custom-theme-field">
          <span className="custom-theme-field-label">Name</span>
          <input
            className="custom-theme-field-input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="My theme"
            maxLength={32}
          />
        </label>

        <label className="custom-theme-field">
          <span className="custom-theme-field-label">Background</span>
          <div className="custom-theme-color-row">
            <input
              type="color"
              className="custom-theme-color-picker"
              value={bgValid ? bg : '#1a1a1a'}
              onChange={e => setBg(e.target.value)}
            />
            <input
              className="custom-theme-field-input custom-theme-field-input--hex"
              value={bg}
              onChange={e => setBg(e.target.value)}
              placeholder="#1a1a1a"
              maxLength={7}
            />
          </div>
        </label>

        <label className="custom-theme-field">
          <span className="custom-theme-field-label">Accent</span>
          <div className="custom-theme-color-row">
            <input
              type="color"
              className="custom-theme-color-picker"
              value={accentValid ? accent : '#7c6aff'}
              onChange={e => setAccent(e.target.value)}
            />
            <input
              className="custom-theme-field-input custom-theme-field-input--hex"
              value={accent}
              onChange={e => setAccent(e.target.value)}
              placeholder="#7c6aff"
              maxLength={7}
            />
          </div>
        </label>

        <div className="custom-theme-field">
          <span className="custom-theme-field-label">Style</span>
          <div className="settings-segment" role="group" aria-label="Theme style" id={uid}>
            <button
              className={`settings-segment-btn${!isLight ? ' selected' : ''}`}
              onClick={() => setIsLight(false)}
              aria-pressed={!isLight}
            >Dark</button>
            <button
              className={`settings-segment-btn${isLight ? ' selected' : ''}`}
              onClick={() => setIsLight(true)}
              aria-pressed={isLight}
            >Light</button>
          </div>
        </div>
      </div>

      {preview && (
        <div className="custom-theme-preview-swatch" aria-label="Theme preview">
          <span className="custom-theme-preview-bg"    style={{ background: preview.bg }}>
            <span className="custom-theme-preview-surface" style={{ background: preview.bgSurface }} />
            <span className="custom-theme-preview-accent"  style={{ background: preview.accent }} />
          </span>
          <span className="custom-theme-preview-label" style={{ color: preview.text, background: preview.bg }}>
            {name || 'Preview'}
          </span>
        </div>
      )}

      <div className="custom-theme-editor-actions">
        <button className="settings-action-btn" onClick={handleSave} disabled={!canSave}>
          Save theme
        </button>
        <button className="settings-action-btn settings-action-btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Main settings view ───────────────────────────────────────────────────────

type ExportState = 'idle' | 'busy' | 'success' | 'error'
type ImportState = 'idle' | 'confirming' | 'busy' | 'error'

const NEW_EDITOR: EditorState = { id: null, name: '', bg: '#1a1a1a', accent: '#7c6aff', isLight: false }

export default function SettingsView() {
  const navigate = useNavigate()
  const { settings, updateSettings } = useSettings()

  const [exportState,   setExportState]   = useState<ExportState>('idle')
  const [exportMessage, setExportMessage] = useState('')
  const [importState,   setImportState]   = useState<ImportState>('idle')
  const [importError,   setImportError]   = useState('')

  // Custom theme editor state
  const [editorOpen,  setEditorOpen]  = useState(false)
  const [editorState, setEditorState] = useState<EditorState>(NEW_EDITOR)

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
    } catch (err: any) {
      setImportError(err?.message ?? 'Import failed')
      setImportState('error')
    }
  }

  function openNewEditor() {
    setEditorState(NEW_EDITOR)
    setEditorOpen(true)
  }

  function openEditEditor(t: CustomTheme) {
    setEditorState({ id: t.id, name: t.name, bg: t.bg, accent: t.accent, isLight: t.isLight })
    setEditorOpen(true)
  }

  function handleSaveCustomTheme(theme: CustomTheme) {
    const existing = settings.customThemes.find(t => t.id === theme.id)
    const updated  = existing
      ? settings.customThemes.map(t => t.id === theme.id ? theme : t)
      : [...settings.customThemes, theme]
    updateSettings({ customThemes: updated, theme: theme.id })
    setEditorOpen(false)
  }

  function handleDeleteCustomTheme(id: string) {
    const updated = settings.customThemes.filter(t => t.id !== id)
    updateSettings({
      customThemes: updated,
      theme: settings.theme === id ? 'dark' : settings.theme,
    })
  }

  return (
    <div className="settings-layout">
      <header className="settings-page-header">
        <button className="settings-page-back-btn" onClick={() => navigate('/')}>
          ← Library
        </button>
        <h1 className="settings-page-title">Settings</h1>
      </header>

      <div className="settings-page-body">

        {/* ── Appearance ── */}
        <section className="settings-section">
          <h3 className="settings-section-title">Appearance</h3>

          <div className="settings-row settings-row--column">
            <span className="settings-row-label">Theme</span>
            <div className="settings-theme-swatches">
              {BUILTIN_THEMES.map(t => (
                <button
                  key={t.value}
                  className={`settings-theme-swatch${settings.theme === t.value ? ' selected' : ''}`}
                  onClick={() => updateSettings({ theme: t.value })}
                  aria-pressed={settings.theme === t.value}
                  title={t.label}
                >
                  <span className="settings-theme-preview" style={{ background: t.bg }} aria-hidden="true">
                    <span className="settings-theme-preview-stripe" style={{ background: t.surface }} />
                    <span className="settings-theme-preview-accent" style={{ background: t.accent }} />
                  </span>
                  <span className="settings-theme-label">{t.label}</span>
                </button>
              ))}

              {/* Custom theme swatches */}
              {settings.customThemes.map(t => (
                <button
                  key={t.id}
                  className={`settings-theme-swatch${settings.theme === t.id ? ' selected' : ''}`}
                  onClick={() => updateSettings({ theme: t.id })}
                  aria-pressed={settings.theme === t.id}
                  title={t.name}
                >
                  <span className="settings-theme-preview" style={{ background: t.bg }} aria-hidden="true">
                    <span className="settings-theme-preview-stripe" style={{ background: t.bgSurface }} />
                    <span className="settings-theme-preview-accent" style={{ background: t.accent }} />
                  </span>
                  <span className="settings-theme-label">{t.name}</span>
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

        {/* ── Custom themes ── */}
        <section className="settings-section">
          <h3 className="settings-section-title">Custom Themes</h3>

          {settings.customThemes.length > 0 && (
            <div className="custom-theme-list">
              {settings.customThemes.map(t => (
                <div key={t.id} className="custom-theme-row">
                  <span
                    className="custom-theme-row-swatch"
                    style={{ background: t.bg, borderColor: t.border }}
                  >
                    <span style={{ background: t.accent }} />
                  </span>
                  <span className="custom-theme-row-name">{t.name}</span>
                  <div className="custom-theme-row-actions">
                    <button
                      className="custom-theme-row-btn"
                      onClick={() => openEditEditor(t)}
                    >Edit</button>
                    <button
                      className="custom-theme-row-btn custom-theme-row-btn--danger"
                      onClick={() => handleDeleteCustomTheme(t.id)}
                    >Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {editorOpen ? (
            <CustomThemeEditor
              initial={editorState}
              onSave={handleSaveCustomTheme}
              onCancel={() => setEditorOpen(false)}
            />
          ) : (
            <button className="settings-action-btn custom-theme-add-btn" onClick={openNewEditor}>
              + Create custom theme
            </button>
          )}
        </section>

        {/* ── Display ── */}
        <section className="settings-section">
          <h3 className="settings-section-title">Display</h3>

          <div className="settings-row">
            <label className="settings-row-label" htmlFor="toggle-authors">Show authors</label>
            <Toggle id="toggle-authors" checked={settings.showAuthors} onChange={v => updateSettings({ showAuthors: v })} />
          </div>

          <div className="settings-row">
            <label className="settings-row-label" htmlFor="toggle-progress">Show progress bar</label>
            <Toggle id="toggle-progress" checked={settings.showProgress} onChange={v => updateSettings({ showProgress: v })} />
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

          <div className="settings-row settings-row--top">
            <div className="settings-row-stack">
              <span className="settings-row-label">Export library</span>
              <span className="settings-row-hint">
                Saves a .plbackup file with all items, covers, tags, collections, and reading progress.
              </span>
              {exportState === 'success' && <span className="settings-feedback settings-feedback--ok">{exportMessage}</span>}
              {exportState === 'error'   && <span className="settings-feedback settings-feedback--err">{exportMessage}</span>}
            </div>
            <button className="settings-action-btn" onClick={handleExport} disabled={exportState === 'busy'}>
              {exportState === 'busy' ? 'Exporting…' : 'Export'}
            </button>
          </div>

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
              {importState === 'error' && <span className="settings-feedback settings-feedback--err">{importError}</span>}
            </div>
            {importState === 'confirming' ? (
              <div className="settings-confirm-row">
                <button className="settings-action-btn settings-action-btn--danger" onClick={handleImportConfirm}>Replace</button>
                <button className="settings-action-btn settings-action-btn--ghost"  onClick={() => setImportState('idle')}>Cancel</button>
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
