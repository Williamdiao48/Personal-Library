import { useState, useId, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSettings } from '../../contexts/SettingsContext'
import { useUpdater } from '../../contexts/UpdaterContext'
import { useAuth } from '../../contexts/AuthContext'
import type { Theme, GridDensity, SortBy, CustomTheme } from '../../contexts/SettingsContext'
import type { SyncStatus } from '../../types'
import CustomSelect from '../ui/CustomSelect'
import { HIGHLIGHT_COLORS } from '../../constants/highlightColors'
import { backupService } from '../../services/backup'
import { llmService } from '../../services/llm'
import { discoverService } from '../../services/discover'
import { syncService } from '../../services/sync'
import { deriveCustomTheme, isValidHex } from '../../utils/themeDerive'
import '../../styles/settings.css'

// ── Built-in theme preview data ──────────────────────────────────────────────

const BUILTIN_THEMES: {
  value: Theme
  label: string
  bg: string
  surface: string
  accent: string
}[] = [
  { value: 'dark', label: 'Dark', bg: '#1a1a1a', surface: '#2e2e2e', accent: '#7c6aff' },
  { value: 'darker', label: 'Darker', bg: '#0d0d0d', surface: '#1a1a1a', accent: '#5b8dee' },
  { value: 'light', label: 'Light', bg: '#f0eff5', surface: '#ffffff', accent: '#6253c9' },
  { value: 'sepia', label: 'Sepia', bg: '#f5f0e8', surface: '#ede8dc', accent: '#9b6b3e' },
  { value: 'ivory', label: 'Ivory', bg: '#fef9e4', surface: '#f7edca', accent: '#c07820' },
  { value: 'slate', label: 'Slate', bg: '#f2f4f7', surface: '#ffffff', accent: '#4a6fa5' },
  { value: 'lavender', label: 'Lavender', bg: '#f4f2fa', surface: '#ece9f5', accent: '#7c5cbf' },
  { value: 'ocean', label: 'Ocean', bg: '#0f1923', surface: '#162433', accent: '#38bdf8' },
  { value: 'nord', label: 'Nord', bg: '#2e3440', surface: '#3b4252', accent: '#88c0d0' },
  { value: 'rose', label: 'Rose', bg: '#1a1015', surface: '#251820', accent: '#f472b6' },
  { value: 'forest', label: 'Forest', bg: '#131a12', surface: '#1c2a1b', accent: '#4ade80' },
  { value: 'high-contrast', label: 'Hi-Con', bg: '#000000', surface: '#0d0d0d', accent: '#03fcf4' },
  { value: 'dusk', label: 'Dusk', bg: '#1a1510', surface: '#252015', accent: '#d4a84b' },
  { value: 'midnight', label: 'Midnight', bg: '#0e0f1e', surface: '#151628', accent: '#a78bfa' },
  { value: 'sand', label: 'Sand', bg: '#f5f2ed', surface: '#ffffff', accent: '#8a6a3e' },
]

const DENSITY_OPTIONS: { value: GridDensity; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'normal', label: 'Normal' },
  { value: 'comfortable', label: 'Comfortable' },
]

const SORT_OPTIONS = [
  { value: 'date_saved', label: 'Date saved' },
  { value: 'last_read', label: 'Last read' },
  { value: 'title', label: 'Title' },
]

// ── Toggle switch ────────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  id,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  id: string
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
  id: string | null // null = creating new
  name: string
  bg: string
  accent: string
  isLight: boolean
}

function CustomThemeEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: EditorState
  onSave: (theme: CustomTheme) => void
  onCancel: () => void
}) {
  const uid = useId()
  const [name, setName] = useState(initial.name)
  const [bg, setBg] = useState(initial.bg)
  const [accent, setAccent] = useState(initial.accent)
  const [isLight, setIsLight] = useState(initial.isLight)

  const bgValid = isValidHex(bg)
  const accentValid = isValidHex(accent)
  const canSave = name.trim().length > 0 && bgValid && accentValid

  const preview =
    bgValid && accentValid
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
            onChange={(e) => setName(e.target.value)}
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
              onChange={(e) => setBg(e.target.value)}
            />
            <input
              className="custom-theme-field-input custom-theme-field-input--hex"
              value={bg}
              onChange={(e) => setBg(e.target.value)}
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
              onChange={(e) => setAccent(e.target.value)}
            />
            <input
              className="custom-theme-field-input custom-theme-field-input--hex"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
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
            >
              Dark
            </button>
            <button
              className={`settings-segment-btn${isLight ? ' selected' : ''}`}
              onClick={() => setIsLight(true)}
              aria-pressed={isLight}
            >
              Light
            </button>
          </div>
        </div>
      </div>

      {preview && (
        <div className="custom-theme-preview-swatch" aria-label="Theme preview">
          <span className="custom-theme-preview-bg" style={{ background: preview.bg }}>
            <span
              className="custom-theme-preview-surface"
              style={{ background: preview.bgSurface }}
            />
            <span className="custom-theme-preview-accent" style={{ background: preview.accent }} />
          </span>
          <span
            className="custom-theme-preview-label"
            style={{ color: preview.text, background: preview.bg }}
          >
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

const NEW_EDITOR: EditorState = {
  id: null,
  name: '',
  bg: '#1a1a1a',
  accent: '#7c6aff',
  isLight: false,
}

// ── Local-LLM (Ollama) book reranker settings ────────────────────────────────
type ProbeState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; hasModel: boolean }
  | { status: 'unreachable' }

type PullState =
  | { status: 'idle' }
  | { status: 'pulling'; percent: number; label: string }
  | { status: 'error'; message: string }

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'

function LlmRerankSettings() {
  const { settings, updateSettings } = useSettings()
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' })
  const [pull, setPull] = useState<PullState>({ status: 'idle' })
  const modelId = useId()
  const urlId = useId()

  async function testConnection() {
    setProbe({ status: 'testing' })
    try {
      const r = await llmService.probe({ model: settings.llmModel, baseUrl: settings.llmBaseUrl })
      setProbe(r.reachable ? { status: 'ok', hasModel: r.hasModel } : { status: 'unreachable' })
    } catch {
      setProbe({ status: 'unreachable' })
    }
  }

  async function downloadModel() {
    setPull({ status: 'pulling', percent: 0, label: 'starting' })
    const unsub = llmService.onPullProgress((p) => {
      setPull({ status: 'pulling', percent: p.percent, label: p.status })
    })
    try {
      const res = await llmService.pullModel({
        model: settings.llmModel,
        baseUrl: settings.llmBaseUrl,
      })
      if (res.ok) {
        setPull({ status: 'idle' })
        void testConnection() // re-probe: the model should now be present
      } else {
        setPull({ status: 'error', message: res.error ?? 'Download failed' })
      }
    } finally {
      unsub()
    }
  }

  const pulling = pull.status === 'pulling'

  return (
    <>
      <div className="settings-row settings-row--top">
        <div className="settings-row-stack">
          <label className="settings-row-label" htmlFor="toggle-llm-rerank">
            Refine book picks with a local AI (experimental)
          </label>
          <span className="settings-row-hint">
            Uses a local Ollama model to reorder book recommendations by fit to your taste. Fully
            offline; falls back to the normal ranking if Ollama isn’t running. Fanfiction is
            unaffected.
          </span>
        </div>
        <Toggle
          id="toggle-llm-rerank"
          checked={settings.llmRerankEnabled}
          onChange={(v) => updateSettings({ llmRerankEnabled: v })}
        />
      </div>

      {settings.llmRerankEnabled && (
        <>
          <div className="settings-row">
            <label className="settings-row-label" htmlFor={modelId}>
              Model
            </label>
            <input
              id={modelId}
              className="settings-color-label-input"
              value={settings.llmModel}
              placeholder="llama3.2:3b"
              onChange={(e) => updateSettings({ llmModel: e.target.value })}
            />
          </div>
          <div className="settings-row">
            <label className="settings-row-label" htmlFor={urlId}>
              Ollama URL
            </label>
            <input
              id={urlId}
              className="settings-color-label-input"
              value={settings.llmBaseUrl}
              placeholder="http://127.0.0.1:11434"
              onChange={(e) => updateSettings({ llmBaseUrl: e.target.value })}
            />
          </div>
          <div className="settings-row">
            <button
              className="settings-action-btn"
              onClick={testConnection}
              disabled={probe.status === 'testing' || pulling}
            >
              {probe.status === 'testing' ? 'Testing…' : 'Test connection'}
            </button>

            {/* Reachable + model present → all set. */}
            {probe.status === 'ok' && probe.hasModel && (
              <span className="settings-feedback">Connected — model ready.</span>
            )}

            {/* Reachable but model missing → offer an in-app download. */}
            {probe.status === 'ok' && !probe.hasModel && !pulling && (
              <button className="settings-action-btn" onClick={downloadModel}>
                Download “{settings.llmModel}”
              </button>
            )}

            {/* Not reachable → Ollama isn't installed or isn't running. */}
            {probe.status === 'unreachable' && (
              <span className="settings-feedback settings-feedback--err">
                Couldn’t reach Ollama.{' '}
                <button
                  className="settings-link-btn"
                  onClick={() => void discoverService.openExternal(OLLAMA_DOWNLOAD_URL)}
                >
                  Install Ollama
                </button>{' '}
                then make sure it’s running.
              </span>
            )}
          </div>

          {/* Live download progress. */}
          {pulling && (
            <div className="settings-row settings-row--top">
              <div className="settings-row-stack" style={{ width: '100%' }}>
                <span className="settings-row-hint">
                  Downloading {settings.llmModel} — {pull.label} {pull.percent}%
                </span>
                <div className="llm-pull-bar">
                  <div className="llm-pull-bar-fill" style={{ width: `${pull.percent}%` }} />
                </div>
              </div>
            </div>
          )}

          {pull.status === 'error' && (
            <div className="settings-row">
              <span className="settings-feedback settings-feedback--err">
                Download failed: {pull.message}
              </span>
            </div>
          )}
        </>
      )}
    </>
  )
}

// ── Account (opt-in cloud) ───────────────────────────────────────────────────
// Phase 1: sign in / create account / sign out. Nothing syncs yet — this only
// establishes identity. When the build has no Supabase creds, the section shows
// a short note instead of a form.

const MIN_PASSWORD_LENGTH = 8

// ── Library sync (Phase 3) ───────────────────────────────────────────────────
// Only rendered inside the signed-in Account block. The toggle is the master
// switch (mirrored to main via App's effect); the row shows live status + a manual
// "Sync now". Status is hydrated on mount and pushed live over 'sync:status'.

function relativeTime(ms: number): string {
  const secs = Math.round((Date.now() - ms) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  return `${Math.round(hrs / 24)} d ago`
}

/** Forward-looking counterpart to relativeTime: "in 45s" / "in 6 min" / "now". */
export function untilTime(ms: number): string {
  const secs = Math.round((ms - Date.now()) / 1000)
  if (secs <= 0) return 'now'
  if (secs < 60) return `in ${secs}s`
  return `in ${Math.round(secs / 60)} min`
}

function SyncSettings() {
  const { settings, updateSettings } = useSettings()
  const [status, setStatus] = useState<SyncStatus | null>(null)

  useEffect(() => {
    if (!window.api?.sync) return
    void Promise.resolve(syncService.getStatus())
      .then(setStatus)
      .catch(() => {})
    return syncService.onStatus(setStatus)
  }, [])

  const running = status?.running ?? false
  const failing = (status?.consecutiveFailures ?? 0) > 0
  const pending = status?.pendingDirty ?? 0

  // While backing off, tick every second so the "next retry" countdown stays live
  // even though status only broadcasts on rounds (which, mid-backoff, are minutes apart).
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!failing) return
    const t = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [failing])

  const detail = failing
    ? `Last sync failed: ${status?.lastError ?? 'unknown error'}`
    : running
      ? 'Syncing…'
      : status?.lastSyncedAt
        ? `Last synced ${relativeTime(status.lastSyncedAt)}`
        : 'Not synced yet this session.'

  return (
    <div className="settings-row settings-row--top">
      <div className="settings-row-stack">
        <label className="settings-row-label" htmlFor="toggle-sync">
          Sync library across devices
        </label>
        <span className="settings-row-hint">
          Keeps your items, tags, collections, reading progress, and annotations in step across your
          signed-in devices. Off keeps this device’s library unchanged.
        </span>
        {settings.enableSync && (
          <span className={`settings-feedback${failing ? ' settings-feedback--err' : ''}`}>
            {detail}
          </span>
        )}
        {settings.enableSync && failing && status?.nextRetryAt != null && (
          <span className="settings-feedback settings-feedback--err">
            {status.consecutiveFailures} failed attempt
            {status.consecutiveFailures > 1 ? 's' : ''} · next retry {untilTime(status.nextRetryAt)}
          </span>
        )}
        {settings.enableSync && pending > 0 && (
          <span className="settings-feedback">
            {pending} change{pending > 1 ? 's' : ''} waiting to sync
          </span>
        )}
      </div>
      <div className="settings-sync-controls">
        <Toggle
          id="toggle-sync"
          checked={settings.enableSync}
          onChange={(v) => updateSettings({ enableSync: v })}
        />
        {settings.enableSync && (
          <button
            className="settings-action-btn settings-action-btn--ghost"
            onClick={() =>
              void Promise.resolve(syncService.now())
                .then(setStatus)
                .catch(() => {})
            }
            disabled={running}
          >
            {running ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>
    </div>
  )
}

function AccountSettings() {
  const {
    user,
    configured,
    loading,
    signIn,
    signUp,
    signOut,
    requestPasswordReset,
    confirmPasswordReset,
    confirmSignup,
    resendConfirmation,
    deleteAccount,
  } = useAuth()
  const { settings, updateSettings } = useSettings()
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [resetSent, setResetSent] = useState(false)
  // Latched after a sign-up that needs email confirmation → show the "check your
  // email" panel with a Resend button (the `email` above is the resend target).
  const [awaitingConfirm, setAwaitingConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const emailId = useId()
  const pwId = useId()
  const codeId = useId()

  // Account-deletion "danger zone" state (signed-in view). Revealed on demand, then
  // gated behind typing the account email so it can never fire on a stray click.
  const [showDelete, setShowDelete] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const deleteConfirmId = useId()

  // On any account change — sign in, sign out, or switching accounts — snap back to a
  // clean slate so one account's typed state never bleeds into the next. A later
  // sign-out lands on a fresh sign-in form (not the reset page, and not pre-filled with
  // the previous email), and the delete "danger zone" never carries a prior account's
  // confirmation text forward into a different account.
  useEffect(() => {
    setMode('signin')
    setEmail('')
    setPassword('')
    setToken('')
    setResetSent(false)
    setAwaitingConfirm(false)
    setError('')
    setNotice('')
    setShowDelete(false)
    setDeleteConfirm('')
    setDeleteError('')
  }, [user])

  // Guard: the destructive button only enables once the typed value matches the
  // account email exactly (trimmed), so deletion is a deliberate, typed confirmation.
  const canDelete = !!user?.email && deleteConfirm.trim() === user.email && !deleting

  async function handleDeleteAccount() {
    if (!canDelete) return
    setDeleting(true)
    setDeleteError('')
    try {
      const res = await deleteAccount()
      if (!res.ok) {
        setDeleteError(res.error ?? 'Could not delete your account. Please try again.')
      }
      // On success main signs out → AuthContext sets user=null → this panel flips back
      // to the sign-in view; no further UI work needed here.
    } catch (err: any) {
      setDeleteError(err?.message ?? 'Could not delete your account. Please try again.')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) return null

  if (!configured) {
    return (
      <span className="settings-row-hint">
        Cloud sync isn’t configured in this build. The app runs fully offline; an account is
        optional and only enables backup and multi-device sync (coming soon).
      </span>
    )
  }

  if (user) {
    return (
      <>
        <div className="settings-row settings-row--top">
          <div className="settings-row-stack">
            <span className="settings-row-label">Signed in</span>
            <span className="settings-row-hint">{user.email ?? user.id}</span>
          </div>
          <button
            className="settings-action-btn settings-action-btn--ghost"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>

        <div className="settings-row settings-row--top">
          <div className="settings-row-stack">
            <label className="settings-row-label" htmlFor="toggle-cloud-backup">
              Back up books to the cloud
            </label>
            <span className="settings-row-hint">
              When on, you choose per book (at capture) whether its file is backed up. Off keeps
              everything on this device — nothing is ever uploaded.
            </span>
          </div>
          <Toggle
            id="toggle-cloud-backup"
            checked={settings.cloudBackupEnabled}
            onChange={(v) => updateSettings({ cloudBackupEnabled: v })}
          />
        </div>

        <SyncSettings />

        <div className="settings-row settings-row--top">
          <div className="settings-row-stack">
            <label className="settings-row-label" htmlFor="toggle-cloud-processing">
              Process files in the cloud
            </label>
            <span className="settings-row-hint">
              When on, imported EPUBs are extracted in an isolated cloud container instead of on
              this device — so an untrusted file is never parsed locally. Falls back to on-device
              parsing when offline.
            </span>
          </div>
          <Toggle
            id="toggle-cloud-processing"
            checked={settings.enableCloudProcessing}
            onChange={(v) => updateSettings({ enableCloudProcessing: v })}
          />
        </div>

        <div className="settings-row settings-row--top settings-danger">
          <div className="settings-row-stack">
            <span className="settings-row-label">Delete account</span>
            <span className="settings-row-hint">
              Permanently deletes your account and all data stored in the cloud. Your library on
              this device stays, but it will no longer sync. This can’t be undone.
            </span>
            {showDelete && (
              <>
                <label className="settings-row-hint" htmlFor={deleteConfirmId}>
                  Type <strong>{user.email ?? user.id}</strong> to confirm.
                </label>
                <input
                  id={deleteConfirmId}
                  type="email"
                  autoComplete="off"
                  className="settings-color-label-input"
                  value={deleteConfirm}
                  placeholder={user.email ?? 'your email'}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleDeleteAccount()
                  }}
                />
                {deleteError && (
                  <span className="settings-feedback settings-feedback--err">{deleteError}</span>
                )}
              </>
            )}
          </div>
          {showDelete ? (
            <button
              className="settings-action-btn settings-action-btn--danger"
              onClick={handleDeleteAccount}
              disabled={!canDelete}
            >
              {deleting ? 'Deleting…' : 'Delete account'}
            </button>
          ) : (
            <button
              className="settings-action-btn settings-action-btn--ghost"
              onClick={() => setShowDelete(true)}
            >
              Delete account…
            </button>
          )}
        </div>
      </>
    )
  }

  // Leave the sign-in/up form for the reset flow, or return from it — clearing any
  // transient field/feedback state so the two flows never bleed into each other.
  function goToMode(next: 'signin' | 'signup' | 'reset') {
    setMode(next)
    setError('')
    setNotice('')
    setResetSent(false)
    setAwaitingConfirm(false)
    setToken('')
    setPassword('')
  }

  const canRequestReset = email.trim().length > 0 && !busy
  const canConfirmReset = token.trim().length > 0 && password.length >= MIN_PASSWORD_LENGTH && !busy

  async function handleRequestReset() {
    if (!canRequestReset) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await requestPasswordReset(email.trim())
      if (!res.ok) {
        setError(res.error ?? 'Something went wrong. Please try again.')
      } else {
        setResetSent(true)
        setNotice(`Code sent to ${email.trim()}.`)
      }
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function handleConfirmReset() {
    if (!canConfirmReset) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await confirmPasswordReset(email.trim(), token.trim(), password)
      if (!res.ok) {
        setError(res.error ?? 'Something went wrong. Please try again.')
      }
      // On success the AuthContext flips to the signed-in view automatically.
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const canConfirmSignup = token.trim().length > 0 && !busy

  async function handleConfirmSignup() {
    if (!canConfirmSignup) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await confirmSignup(email.trim(), token.trim())
      if (!res.ok) {
        setError(res.error ?? 'Something went wrong. Please try again.')
      }
      // On success verifyOtp('signup') establishes a session → the AuthContext flips
      // to the signed-in view automatically (no extra sign-in step).
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function handleResendConfirmation() {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await resendConfirmation(email.trim())
      if (!res.ok) {
        setError(res.error ?? 'Something went wrong. Please try again.')
      } else {
        setNotice(`Confirmation code resent to ${email.trim()}.`)
      }
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (awaitingConfirm) {
    return (
      <>
        <div className="settings-row settings-row--top">
          <div className="settings-row-stack">
            <span className="settings-row-label">Confirm your email</span>
            <span className="settings-row-hint">
              We emailed a 6-digit code to {email.trim()}. Enter it below to confirm and sign in.
            </span>
          </div>
        </div>

        <div className="settings-row">
          <label className="settings-row-label" htmlFor={codeId}>
            Code
          </label>
          <input
            id={codeId}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            className="settings-color-label-input"
            value={token}
            placeholder="Enter code"
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleConfirmSignup()
            }}
          />
        </div>

        <div className="settings-row settings-row--top settings-reset-footer">
          <div className="settings-row-stack">
            {error && <span className="settings-feedback settings-feedback--err">{error}</span>}
            {notice && <span className="settings-feedback settings-feedback--ok">{notice}</span>}
            <button
              className="settings-link-btn settings-link-btn--lg"
              onClick={handleResendConfirmation}
              disabled={busy}
            >
              Didn’t get a code? Resend
            </button>
            <button
              className="settings-link-btn settings-link-btn--lg"
              onClick={() => goToMode('signin')}
            >
              Back to sign in
            </button>
          </div>
          <button
            className="settings-action-btn"
            onClick={handleConfirmSignup}
            disabled={!canConfirmSignup}
          >
            {busy ? 'Confirming…' : 'Confirm'}
          </button>
        </div>
      </>
    )
  }

  if (mode === 'reset') {
    return (
      <>
        <div className="settings-row settings-row--top">
          <div className="settings-row-stack">
            <span className="settings-row-label">Reset password</span>
            <span className="settings-row-hint">
              {resetSent
                ? 'Enter the code we emailed you and choose a new password.'
                : 'We’ll email you a verification code to reset your password.'}
            </span>
          </div>
        </div>

        <div className="settings-row">
          <label className="settings-row-label" htmlFor={emailId}>
            Email
          </label>
          <input
            id={emailId}
            type="email"
            autoComplete="email"
            className="settings-color-label-input"
            value={email}
            placeholder="you@example.com"
            disabled={resetSent}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !resetSent) void handleRequestReset()
            }}
          />
        </div>

        {resetSent && (
          <>
            <div className="settings-row">
              <label className="settings-row-label" htmlFor={codeId}>
                Code
              </label>
              <input
                id={codeId}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="settings-color-label-input"
                value={token}
                placeholder="Enter code"
                onChange={(e) => setToken(e.target.value)}
              />
            </div>

            <div className="settings-row">
              <label className="settings-row-label" htmlFor={pwId}>
                New password
              </label>
              <input
                id={pwId}
                type="password"
                autoComplete="new-password"
                className="settings-color-label-input"
                value={password}
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleConfirmReset()
                }}
              />
            </div>
          </>
        )}

        <div className="settings-row settings-row--top settings-reset-footer">
          <div className="settings-row-stack">
            {error && <span className="settings-feedback settings-feedback--err">{error}</span>}
            {notice && <span className="settings-feedback settings-feedback--ok">{notice}</span>}
            <button
              className="settings-link-btn settings-link-btn--lg"
              onClick={() => goToMode('signin')}
            >
              Back to sign in
            </button>
          </div>
          {resetSent ? (
            <button
              className="settings-action-btn"
              onClick={handleConfirmReset}
              disabled={!canConfirmReset}
            >
              {busy ? 'Resetting…' : 'Reset password'}
            </button>
          ) : (
            <button
              className="settings-action-btn"
              onClick={handleRequestReset}
              disabled={!canRequestReset}
            >
              {busy ? 'Sending…' : 'Send reset code'}
            </button>
          )}
        </div>
      </>
    )
  }

  const canSubmit =
    email.trim().length > 0 &&
    password.length >= (mode === 'signup' ? MIN_PASSWORD_LENGTH : 1) &&
    !busy

  async function handleSubmit() {
    if (!canSubmit) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res =
        mode === 'signup'
          ? await signUp(email.trim(), password)
          : await signIn(email.trim(), password)
      if (!res.ok) {
        setError(res.error ?? 'Something went wrong. Please try again.')
      } else if (res.needsConfirmation) {
        // No session yet — hold the user on the awaiting-confirm panel to enter the
        // emailed code (with Resend) rather than a fleeting toast, so a lost code
        // isn't a dead end.
        setAwaitingConfirm(true)
        setToken('')
        setPassword('')
      }
      // On success the AuthContext flips to the signed-in view automatically.
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="settings-row">
        <div className="settings-segment" role="group" aria-label="Account action">
          <button
            className={`settings-segment-btn${mode === 'signin' ? ' selected' : ''}`}
            onClick={() => goToMode('signin')}
            aria-pressed={mode === 'signin'}
          >
            Sign in
          </button>
          <button
            className={`settings-segment-btn${mode === 'signup' ? ' selected' : ''}`}
            onClick={() => goToMode('signup')}
            aria-pressed={mode === 'signup'}
          >
            Create account
          </button>
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-row-label" htmlFor={emailId}>
          Email
        </label>
        <input
          id={emailId}
          type="email"
          autoComplete="email"
          className="settings-color-label-input"
          value={email}
          placeholder="you@example.com"
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="settings-row">
        <label className="settings-row-label" htmlFor={pwId}>
          Password
        </label>
        <input
          id={pwId}
          type="password"
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          className="settings-color-label-input"
          value={password}
          placeholder={
            mode === 'signup' ? `At least ${MIN_PASSWORD_LENGTH} characters` : '••••••••'
          }
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSubmit()
          }}
        />
      </div>

      <div className="settings-row settings-row--top">
        <div className="settings-row-stack">
          {mode === 'signup' && (
            <span className="settings-row-hint">
              Passwords must be at least {MIN_PASSWORD_LENGTH} characters.
            </span>
          )}
          {mode === 'signin' && (
            <button
              className="settings-link-btn settings-link-btn--lg"
              onClick={() => goToMode('reset')}
            >
              Forgot password?
            </button>
          )}
          {error && <span className="settings-feedback settings-feedback--err">{error}</span>}
          {notice && <span className="settings-feedback settings-feedback--ok">{notice}</span>}
        </div>
        <button className="settings-action-btn" onClick={handleSubmit} disabled={!canSubmit}>
          {busy
            ? mode === 'signup'
              ? 'Creating…'
              : 'Signing in…'
            : mode === 'signup'
              ? 'Create account'
              : 'Sign in'}
        </button>
      </div>
    </>
  )
}

