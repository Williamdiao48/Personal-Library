import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { BrowserWindow, invoke, resetIpc } from '../../../test/stubs/electron'

// Shared fakes, hoisted so the vi.mock factories can close over them.
const h = vi.hoisted(() => {
  const auth = {
    onAuthStateChange: vi.fn(),
    getSession: vi.fn(),
    signUp: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    verifyOtp: vi.fn(),
    updateUser: vi.fn(),
    resend: vi.fn(),
  }
  return {
    fakeSupabase: { auth },
    isConfigured: vi.fn(() => true),
    getSupabase: vi.fn(),
    clearSessionStore: vi.fn(),
    drainOutbox: vi.fn(() => Promise.resolve()),
    deleteCloudAccount: vi.fn(),
  }
})

vi.mock('../auth/client', () => ({
  isConfigured: h.isConfigured,
  getSupabase: h.getSupabase,
}))
vi.mock('../auth/sessionStore', () => ({ clearSessionStore: h.clearSessionStore }))
// The auth state-change hook kicks the Phase 2 blob uploader when a session
// appears — stub it so this suite doesn't load the DB, and assert the trigger.
vi.mock('../cloud/uploader', () => ({ drainOutbox: h.drainOutbox }))
// Account deletion delegates the cloud work to this wrapper — stub it so the IPC
// suite controls the outcome and asserts the sign-out-only-on-success contract.
vi.mock('../cloud/deleteAccount', () => ({ deleteCloudAccount: h.deleteCloudAccount }))

import { registerAuthHandlers } from './auth'

let stateCb: (event: string, session: any) => void

beforeAll(() => {
  h.getSupabase.mockReturnValue(h.fakeSupabase)
  resetIpc()
  registerAuthHandlers()
  // Capture the onAuthStateChange callback registered during register.
  stateCb = h.fakeSupabase.auth.onAuthStateChange.mock.calls[0][0]
})

beforeEach(() => {
  vi.clearAllMocks()
  h.getSupabase.mockReturnValue(h.fakeSupabase)
  h.isConfigured.mockReturnValue(true)
})

