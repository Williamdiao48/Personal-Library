import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import SettingsView from './SettingsView'
import { SettingsProvider } from '../../contexts/SettingsContext'
import { UpdaterProvider } from '../../contexts/UpdaterContext'
import { AuthProvider } from '../../contexts/AuthContext'

vi.mock('../../services/backup', () => ({
  backupService: { export: vi.fn(), import: vi.fn() },
}))

// Library sync (Phase 3): mock the thin service; the component talks only to it.
vi.mock('../../services/sync', () => ({
  syncService: {
    getStatus: vi.fn(),
    setEnabled: vi.fn(),
    now: vi.fn(),
    onStatus: vi.fn(() => () => {}),
  },
}))

// Account section: keep it in its unconfigured (offline) state for these tests —
// they cover appearance/data, not auth. The auth flow has its own suite.
vi.mock('../../services/auth', () => ({
  authService: {
    isConfigured: vi.fn().mockResolvedValue(false),
    getSession: vi.fn().mockResolvedValue({ user: null }),
    signUp: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    requestPasswordReset: vi.fn(),
    confirmPasswordReset: vi.fn(),
    onStateChange: vi.fn(() => () => {}),
  },
}))
import { backupService } from '../../services/backup'
const backup = backupService as unknown as {
  export: ReturnType<typeof vi.fn>
  import: ReturnType<typeof vi.fn>
}
import { authService } from '../../services/auth'
const auth = authService as unknown as Record<string, ReturnType<typeof vi.fn>>
import { syncService } from '../../services/sync'
const sync = syncService as unknown as Record<string, ReturnType<typeof vi.fn>>

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <UpdaterProvider>
        <SettingsProvider>
          <AuthProvider>
            <Routes>
              <Route path="/settings" element={<SettingsView />} />
              <Route path="/" element={<div>LIBRARY HOME</div>} />
            </Routes>
          </AuthProvider>
        </SettingsProvider>
      </UpdaterProvider>
    </MemoryRouter>,
  )
}

/** Open the editor and fill in a valid custom theme with the given name. */
function createTheme(name: string) {
  fireEvent.click(screen.getByRole('button', { name: '+ Create custom theme' }))
  fireEvent.change(screen.getByPlaceholderText('My theme'), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Save theme' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  // SyncSettings' mount effect guards on window.api?.sync; give it a truthy stub
  // (the service itself is mocked, so these props are never actually called).
  ;(window as unknown as { api: unknown }).api = { sync: {} }
  sync.getStatus.mockResolvedValue(undefined)
  sync.onStatus.mockReturnValue(() => {})
})

describe('SettingsView — navigation & appearance', () => {
  it('navigates back to the library', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: '← Library' }))
    expect(screen.getByText('LIBRARY HOME')).toBeInTheDocument()
  })

  it('selects a built-in theme swatch', () => {
    renderView()
    const nord = screen.getByRole('button', { name: 'Nord' })
    expect(nord).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(nord)
    expect(nord).toHaveAttribute('aria-pressed', 'true')
  })

  it('toggles display options, grid density, and default sort', async () => {
    const user = userEvent.setup()
    renderView()

    const authors = screen.getByRole('switch', { name: 'Show authors' })
    fireEvent.click(authors)
    expect(authors).toHaveAttribute('aria-checked', 'false')

    const progress = screen.getByRole('switch', { name: 'Show progress bar' })
    fireEvent.click(progress)
    expect(progress).toHaveAttribute('aria-checked', 'false')

    const comfortable = screen.getByRole('button', { name: 'Comfortable' })
    fireEvent.click(comfortable)
    expect(comfortable).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: ': Date saved' }))
    await user.click(screen.getByRole('option', { name: 'Last read' }))
    expect(screen.getByRole('button', { name: ': Last read' })).toBeInTheDocument()
  })

  it('hides the per-color label inputs when color meanings are toggled off', () => {
    renderView()
    const toggle = screen.getByRole('switch', { name: 'Color meanings' })
    // On by default → the four editable meaning inputs are present.
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('Yellow highlight label')).toBeInTheDocument()
    expect(screen.getAllByPlaceholderText(/^(Yellow|Green|Blue|Pink)$/)).toHaveLength(4)
    // Toggling off hides them.
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByLabelText('Yellow highlight label')).toBeNull()
  })
})

