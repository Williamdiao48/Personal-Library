import { getSupabase } from '../auth/client'

// Client for the delete-account Edge Function (account-lifecycle L2). Invokes the
// server function, which — authorized by this session's JWT (attached automatically
// by supabase-js) — purges the user's R2 prefix and hard-deletes their auth user,
// cascading every Postgres row. Local data on this device is deliberately kept; the
// IPC layer signs out after a success (electron/main/ipc/auth.ts).
//
// Returns { ok } rather than throwing so the caller can distinguish "cloud not
// configured / call failed" (leave the session intact) from success (sign out).

export interface DeleteAccountResult {
  ok: boolean
  error?: string
}

export async function deleteCloudAccount(): Promise<DeleteAccountResult> {
  const supabase = getSupabase()
  if (!supabase) return { ok: false, error: 'cloud not configured' }

  const { data, error } = await supabase.functions.invoke('delete-account')
  if (error) return { ok: false, error: error.message ?? String(error) }
  // The function returns { ok: true, … } on success; anything else is a failure we
  // must surface so the client never signs out on a half-completed delete.
  if (!(data as { ok?: unknown } | null)?.ok) {
    return { ok: false, error: 'account deletion did not complete' }
  }
  return { ok: true }
}
