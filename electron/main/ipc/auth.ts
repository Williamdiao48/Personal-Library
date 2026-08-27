import { ipcMain, BrowserWindow } from 'electron'
import type { User } from '@supabase/supabase-js'
import { getSupabase, isConfigured } from '../auth/client'
import { clearSessionStore } from '../auth/sessionStore'
import { drainOutbox } from '../cloud/uploader'
import { notifyAuthChange } from '../cloud/sync/syncService'

// The renderer-facing auth seam. Mirrors the app's IPC convention (renderer →
// window.api → ipcMain) and the updater's event-forwarding pattern for pushing
// state changes. Tokens NEVER cross to the renderer — only { id, email }.

/** The minimal, token-free user shape the renderer sees. */
interface AuthUser {
  id: string
  email: string | null
}

interface AuthState {
  user: AuthUser | null
}

interface AuthResult {
  ok: boolean
  user?: AuthUser | null
  error?: string
  /** signUp when email confirmation is required (no session yet). */
  needsConfirmation?: boolean
}

let handlersRegistered = false

function toAuthUser(user: User | null | undefined): AuthUser | null {
  if (!user) return null
  return { id: user.id, email: user.email ?? null }
}

function broadcast(state: AuthState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('auth:stateChange', state)
  }
}

/** Uniform "cloud isn't set up in this build" result for every mutating call. */
const NOT_CONFIGURED: AuthResult = {
  ok: false,
  error: 'Cloud sync is not configured in this build.',
}

export function registerAuthHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true

  // Subscribe to Supabase auth events and forward them so the renderer's
  // AuthContext tracks sign-in/out/refresh (incl. the INITIAL_SESSION emitted on
  // launch when a persisted session is restored → "session survives restart").
  // Only when configured — otherwise no client, no subscription, no network.
  if (isConfigured()) {
    const supabase = getSupabase()
    supabase?.auth.onAuthStateChange((_event, session) => {
      broadcast({ user: toAuthUser(session?.user) })
      // A session is now available (fresh sign-in, token refresh, or the
      // INITIAL_SESSION restored on launch) → drain any pending Phase 2 blob
      // uploads. No-ops when signed out or nothing is queued.
      if (session) void drainOutbox().catch(() => {})
      // Phase 3: kick the metadata sync on sign-in / halt its poll on sign-out.
      notifyAuthChange(!!session)
    })
  }

  ipcMain.handle('auth:isConfigured', (): boolean => isConfigured())

  ipcMain.handle('auth:getSession', async (): Promise<AuthState> => {
    const supabase = getSupabase()
    if (!supabase) return { user: null }
    const { data } = await supabase.auth.getSession()
    return { user: toAuthUser(data.session?.user) }
  })

  ipcMain.handle(
    'auth:signUp',
    async (_e, email: string, password: string): Promise<AuthResult> => {
      const supabase = getSupabase()
      if (!supabase) return NOT_CONFIGURED
      const { data, error } = await supabase.auth.signUp({ email, password })
      if (error) return { ok: false, error: error.message }
      // With email auto-confirm on (dev), a session is returned → signed in now.
      // Without it, session is null and the user must confirm via email first.
      return { ok: true, user: toAuthUser(data.user), needsConfirmation: !data.session }
    },
  )

  ipcMain.handle(
    'auth:signIn',
    async (_e, email: string, password: string): Promise<AuthResult> => {
      const supabase = getSupabase()
      if (!supabase) return NOT_CONFIGURED
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) return { ok: false, error: error.message }
      return { ok: true, user: toAuthUser(data.user) }
    },
  )

  ipcMain.handle('auth:signOut', async (): Promise<void> => {
    const supabase = getSupabase()
    await supabase?.auth.signOut()
    // Belt-and-suspenders: also wipe the encrypted session file directly.
    clearSessionStore()
  })

  // Password reset, phase 1 — mail the user a recovery OTP. We deliberately do
  // NOT reveal whether the email maps to an account: Supabase resolves
  // successfully regardless (enumeration-safe), so we surface only real transport
  // / rate-limit errors. No redirectTo — this is the in-app OTP flow (the recovery
  // email carries `{{ .Token }}`, a 6-digit code), not a web redirect.
  ipcMain.handle('auth:requestPasswordReset', async (_e, email: string): Promise<AuthResult> => {
    const supabase = getSupabase()
    if (!supabase) return NOT_CONFIGURED
    const { error } = await supabase.auth.resetPasswordForEmail(email)
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  })

  // Password reset, phase 2 — verify the OTP, then set the new password. A
  // successful verifyOtp('recovery') establishes a session, so the user is signed
  // in from here on: the onAuthStateChange hook above fires → broadcast + drain
  // outbox + kick sync, exactly as a normal sign-in would. updateUser then applies
  // the new password against that fresh session.
  ipcMain.handle(
    'auth:confirmPasswordReset',
    async (_e, email: string, token: string, newPassword: string): Promise<AuthResult> => {
      const supabase = getSupabase()
      if (!supabase) return NOT_CONFIGURED
      const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'recovery' })
      if (error) return { ok: false, error: error.message }
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword })
      if (updateError) return { ok: false, error: updateError.message }
      return { ok: true, user: toAuthUser(data.user) }
    },
  )
}
