import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { sessionStore } from './sessionStore'

// The single main-process Supabase client (Publishable key only — the Secret key
// never ships; RLS is the security boundary). Constructed LAZILY on first use so
// that merely importing this module opens no connection and changes nothing for a
// local-only user (the Phase 1 invariant). With no persisted session, supabase-js
// makes no network call on construction — it only refreshes when a session exists.

// electron-vite exposes `MAIN_VITE_*` env vars to the main bundle via
// import.meta.env. Absent (e.g. a build with no cloud creds) → auth is simply
// "not configured" and every handler no-ops gracefully.
const SUPABASE_URL = import.meta.env.MAIN_VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.MAIN_VITE_SUPABASE_ANON_KEY as string | undefined

let client: SupabaseClient | null = null

/** True when this build carries the Supabase URL + Publishable key. */
export function isConfigured(): boolean {
  return !!SUPABASE_URL && !!SUPABASE_ANON_KEY
}

/**
 * The lazily-constructed client, or null if the build isn't configured for cloud.
 * Callers must handle null (treat as signed-out / cloud-unavailable).
 */
export function getSupabase(): SupabaseClient | null {
  if (!isConfigured()) return null
  if (client) return client
  client = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: {
      // Persist across restarts via our safeStorage-backed adapter (P1-D2).
      persistSession: true,
      autoRefreshToken: true,
      // No browser redirect flow in Electron main — password auth only (P1-D3).
      detectSessionInUrl: false,
      storage: sessionStore,
    },
    realtime: {
      // Electron 31's main process is Node 20 (no global WebSocket until Node 22).
      // createClient always builds a realtime client whose constructor requires a
      // WebSocket, so hand it `ws` even though Phase 1 uses no realtime — otherwise
      // it throws "native WebSocket not found" on construct.
      transport: WebSocket as unknown as typeof globalThis.WebSocket,
    },
  })
  return client
}
