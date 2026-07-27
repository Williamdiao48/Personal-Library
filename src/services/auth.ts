import type { AuthState } from '../types'

// Thin wrapper over window.api.auth — the renderer never touches window.api
// directly (IPC-abstraction rule). All cloud auth flows through here.
// Tokens live only in the main process; these calls only ever see { id, email }.
export const authService = {
  /** Whether this build carries Supabase creds (else every call no-ops). */
  isConfigured: () => window.api.auth.isConfigured(),
  /** The current session's user, or null when signed out. */
  getSession: () => window.api.auth.getSession(),
  /** Create an account (email + password). */
  signUp: (email: string, password: string) => window.api.auth.signUp(email, password),
  /** Sign in with email + password. */
  signIn: (email: string, password: string) => window.api.auth.signIn(email, password),
  /** Sign out and clear the persisted session. */
  signOut: () => window.api.auth.signOut(),
  /** Subscribe to auth state changes; returns an unsubscribe fn. */
  onStateChange: (callback: (state: AuthState) => void) => window.api.auth.onStateChange(callback),
}
