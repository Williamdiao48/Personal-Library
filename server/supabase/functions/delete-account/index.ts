// ─────────────────────────────────────────────────────────────────────────────
// Edge Function: delete-account — permanently erase the CALLER'S OWN cloud
// footprint (account-lifecycle L2). Authorized by the caller's Supabase JWT (uid
// from the token, never the body), it then wields service_role to:
//   1. purge the user's R2 prefix  users/<uid>/{content,cover}/*  (unconditional —
//      no age-gate, no wanted diff; the account is going away), then
//   2. hard-delete the auth.users row, which CASCADES every synced table + profiles
//      (all are `references auth.users(id) on delete cascade`).
// Local data on the user's device is intentionally NOT touched — the client signs
// out after a success (electron/main/ipc/auth.ts), keeping the offline library.
//
// Runtime: Deno (Supabase Edge Runtime). Thin glue only — the ordering, prefix
// scoping, and best-effort purge it wires up are unit-tested by the vitest `server`
// project (handler.ts), mirroring blob-url / process-extract / reconcile-blobs.
//
// Deploy WITH JWT verification (this has a real user context — do NOT pass
// --no-verify-jwt): supabase functions deploy delete-account
// Secrets: none new — R2_* are already set for blob-url; SUPABASE_URL /
//   SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are auto-injected by the platform.
//
// Invoke: the client calls it via supabase.functions.invoke('delete-account'),
//   which attaches the session JWT (electron/main/cloud/deleteAccount.ts).
// ─────────────────────────────────────────────────────────────────────────────
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { AwsClient } from 'npm:aws4fetch@1.0.20'
import { XMLParser } from 'npm:fast-xml-parser@4.5.0'
import { handleDeleteAccount, type DeleteAccountDeps } from './handler.ts'

const R2_ACCOUNT_ID = Deno.env.get('R2_ACCOUNT_ID') ?? ''
const R2_BUCKET = Deno.env.get('R2_BUCKET') ?? ''
const R2_ACCESS_KEY_ID = Deno.env.get('R2_ACCESS_KEY_ID') ?? ''
const R2_SECRET_ACCESS_KEY = Deno.env.get('R2_SECRET_ACCESS_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const r2 = new AwsClient({
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  service: 's3',
  region: 'auto',
})
const r2Endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}`

// parseTagValue:false keeps everything a string — a continuation token can look numeric
// and value-parsing would corrupt it (and IsTruncated stays "true"/"false" verbatim).
const xml = new XMLParser({ parseTagValue: false })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Service_role admin client, built lazily and reused across warm invocations (avoids an
// import-time throw when env is unset — the guards in Deno.serve return 500 first). Used
// ONLY inside this function for the privileged auth-user delete; never exposed to a client.
let admin: SupabaseClient | null = null
function getAdmin(): SupabaseClient {
  if (!admin) {
    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return admin
}

const deps: DeleteAccountDeps = {
  async verifyJwt(authHeader) {
    // The uid comes from the TOKEN, so a caller can only ever delete its own account.
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const {
      data: { user },
    } = await supabase.auth.getUser()
    return user?.id ?? null
  },

  async listObjects(prefix) {
    const out: string[] = []
    let token: string | undefined
    do {
      const params = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' })
      if (token) params.set('continuation-token', token)
      const signed = await r2.sign(new Request(`${r2Endpoint}?${params}`, { method: 'GET' }))
      const res = await fetch(signed)
      if (!res.ok) throw new Error(`R2 list failed (${res.status})`)
      const result = xml.parse(await res.text())?.ListBucketResult ?? {}
      const raw = result.Contents
      const contents = raw ? (Array.isArray(raw) ? raw : [raw]) : []
      for (const c of contents) out.push(String(c.Key))
      token =
        String(result.IsTruncated) === 'true' ? String(result.NextContinuationToken) : undefined
    } while (token)
    return out
  },

  async deleteObject(key) {
    const signed = await r2.sign(new Request(`${r2Endpoint}/${key}`, { method: 'DELETE' }))
    const res = await fetch(signed)
    // R2 DELETE is idempotent (2xx even if the key is already gone); tolerate 404 too.
    if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed (${res.status})`)
  },

  async deleteAuthUser(userId) {
    // Hard delete → FK cascade wipes every synced table + profiles for this uid.
    const { error } = await getAdmin().auth.admin.deleteUser(userId)
    if (error) throw new Error(`auth user delete failed: ${error.message}`)
  },
}

Deno.serve((req: Request): Promise<Response> => {
  // Fail loud on misconfiguration rather than half-deleting an account.
  if (!R2_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return Promise.resolve(json({ error: 'server misconfigured: R2 secrets not set' }, 500))
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return Promise.resolve(json({ error: 'server misconfigured: Supabase keys not set' }, 500))
  }
  return handleDeleteAccount(req, deps)
})