describe('SettingsView — custom theme editor', () => {
  it('disables Save until the name and hex fields are valid', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: '+ Create custom theme' }))
    const save = screen.getByRole('button', { name: 'Save theme' })
    expect(save).toBeDisabled() // name empty

    fireEvent.change(screen.getByPlaceholderText('My theme'), { target: { value: 'Sunset' } })
    expect(save).toBeEnabled()

    fireEvent.change(screen.getByPlaceholderText('#1a1a1a'), { target: { value: 'not-hex' } })
    expect(save).toBeDisabled() // invalid bg hex
  })

  it('hides the live preview swatch while a hex field is invalid', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: '+ Create custom theme' }))
    expect(screen.getByLabelText('Theme preview')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('#7c6aff'), { target: { value: '#zzz' } })
    expect(screen.queryByLabelText('Theme preview')).toBeNull()
  })

  it('syncs the hex field when a native color picker changes', () => {
    const { container } = renderView()
    fireEvent.click(screen.getByRole('button', { name: '+ Create custom theme' }))
    const [bgPicker, accentPicker] = Array.from(
      container.querySelectorAll<HTMLInputElement>('.custom-theme-color-picker'),
    )
    fireEvent.change(bgPicker, { target: { value: '#00ff00' } })
    expect(screen.getByPlaceholderText('#1a1a1a')).toHaveValue('#00ff00')
    fireEvent.change(accentPicker, { target: { value: '#ff00ff' } })
    expect(screen.getByPlaceholderText('#7c6aff')).toHaveValue('#ff00ff')
  })

  it('creates → edits → deletes a custom theme (round trip)', () => {
    renderView()

    // Create
    createTheme('Sunset')
    const row = screen
      .getByText('Sunset', { selector: '.custom-theme-row-name' })
      .closest('.custom-theme-row') as HTMLElement
    expect(row).not.toBeNull()
    // Selected as the active theme after creation
    expect(screen.getByRole('button', { name: 'Sunset' })).toHaveAttribute('aria-pressed', 'true')

    // Edit → rename
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByPlaceholderText('My theme'), { target: { value: 'Sunrise' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save theme' }))
    expect(screen.getByText('Sunrise', { selector: '.custom-theme-row-name' })).toBeInTheDocument()
    expect(screen.queryByText('Sunset')).toBeNull()

    // Delete → gone, and the create button returns
    const row2 = screen
      .getByText('Sunrise', { selector: '.custom-theme-row-name' })
      .closest('.custom-theme-row') as HTMLElement
    fireEvent.click(within(row2).getByRole('button', { name: 'Delete' }))
    expect(screen.queryByText('Sunrise')).toBeNull()
    expect(screen.getByRole('button', { name: '+ Create custom theme' })).toBeInTheDocument()
  })

  it('cancels the editor without adding a theme', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: '+ Create custom theme' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: '+ Create custom theme' })).toBeInTheDocument()
  })
})

describe('SettingsView — data export/import', () => {
  it('shows formatted export success feedback', async () => {
    backup.export.mockResolvedValue({ itemCount: 5, fileSizeBytes: 1024 * 1024 })
    renderView()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    })
    expect(screen.getByText('Saved — 5 items, 1.0 MB')).toBeInTheDocument()
  })

  it('surfaces an export error', async () => {
    backup.export.mockRejectedValue(new Error('no disk'))
    renderView()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    })
    expect(screen.getByText('no disk')).toBeInTheDocument()
  })

  it('stays idle when export returns null (cancelled save)', async () => {
    backup.export.mockResolvedValue(null)
    renderView()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    })
    expect(screen.queryByText(/Saved —/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
  })

  it('requires a two-step confirm before importing', async () => {
    backup.import.mockResolvedValue(undefined)
    renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(screen.getByText(/Replace your entire library/)).toBeInTheDocument()
    expect(backup.import).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    })
    expect(backup.import).toHaveBeenCalledOnce()
  })

  it('surfaces an import error and cancels back to idle', async () => {
    backup.import.mockRejectedValue(new Error('corrupt archive'))
    renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    })
    expect(screen.getByText('corrupt archive')).toBeInTheDocument()
  })

  it('cancels the import confirmation', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/Replace your entire library/)).toBeNull()
    expect(backup.import).not.toHaveBeenCalled()
  })
})

