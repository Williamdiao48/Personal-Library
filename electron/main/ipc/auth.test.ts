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
  }
  return {
    fakeSupabase: { auth },
    isConfigured: vi.fn(() => true),
    getSupabase: vi.fn(),
    clearSessionStore: vi.fn(),
  }
})

vi.mock('../auth/client', () => ({
  isConfigured: h.isConfigured,
  getSupabase: h.getSupabase,
}))
vi.mock('../auth/sessionStore', () => ({ clearSessionStore: h.clearSessionStore }))

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

  it('broadcasts auth state changes to open windows', () => {
    const send = vi.fn()
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([{ webContents: { send } }] as any)
    stateCb('SIGNED_IN', { user: { id: 'u1', email: 'a@b.com' } })
    expect(send).toHaveBeenCalledWith('auth:stateChange', { user: { id: 'u1', email: 'a@b.com' } })
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
})