describe('auth IPC — configured', () => {
  it('isConfigured reflects the client module', async () => {
    expect(await invoke('auth:isConfigured')).toBe(true)
  })

  it('getSession maps the session user to { id, email }', async () => {
    h.fakeSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'u1', email: 'a@b.com' } } },
    })
    expect(await invoke('auth:getSession')).toEqual({ user: { id: 'u1', email: 'a@b.com' } })
  })

  it('getSession returns null user when signed out', async () => {
    h.fakeSupabase.auth.getSession.mockResolvedValue({ data: { session: null } })
    expect(await invoke('auth:getSession')).toEqual({ user: null })
  })

  it('signIn returns the user on success', async () => {
    h.fakeSupabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'u1', email: 'a@b.com' } },
      error: null,
    })
    const res = await invoke('auth:signIn', 'a@b.com', 'pw')
    expect(h.fakeSupabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'a@b.com',
      password: 'pw',
    })
    expect(res).toEqual({ ok: true, user: { id: 'u1', email: 'a@b.com' } })
  })

  it('signIn surfaces the error message on failure', async () => {
    h.fakeSupabase.auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { message: 'Invalid login credentials' },
    })
    expect(await invoke('auth:signIn', 'a@b.com', 'bad')).toEqual({
      ok: false,
      error: 'Invalid login credentials',
    })
  })

  it('signUp flags needsConfirmation when no session is returned', async () => {
    h.fakeSupabase.auth.signUp.mockResolvedValue({
      data: { user: { id: 'u2', email: 'c@d.com' }, session: null },
      error: null,
    })
    expect(await invoke('auth:signUp', 'c@d.com', 'longpassword')).toEqual({
      ok: true,
      user: { id: 'u2', email: 'c@d.com' },
      needsConfirmation: true,
    })
  })

  it('signUp signs in immediately when a session is returned (auto-confirm)', async () => {
    h.fakeSupabase.auth.signUp.mockResolvedValue({
      data: { user: { id: 'u2', email: 'c@d.com' }, session: { access_token: 't' } },
      error: null,
    })
    const res = (await invoke('auth:signUp', 'c@d.com', 'longpassword')) as any
    expect(res.needsConfirmation).toBe(false)
  })

  it('signOut calls the client and clears the session store', async () => {
    h.fakeSupabase.auth.signOut.mockResolvedValue({})
    await invoke('auth:signOut')
    expect(h.fakeSupabase.auth.signOut).toHaveBeenCalledTimes(1)
    expect(h.clearSessionStore).toHaveBeenCalledTimes(1)
  })

  it('requestPasswordReset mails the OTP and reports ok (enumeration-safe)', async () => {
    h.fakeSupabase.auth.resetPasswordForEmail.mockResolvedValue({ error: null })
    const res = await invoke('auth:requestPasswordReset', 'a@b.com')
    expect(h.fakeSupabase.auth.resetPasswordForEmail).toHaveBeenCalledWith('a@b.com')
    expect(res).toEqual({ ok: true })
  })

  it('requestPasswordReset surfaces transport/rate-limit errors', async () => {
    h.fakeSupabase.auth.resetPasswordForEmail.mockResolvedValue({
      error: { message: 'Email rate limit exceeded' },
    })
    expect(await invoke('auth:requestPasswordReset', 'a@b.com')).toEqual({
      ok: false,
      error: 'Email rate limit exceeded',
    })
  })

  it('confirmPasswordReset verifies the OTP then updates the password', async () => {
    h.fakeSupabase.auth.verifyOtp.mockResolvedValue({
      data: { user: { id: 'u1', email: 'a@b.com' } },
      error: null,
    })
    h.fakeSupabase.auth.updateUser.mockResolvedValue({ error: null })
    const res = await invoke('auth:confirmPasswordReset', 'a@b.com', '123456', 'newlongpassword')
    expect(h.fakeSupabase.auth.verifyOtp).toHaveBeenCalledWith({
      email: 'a@b.com',
      token: '123456',
      type: 'recovery',
    })
    expect(h.fakeSupabase.auth.updateUser).toHaveBeenCalledWith({ password: 'newlongpassword' })
    expect(res).toEqual({ ok: true, user: { id: 'u1', email: 'a@b.com' } })
  })

  it('confirmPasswordReset fails on a bad/expired code without touching the password', async () => {
    h.fakeSupabase.auth.verifyOtp.mockResolvedValue({
      data: {},
      error: { message: 'Token has expired or is invalid' },
    })
    const res = await invoke('auth:confirmPasswordReset', 'a@b.com', 'bad', 'newlongpassword')
    expect(res).toEqual({ ok: false, error: 'Token has expired or is invalid' })
    expect(h.fakeSupabase.auth.updateUser).not.toHaveBeenCalled()
  })

  it('confirmPasswordReset surfaces an updateUser failure (e.g. weak password)', async () => {
    h.fakeSupabase.auth.verifyOtp.mockResolvedValue({
      data: { user: { id: 'u1', email: 'a@b.com' } },
      error: null,
    })
    h.fakeSupabase.auth.updateUser.mockResolvedValue({
      error: { message: 'Password should be at least 8 characters' },
    })
    expect(await invoke('auth:confirmPasswordReset', 'a@b.com', '123456', 'short')).toEqual({
      ok: false,
      error: 'Password should be at least 8 characters',
    })
  })

  it('confirmSignup verifies the OTP and returns the user (signs in)', async () => {
    h.fakeSupabase.auth.verifyOtp.mockResolvedValue({
      data: { user: { id: 'u2', email: 'c@d.com' } },
      error: null,
    })
    const res = await invoke('auth:confirmSignup', 'c@d.com', '123456')
    expect(h.fakeSupabase.auth.verifyOtp).toHaveBeenCalledWith({
      email: 'c@d.com',
      token: '123456',
      type: 'signup',
    })
    expect(res).toEqual({ ok: true, user: { id: 'u2', email: 'c@d.com' } })
  })

  it('confirmSignup surfaces a bad/expired code error', async () => {
    h.fakeSupabase.auth.verifyOtp.mockResolvedValue({
      data: {},
      error: { message: 'Token has expired or is invalid' },
    })
    expect(await invoke('auth:confirmSignup', 'c@d.com', 'bad')).toEqual({
      ok: false,
      error: 'Token has expired or is invalid',
    })
  })

  it('resendConfirmation re-sends the signup email and reports ok', async () => {
    h.fakeSupabase.auth.resend.mockResolvedValue({ error: null })
    const res = await invoke('auth:resendConfirmation', 'c@d.com')
    expect(h.fakeSupabase.auth.resend).toHaveBeenCalledWith({ type: 'signup', email: 'c@d.com' })
    expect(res).toEqual({ ok: true })
  })

  it('resendConfirmation surfaces transport/rate-limit errors', async () => {
    h.fakeSupabase.auth.resend.mockResolvedValue({
      error: { message: 'Email rate limit exceeded' },
    })
    expect(await invoke('auth:resendConfirmation', 'c@d.com')).toEqual({
      ok: false,
      error: 'Email rate limit exceeded',
    })
  })

  it('deleteAccount purges the cloud then signs out + clears the session on success', async () => {
    h.deleteCloudAccount.mockResolvedValue({ ok: true })
    h.fakeSupabase.auth.signOut.mockResolvedValue({})
    const res = await invoke('auth:deleteAccount')
    expect(h.deleteCloudAccount).toHaveBeenCalledTimes(1)
    expect(h.fakeSupabase.auth.signOut).toHaveBeenCalledTimes(1)
    expect(h.clearSessionStore).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ ok: true })
  })

  it('deleteAccount does NOT sign out when the cloud delete fails', async () => {
    h.deleteCloudAccount.mockResolvedValue({ ok: false, error: 'unauthorized' })
    const res = await invoke('auth:deleteAccount')
    expect(res).toEqual({ ok: false, error: 'unauthorized' })
    expect(h.fakeSupabase.auth.signOut).not.toHaveBeenCalled()
    expect(h.clearSessionStore).not.toHaveBeenCalled()
  })

  it('broadcasts auth state changes to open windows', () => {
    const send = vi.fn()
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([{ webContents: { send } }] as any)
    stateCb('SIGNED_IN', { user: { id: 'u1', email: 'a@b.com' } })
    expect(send).toHaveBeenCalledWith('auth:stateChange', { user: { id: 'u1', email: 'a@b.com' } })
  })

  it('drains the blob outbox when a session appears, not when signed out (Phase 2)', () => {
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([])
    stateCb('SIGNED_IN', { user: { id: 'u1', email: 'a@b.com' } })
    expect(h.drainOutbox).toHaveBeenCalledTimes(1)
    h.drainOutbox.mockClear()
    stateCb('SIGNED_OUT', null)
    expect(h.drainOutbox).not.toHaveBeenCalled()
  })
})

