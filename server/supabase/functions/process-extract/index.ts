// ─────────────────────────────────────────────────────────────────────────────
// Edge Function: process-extract — the Phase 4 orchestrator. Verifies the
// caller's Supabase JWT, presigns a GET for their source blob, mints a Google
// ID token, and invokes the PRIVATE Cloud Run extract container, passing the
// result back. The bytes never pass through here (the container GETs the source
// direct from R2). Same trust boundary as blob-url.
//
// Runtime: Deno (Supabase Edge Runtime). Thin glue only — the request handling,
// key scoping, and Google token minting it wires up are unit-tested by the
// vitest `server` project (handler.ts / googleAuth.ts). See server/README.md.
//
// Deploy:  supabase functions deploy process-extract
// Secrets: supabase secrets set \
//            CLOUD_RUN_URL=https://extract-xxxx.run.app \
//            GCP_SERVICE_ACCOUNT_KEY='<the SA JSON, single line>' \
//            R2_ACCOUNT_ID=… R2_BUCKET=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…
//   (SUPABASE_URL / SUPABASE_ANON_KEY are auto-injected by the platform.)
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { AwsClient } from 'npm:aws4fetch@1.0.20'
import { handleProcessExtract, type ProcessExtractDeps } from './handler.ts'
import { createCachedIdTokenMinter, type ServiceAccountKey } from './googleAuth.ts'

const SOURCE_GET_EXPIRES = 300 // ~5 min, like blob-url — one transfer's worth.

const R2_ACCOUNT_ID = Deno.env.get('R2_ACCOUNT_ID') ?? ''
const R2_BUCKET = Deno.env.get('R2_BUCKET') ?? ''
const R2_ACCESS_KEY_ID = Deno.env.get('R2_ACCESS_KEY_ID') ?? ''
const R2_SECRET_ACCESS_KEY = Deno.env.get('R2_SECRET_ACCESS_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const CLOUD_RUN_URL = Deno.env.get('CLOUD_RUN_URL') ?? ''
const GCP_SERVICE_ACCOUNT_KEY = Deno.env.get('GCP_SERVICE_ACCOUNT_KEY') ?? ''

const r2 = new AwsClient({
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  service: 's3',
  region: 'auto',
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Lazily built on first mint (needs the parsed SA) and reused across warm invocations.
let mintCached: ((audience: string) => Promise<string>) | null = null

const deps: ProcessExtractDeps = {
  cloudRunUrl: CLOUD_RUN_URL,

  async verifyJwt(authHeader) {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const {
      data: { user },
    } = await supabase.auth.getUser()
    return user?.id ?? null
  },

  async presignSourceGet(userId, contentHash) {
    // Scoped to the VERIFIED user id — never client-supplied. Mirrors blob-url's
    // transient `scratch` prefix: the client uploaded the raw source to
    // scratch/<uid>/<hash> (top-level, lifecycle-reaped), so we presign the GET there.
    const key = `scratch/${userId}/${contentHash}`
    const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${key}`
    const signed = await r2.sign(
      new Request(`${endpoint}?X-Amz-Expires=${SOURCE_GET_EXPIRES}`, { method: 'GET' }),
      { aws: { signQuery: true } },
    )
    return signed.url
  },

  async mintToken(audience) {
    // Parse the SA once and reuse a per-audience token cache across warm invocations.
    if (!mintCached) {
      mintCached = createCachedIdTokenMinter(
        JSON.parse(GCP_SERVICE_ACCOUNT_KEY) as ServiceAccountKey,
      )
    }
    return mintCached(audience)
  },

  invokeCloudRun(extractUrl, idToken, body) {
    return fetch(extractUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  },
}

Deno.serve((req: Request): Promise<Response> => {
  // Fail loud on misconfiguration rather than emitting broken URLs / tokens.
  if (!R2_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return Promise.resolve(json({ error: 'server misconfigured: R2 secrets not set' }, 500))
  }
  if (!CLOUD_RUN_URL || !GCP_SERVICE_ACCOUNT_KEY) {
    return Promise.resolve(json({ error: 'server misconfigured: Cloud Run env not set' }, 500))
  }
  return handleProcessExtract(req, deps)
})