describe('SettingsView — developer tools', () => {
  it('simulates and clears a pending update notification', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Simulate' }))
    const clear = screen.getByRole('button', { name: 'Clear (v99.9.9)' })
    expect(clear).toBeInTheDocument()
    fireEvent.click(clear)
    expect(screen.getByRole('button', { name: 'Simulate' })).toBeInTheDocument()
  })
})

describe('SettingsView — Account section', () => {
  // The mode toggle and the submit button can share a label ("Sign in"). The
  // toggles live inside the role="group"; the submit is the last such button.
  const modeGroup = () => screen.getByRole('group', { name: 'Account action' })
  const toggle = (name: string) => within(modeGroup()).getByRole('button', { name })
  const submit = (name: string) => {
    const all = screen.getAllByRole('button', { name })
    return all[all.length - 1]
  }

  it('unconfigured build shows the offline note, no form', async () => {
    // Default mock: isConfigured resolves false.
    renderView()
    expect(await screen.findByText(/Cloud sync isn’t configured/)).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Account action' })).toBeNull()
  })

  it('configured + signed out renders the sign-in form', async () => {
    auth.isConfigured.mockResolvedValueOnce(true)
    auth.getSession.mockResolvedValueOnce({ user: null })
    renderView()
    expect(await screen.findByPlaceholderText('you@example.com')).toBeInTheDocument()
    expect(modeGroup()).toBeInTheDocument()
    expect(toggle('Sign in')).toBeInTheDocument()
    expect(toggle('Create account')).toBeInTheDocument()
  })

  it('gates Create account on the 8-char minimum', async () => {
    auth.isConfigured.mockResolvedValueOnce(true)
    auth.getSession.mockResolvedValueOnce({ user: null })
    renderView()
    await screen.findByPlaceholderText('you@example.com')
    fireEvent.click(toggle('Create account'))
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'c@d.com' },
    })
    const pw = screen.getByPlaceholderText(/At least 8 characters/)
    fireEvent.change(pw, { target: { value: 'short' } })
    expect(submit('Create account')).toBeDisabled()
    fireEvent.change(pw, { target: { value: 'longenough' } })
    expect(submit('Create account')).toBeEnabled()
  })

  it('surfaces a sign-in error', async () => {
    auth.isConfigured.mockResolvedValueOnce(true)
    auth.getSession.mockResolvedValueOnce({ user: null })
    auth.signIn.mockResolvedValueOnce({ ok: false, error: 'Invalid login credentials' })
    renderView()
    await screen.findByPlaceholderText('you@example.com')
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'a@b.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'pw' } })
    fireEvent.click(submit('Sign in'))
    expect(await screen.findByText('Invalid login credentials')).toBeInTheDocument()
  })

  it('runs the forgot-password flow: request a code, then reset the password', async () => {
    auth.isConfigured.mockResolvedValueOnce(true)
    auth.getSession.mockResolvedValueOnce({ user: null })
    auth.requestPasswordReset.mockResolvedValueOnce({ ok: true })
    auth.confirmPasswordReset.mockResolvedValueOnce({
      ok: true,
      user: { id: 'u1', email: 'a@b.com' },
    })
    renderView()
    await screen.findByPlaceholderText('you@example.com')

    // Enter the reset flow.
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'a@b.com' },
    })
    // Code + password inputs only appear after a code is requested.
    expect(screen.queryByPlaceholderText('123456')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reset code' }))
    })
    expect(auth.requestPasswordReset).toHaveBeenCalledWith('a@b.com')
    expect(await screen.findByText(/We emailed a 6-digit code/)).toBeInTheDocument()

    // Phase 2: enter the code + a new password.
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '123456' } })
    fireEvent.change(screen.getByPlaceholderText(/At least 8 characters/), {
      target: { value: 'newlongpassword' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))
    })
    expect(auth.confirmPasswordReset).toHaveBeenCalledWith('a@b.com', '123456', 'newlongpassword')
  })

  it('gates the reset-password submit on the 8-char minimum', async () => {
    auth.isConfigured.mockResolvedValueOnce(true)
    auth.getSession.mockResolvedValueOnce({ user: null })
    auth.requestPasswordReset.mockResolvedValueOnce({ ok: true })
    renderView()
    await screen.findByPlaceholderText('you@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'a@b.com' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reset code' }))
    })
    fireEvent.change(await screen.findByPlaceholderText('123456'), { target: { value: '123456' } })
    const pw = screen.getByPlaceholderText(/At least 8 characters/)
    fireEvent.change(pw, { target: { value: 'short' } })
    expect(screen.getByRole('button', { name: 'Reset password' })).toBeDisabled()
    fireEvent.change(pw, { target: { value: 'longenough' } })
    expect(screen.getByRole('button', { name: 'Reset password' })).toBeEnabled()
  })

  it('surfaces a reset request error and stays on the request step', async () => {
    auth.isConfigured.mockResolvedValueOnce(true)
    auth.getSession.mockResolvedValueOnce({ user: null })
    auth.requestPasswordReset.mockResolvedValueOnce({
      ok: false,
      error: 'Email rate limit exceeded',
    })
    renderView()
    await screen.findByPlaceholderText('you@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'a@b.com' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reset code' }))
    })
    expect(await screen.findByText('Email rate limit exceeded')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('123456')).toBeNull()
  })

  it('signed-in shows the email + Sign out', async () => {
    auth.isConfigured.mockResolvedValueOnce(true)
    auth.getSession.mockResolvedValueOnce({ user: { id: 'u1', email: 'me@x.com' } })
    renderView()
    expect(await screen.findByText('me@x.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('signed-in shows the cloud-processing toggle and persists a toggle', async () => {
    auth.isConfigured.mockResolvedValueOnce(true)
    auth.getSession.mockResolvedValueOnce({ user: { id: 'u1', email: 'me@x.com' } })
    renderView()

    const toggle = await screen.findByRole('switch', { name: 'Process files in the cloud' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(JSON.parse(localStorage.getItem('app-settings') ?? '{}')).toMatchObject({
      enableCloudProcessing: true,
    })
  })

  it('signed-in with sync on shows last-synced status and runs a manual sync', async () => {
    auth.isConfigured.mockResolvedValueOnce(true)
    auth.getSession.mockResolvedValueOnce({ user: { id: 'u1', email: 'me@x.com' } })
    localStorage.setItem('app-settings', JSON.stringify({ enableSync: true }))
    const synced = {
      enabled: true,
      configured: true,
      signedIn: true,
      running: false,
      lastSyncedAt: Date.now() - 2 * 60_000, // "2 min ago"
      lastError: null,
    }
    sync.getStatus.mockResolvedValue(synced)
    sync.now.mockResolvedValue({ ...synced, lastSyncedAt: Date.now() })

    renderView()

    expect(await screen.findByText(/Last synced 2 min ago/)).toBeInTheDocument()
    const btn = screen.getByRole('button', { name: 'Sync now' })
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(sync.now).toHaveBeenCalled()
  })

  it('signed-in with sync on surfaces the last error + backoff retry line', async () => {
    auth.isConfigured.mockResolvedValueOnce(true)
    auth.getSession.mockResolvedValueOnce({ user: { id: 'u1', email: 'me@x.com' } })
    localStorage.setItem('app-settings', JSON.stringify({ enableSync: true }))
    // A real failure moves lastError + consecutiveFailures together; the panel keys the
    // error state on the streak and adds a "next retry" countdown while backing off.
    sync.getStatus.mockResolvedValue({
      enabled: true,
      configured: true,
      signedIn: true,
      running: false,
      lastSyncedAt: null,
      lastError: 'PostgREST down',
      pendingDirty: 0,
      consecutiveFailures: 2,
      nextRetryAt: Date.now() + 8 * 60_000,
    })

    renderView()

    expect(await screen.findByText(/Last sync failed: PostgREST down/)).toBeInTheDocument()
    expect(await screen.findByText(/2 failed attempts · next retry/)).toBeInTheDocument()
  })

  it('signed-in with pending changes shows the waiting-to-sync count', async () => {
    auth.isConfigured.mockResolvedValueOnce(true)
    auth.getSession.mockResolvedValueOnce({ user: { id: 'u1', email: 'me@x.com' } })
    localStorage.setItem('app-settings', JSON.stringify({ enableSync: true }))
    sync.getStatus.mockResolvedValue({
      enabled: true,
      configured: true,
      signedIn: true,
      running: false,
      lastSyncedAt: Date.now(),
      lastError: null,
      pendingDirty: 3,
      consecutiveFailures: 0,
      nextRetryAt: null,
    })

    renderView()

    expect(await screen.findByText(/3 changes waiting to sync/)).toBeInTheDocument()
  })
})
