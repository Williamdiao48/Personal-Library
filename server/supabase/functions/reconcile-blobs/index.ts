// ─────────────────────────────────────────────────────────────────────────────
// Edge Function: reconcile-blobs — the H2b server-side R2 orphan reconciliation
// backstop. A PRIVILEGED, admin-gated janitor: it LISTs each user's R2 prefix,
// cross-checks every object against Postgres with the service_role key, and deletes
// permanent blobs that no un-purged item references — catching the ledger-less
// orphans the client reaper (electron/main/cloud/reaper.ts) structurally can't.
//
// Runtime: Deno (Supabase Edge Runtime). Thin glue only — the classification,
// age-gate, and dry-run logic it wires up are unit-tested by the vitest `server`
// project (handler.ts). See server/README.md.
//
// NOT publicly callable: deploy with --no-verify-jwt (there is no user context) and
// gate on a shared secret instead. The service_role key is used only INSIDE here
// (auto-injected by the platform), never exposed to any client.
//
// Deploy:  supabase functions deploy reconcile-blobs --no-verify-jwt
// Secrets: supabase secrets set RECONCILE_SECRET='<long random string>'
//            [RECONCILE_MIN_AGE_DAYS=30]   # age-gate; objects younger are never touched
//            [RECONCILE_DRY_RUN=1]         # optional kill-switch: force dry-run always
//   (R2_* are already set for blob-url; SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
//    auto-injected by the platform — don't set them.)
//
// Invoke (dry-run — default): curl -X POST "$SUPABASE_URL/functions/v1/reconcile-blobs" \
//            -H "Authorization: Bearer $RECONCILE_SECRET"
// Invoke (arm deletion):      … -H 'content-type: application/json' -d '{"apply":true}'
// ─────────────────────────────────────────────────────────────────────────────
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { AwsClient } from 'npm:aws4fetch@1.0.20'
import { XMLParser } from 'npm:fast-xml-parser@4.5.0'
import { handleReconcile, type ReconcileDeps, type R2Object } from './handler.ts'

const R2_ACCOUNT_ID = Deno.env.get('R2_ACCOUNT_ID') ?? ''
const R2_BUCKET = Deno.env.get('R2_BUCKET') ?? ''
const R2_ACCESS_KEY_ID = Deno.env.get('R2_ACCESS_KEY_ID') ?? ''
const R2_SECRET_ACCESS_KEY = Deno.env.get('R2_SECRET_ACCESS_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const RECONCILE_SECRET = Deno.env.get('RECONCILE_SECRET') ?? ''

const minAgeDaysEnv = Number(Deno.env.get('RECONCILE_MIN_AGE_DAYS') ?? '30')
const MIN_AGE_MS =
  (Number.isFinite(minAgeDaysEnv) && minAgeDaysEnv >= 0 ? minAgeDaysEnv : 30) * 86_400_000
const FORCE_DRY_RUN = /^(1|true)$/i.test(Deno.env.get('RECONCILE_DRY_RUN') ?? '')

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

// Built lazily on first use (avoids an import-time throw when env is unset — the guards in
// Deno.serve return 500 first) and reused across warm invocations.
let admin: SupabaseClient | null = null
function getAdmin(): SupabaseClient {
  if (!admin) {
    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return admin
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Length-checked constant-time compare so a timing side-channel can't leak the secret. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const deps: ReconcileDeps = {
  verifyAdmin(authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, '')
    return RECONCILE_SECRET.length > 0 && safeEqual(token, RECONCILE_SECRET)
  },

  async listObjects(prefix) {
    const out: R2Object[] = []
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
      for (const c of contents) {
        out.push({ key: String(c.Key), lastModified: Date.parse(String(c.LastModified)) })
      }
      token =
        String(result.IsTruncated) === 'true' ? String(result.NextContinuationToken) : undefined
    } while (token)
    return out
  },

  async listWantedHashes(userId) {
    const wanted = new Set<string>()
    const { data, error } = await getAdmin()
      .from('items')
      .select('blob_hash, cover_hash')
      .eq('user_id', userId)
      .is('purged_at', null)
    if (error) throw new Error(`postgres query failed: ${error.message}`)
    for (const row of data ?? []) {
      if (row.blob_hash) wanted.add(row.blob_hash as string)
      if (row.cover_hash) wanted.add(row.cover_hash as string)
    }
    return wanted
  },

  async deleteObject(key) {
    const signed = await r2.sign(new Request(`${r2Endpoint}/${key}`, { method: 'DELETE' }))
    const res = await fetch(signed)
    // R2 DELETE is idempotent (2xx even if the key is already gone); tolerate 404 too.
    if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed (${res.status})`)
  },

  now: () => Date.now(),
  minAgeMs: MIN_AGE_MS,
  dryRun: FORCE_DRY_RUN,
}

Deno.serve((req: Request): Promise<Response> => {
  // Fail loud on misconfiguration rather than silently reaping nothing / everything.
  if (!R2_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return Promise.resolve(json({ error: 'server misconfigured: R2 secrets not set' }, 500))
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return Promise.resolve(json({ error: 'server misconfigured: service role not set' }, 500))
  }
  if (!RECONCILE_SECRET) {
    return Promise.resolve(json({ error: 'server misconfigured: RECONCILE_SECRET not set' }, 500))
  }
  return handleReconcile(req, deps)
})