export default function SettingsView() {
  const navigate = useNavigate()
  const { settings, updateSettings } = useSettings()
  const { pendingVersion, setPendingVersion } = useUpdater()

  const [exportState, setExportState] = useState<ExportState>('idle')
  const [exportMessage, setExportMessage] = useState('')
  const [importState, setImportState] = useState<ImportState>('idle')
  const [importError, setImportError] = useState('')

  // Custom theme editor state
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorState, setEditorState] = useState<EditorState>(NEW_EDITOR)

  async function handleExport() {
    setExportState('busy')
    setExportMessage('')
    try {
      const result = await backupService.export()
      if (!result) {
        setExportState('idle')
        return
      }
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
    const existing = settings.customThemes.find((t) => t.id === theme.id)
    const updated = existing
      ? settings.customThemes.map((t) => (t.id === theme.id ? theme : t))
      : [...settings.customThemes, theme]
    updateSettings({ customThemes: updated, theme: theme.id })
    setEditorOpen(false)
  }

  function handleDeleteCustomTheme(id: string) {
    const updated = settings.customThemes.filter((t) => t.id !== id)
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
              {BUILTIN_THEMES.map((t) => (
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
                    <span
                      className="settings-theme-preview-stripe"
                      style={{ background: t.surface }}
                    />
                    <span
                      className="settings-theme-preview-accent"
                      style={{ background: t.accent }}
                    />
                  </span>
                  <span className="settings-theme-label">{t.label}</span>
                </button>
              ))}

              {/* Custom theme swatches */}
              {settings.customThemes.map((t) => (
                <button
                  key={t.id}
                  className={`settings-theme-swatch${settings.theme === t.id ? ' selected' : ''}`}
                  onClick={() => updateSettings({ theme: t.id })}
                  aria-pressed={settings.theme === t.id}
                  title={t.name}
                >
                  <span
                    className="settings-theme-preview"
                    style={{ background: t.bg }}
                    aria-hidden="true"
                  >
                    <span
                      className="settings-theme-preview-stripe"
                      style={{ background: t.bgSurface }}
                    />
                    <span
                      className="settings-theme-preview-accent"
                      style={{ background: t.accent }}
                    />
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
              {settings.customThemes.map((t) => (
                <div key={t.id} className="custom-theme-row">
                  <span
                    className="custom-theme-row-swatch"
                    style={{ background: t.bg, borderColor: t.border }}
                  >
                    <span style={{ background: t.accent }} />
                  </span>
                  <span className="custom-theme-row-name">{t.name}</span>
                  <div className="custom-theme-row-actions">
                    <button className="custom-theme-row-btn" onClick={() => openEditEditor(t)}>
                      Edit
                    </button>
                    <button
                      className="custom-theme-row-btn custom-theme-row-btn--danger"
                      onClick={() => handleDeleteCustomTheme(t.id)}
                    >
                      Delete
                    </button>
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
            <label className="settings-row-label" htmlFor="toggle-authors">
              Show authors
            </label>
            <Toggle
              id="toggle-authors"
              checked={settings.showAuthors}
              onChange={(v) => updateSettings({ showAuthors: v })}
            />
          </div>

          <div className="settings-row">
            <label className="settings-row-label" htmlFor="toggle-progress">
              Show progress bar
            </label>
            <Toggle
              id="toggle-progress"
              checked={settings.showProgress}
              onChange={(v) => updateSettings({ showProgress: v })}
            />
          </div>
        </section>

        {/* ── Discover ── */}
        <section className="settings-section">
          <h3 className="settings-section-title">Discover</h3>

          <div className="settings-row settings-row--top">
            <div className="settings-row-stack">
              <label className="settings-row-label" htmlFor="toggle-discover">
                Enable recommendations
              </label>
              <span className="settings-row-hint">
                Shows the Discover panel, which suggests fics and books based on your library.
              </span>
            </div>
            <Toggle
              id="toggle-discover"
              checked={settings.enableDiscover}
              onChange={(v) => updateSettings({ enableDiscover: v })}
            />
          </div>

          {settings.enableDiscover && <LlmRerankSettings />}
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
              onChange={(val) => updateSettings({ defaultSort: val as SortBy })}
              options={SORT_OPTIONS}
            />
          </div>
        </section>

        {/* ── Annotations ── */}
        <section className="settings-section">
          <h3 className="settings-section-title">Annotations</h3>

          <div className="settings-row settings-row--top">
            <div className="settings-row-stack">
              <label className="settings-row-label" htmlFor="toggle-color-meanings">
                Color meanings
              </label>
              <span className="settings-row-hint">
                Give each highlight color a meaning. These labels show as categories in the
                Annotations view and in exports, and as tooltips on the color swatches.
              </span>
            </div>
            <Toggle
              id="toggle-color-meanings"
              checked={settings.highlightLabelsEnabled}
              onChange={(v) => updateSettings({ highlightLabelsEnabled: v })}
            />
          </div>

          {settings.highlightLabelsEnabled &&
            HIGHLIGHT_COLORS.map((c) => (
              <div className="settings-row" key={c.key}>
                <span
                  className="settings-color-swatch"
                  style={{ background: c.swatch }}
                  aria-hidden="true"
                />
                <input
                  className="settings-color-label-input"
                  value={settings.highlightLabels[c.key]}
                  placeholder={c.label}
                  aria-label={`${c.label} highlight label`}
                  onChange={(e) =>
                    updateSettings({
                      highlightLabels: { ...settings.highlightLabels, [c.key]: e.target.value },
                    })
                  }
                />
              </div>
            ))}
        </section>

        {/* ── Data ── */}
        <section className="settings-section">
          <h3 className="settings-section-title">Data</h3>

          <div className="settings-row settings-row--top">
            <div className="settings-row-stack">
              <span className="settings-row-label">Export library</span>
              <span className="settings-row-hint">
                Saves a .plbackup file with all items, covers, tags, collections, and reading
                progress.
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
                onClick={() => {
                  setImportError('')
                  setImportState('confirming')
                }}
                disabled={importState === 'busy'}
              >
                {importState === 'busy' ? 'Importing…' : 'Import'}
              </button>
            )}
          </div>
        </section>

        {/* ── Account (opt-in cloud) ── */}
        <section className="settings-section">
          <h3 className="settings-section-title">Account</h3>
          <AccountSettings />
        </section>

        {import.meta.env.DEV && (
          <section className="settings-section">
            <h2 className="settings-section-title">Developer</h2>
            <div className="settings-row">
              <div className="settings-row-stack">
                <span className="settings-label">Simulate update notification</span>
                <span className="settings-hint">
                  Tests the sidebar update button and toast flow.
                </span>
              </div>
              {pendingVersion ? (
                <button
                  className="settings-action-btn settings-action-btn--ghost"
                  onClick={() => setPendingVersion(null)}
                >
                  Clear (v{pendingVersion})
                </button>
              ) : (
                <button className="settings-action-btn" onClick={() => setPendingVersion('99.9.9')}>
                  Simulate
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
