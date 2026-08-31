import { createContext, useContext, useEffect, useState } from 'react'
import type { AuthUser, AuthResult } from '../types'
import { authService } from '../services/auth'

// App-wide auth state for the opt-in cloud layer. Kept intentionally minimal for
// Phase 1: it exposes the signed-in user (token-free) + the auth actions. Nothing
// in the library reads this yet — sync is Phase 3 — so a signed-out or
// unconfigured build behaves exactly as before (the local-only invariant).

interface AuthCtx {
  /** The signed-in user, or null when signed out / unconfigured. */
  user: AuthUser | null
  /** Whether this build has Supabase creds. When false, the Account UI shows a note. */
  configured: boolean
  /** True until the initial session check resolves (avoids a sign-in flash). */
  loading: boolean
  signIn: (email: string, password: string) => Promise<AuthResult>
  signUp: (email: string, password: string) => Promise<AuthResult>
  signOut: () => Promise<void>
  /** Password reset step 1: mail a 6-digit recovery code. */
  requestPasswordReset: (email: string) => Promise<AuthResult>
  /** Password reset step 2: verify the code + set a new password (signs in). */
  confirmPasswordReset: (email: string, token: string, password: string) => Promise<AuthResult>
  /** Confirm a sign-up with the emailed OTP code (signs in on success). */
  confirmSignup: (email: string, token: string) => Promise<AuthResult>
  /** Resend the sign-up confirmation code (when the mailed code never arrived). */
  resendConfirmation: (email: string) => Promise<AuthResult>
  /** Permanently delete the account + all cloud data; signs out on success. Local
   *  library on this device is kept. */
  deleteAccount: () => Promise<AuthResult>
}

const AuthContext = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [configured, setConfigured] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let unsub: (() => void) | undefined
    let cancelled = false

    void (async () => {
      const isConfigured = await authService.isConfigured()
      if (cancelled) return
      setConfigured(isConfigured)

      if (!isConfigured) {
        // Unconfigured build: no session, no listener, no network. Done.
        setLoading(false)
        return
      }

      // Hydrate the initial session (restored from safeStorage in main), then
      // track changes (sign-in/out/token-refresh) via the pushed event.
      const state = await authService.getSession()
      if (cancelled) return
      setUser(state.user)
      setLoading(false)

      unsub = authService.onStateChange((next) => setUser(next.user))
    })()

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  const signIn = async (email: string, password: string) => {
    const res = await authService.signIn(email, password)
    if (res.ok) setUser(res.user ?? null)
    return res
  }

  const signUp = async (email: string, password: string) => {
    const res = await authService.signUp(email, password)
    // With email auto-confirm on, signUp yields a session → set the user.
    // If confirmation is required, user stays null until they confirm + sign in.
    if (res.ok && !res.needsConfirmation) setUser(res.user ?? null)
    return res
  }

  const signOut = async () => {
    await authService.signOut()
    setUser(null)
  }

  const requestPasswordReset = (email: string) => authService.requestPasswordReset(email)

  const confirmSignup = async (email: string, token: string) => {
    const res = await authService.confirmSignup(email, token)
    // verifyOtp('signup') establishes a session → the pushed auth:stateChange also
    // sets the user, but set it here too to avoid a sign-in flash (mirrors reset).
    if (res.ok) setUser(res.user ?? null)
    return res
  }

  const resendConfirmation = (email: string) => authService.resendConfirmation(email)

  const confirmPasswordReset = async (email: string, token: string, password: string) => {
    const res = await authService.confirmPasswordReset(email, token, password)
    // verifyOtp('recovery') establishes a session → the pushed auth:stateChange
    // will also set the user, but set it here too to avoid a sign-in flash.
    if (res.ok) setUser(res.user ?? null)
    return res
  }

  const deleteAccount = async () => {
    const res = await authService.deleteAccount()
    // On success the account is gone and main has signed out; drop the user eagerly
    // (the pushed auth:stateChange also lands) so the panel returns to the sign-in view.
    if (res.ok) setUser(null)
    return res
  }

  return (
    <AuthContext.Provider
      value={{
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
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthCtx {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be inside AuthProvider')
  return ctx
}