describe('auth IPC — not configured', () => {
  it('getSession returns null user when there is no client', async () => {
    h.getSupabase.mockReturnValue(null)
    expect(await invoke('auth:getSession')).toEqual({ user: null })
  })

  it('signIn returns a not-configured error when there is no client', async () => {
    h.getSupabase.mockReturnValue(null)
    const res = (await invoke('auth:signIn', 'a@b.com', 'pw')) as any
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not configured/i)
  })

  it('signOut is a no-op that still clears the store when there is no client', async () => {
    h.getSupabase.mockReturnValue(null)
    await invoke('auth:signOut')
    expect(h.clearSessionStore).toHaveBeenCalledTimes(1)
  })

  it('password-reset handlers return a not-configured error when there is no client', async () => {
    h.getSupabase.mockReturnValue(null)
    const req = (await invoke('auth:requestPasswordReset', 'a@b.com')) as any
    const conf = (await invoke(
      'auth:confirmPasswordReset',
      'a@b.com',
      '123456',
      'newpassword',
    )) as any
    expect(req.ok).toBe(false)
    expect(req.error).toMatch(/not configured/i)
    expect(conf.ok).toBe(false)
    expect(conf.error).toMatch(/not configured/i)
  })

  it('signup-confirmation handlers return a not-configured error when there is no client', async () => {
    h.getSupabase.mockReturnValue(null)
    const confirm = (await invoke('auth:confirmSignup', 'c@d.com', '123456')) as any
    const resend = (await invoke('auth:resendConfirmation', 'c@d.com')) as any
    expect(confirm.ok).toBe(false)
    expect(confirm.error).toMatch(/not configured/i)
    expect(resend.ok).toBe(false)
    expect(resend.error).toMatch(/not configured/i)
    expect(h.fakeSupabase.auth.verifyOtp).not.toHaveBeenCalled()
    expect(h.fakeSupabase.auth.resend).not.toHaveBeenCalled()
  })

  it('deleteAccount returns a not-configured error and never calls the cloud delete', async () => {
    h.getSupabase.mockReturnValue(null)
    const res = (await invoke('auth:deleteAccount')) as any
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not configured/i)
    expect(h.deleteCloudAccount).not.toHaveBeenCalled()
  })
})
