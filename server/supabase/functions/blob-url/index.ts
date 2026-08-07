// ─────────────────────────────────────────────────────────────────────────────
// Edge Function: blob-url — mint a short-lived presigned R2 URL scoped to the
// caller's own prefix. Implements Phase 2 Decision 7 (the client never holds an
// R2 credential; R2 has no row-level security, so this recreates the RLS
// guarantee for files). A PUT URL binds the exact upload size into the
// signature, so R2 rejects an over-cap or oversized body.
//
// Flow:
//   client → POST { op, kind, hash, size? } with its Supabase JWT
//        → VERIFY the JWT (user id from the token, never the request body)
//        → sign a PUT/GET URL for exactly users/<verified-uid>/<kind>/<hash>
//        → return just the URL.
//   The book bytes then flow directly client ↔ R2. This function only signs a
//   URL; it never touches or proxies the file bytes.
//
// Runtime: Deno (Supabase Edge Runtime). Thin glue only — the request handling,
// key scoping, and size caps it wires up are unit-tested by the vitest `server`
// project (handler.ts). See the smoke-test recipe in server/README.md.
//
// Deploy:  supabase functions deploy blob-url
// Secrets: supabase secrets set R2_ACCOUNT_ID=… R2_BUCKET=… \
//            R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…
//   (SUPABASE_URL / SUPABASE_ANON_KEY are auto-injected by the platform.)
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { AwsClient } from 'npm:aws4fetch@1.0.20'
import { handleBlobUrl, EXPIRES_SECONDS, type BlobUrlDeps } from './handler.ts'

const R2_ACCOUNT_ID = Deno.env.get('R2_ACCOUNT_ID') ?? ''
const R2_BUCKET = Deno.env.get('R2_BUCKET') ?? ''
const R2_ACCESS_KEY_ID = Deno.env.get('R2_ACCESS_KEY_ID') ?? ''
const R2_SECRET_ACCESS_KEY = Deno.env.get('R2_SECRET_ACCESS_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const r2 = new AwsClient({
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  service: 's3',
  region: 'auto',
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const deps: BlobUrlDeps = {
  async verifyJwt(authHeader) {
    // The user id comes from the TOKEN, so a client cannot ask for a URL outside
    // its own prefix.
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const {
      data: { user },
    } = await supabase.auth.getUser()
    return user?.id ?? null
  },

  async presign({ op, key, contentLength }) {
    const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${key}`
    // For a PUT we sign `content-length` so R2 caps the body at exactly the
    // declared size. aws4fetch lists content-length as UNSIGNABLE, so `allHeaders`
    // forces it into X-Amz-SignedHeaders; passing headers as a plain object (not a
    // Request) keeps this otherwise-forbidden header from being stripped before
    // signing. The client's fetch sets Content-Length to the real body length, so
    // a larger upload fails the signature (403) instead of storing.
    const headers: Record<string, string> = {}
    const aws: { signQuery: boolean; allHeaders?: boolean } = { signQuery: true }
    if (op === 'put' && contentLength !== undefined) {
      headers['content-length'] = String(contentLength)
      aws.allHeaders = true
    }
    const method = op === 'put' ? 'PUT' : op === 'delete' ? 'DELETE' : 'GET'
    const signed = await r2.sign(`${endpoint}?X-Amz-Expires=${EXPIRES_SECONDS}`, {
      method,
      headers,
      aws,
    })
    return signed.url
  },
}

Deno.serve((req: Request): Promise<Response> => {
  // Fail loud if the function is misconfigured rather than signing with empty
  // credentials (which would produce URLs R2 rejects with a confusing 403).
  if (!R2_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return Promise.resolve(json({ error: 'server misconfigured: R2 secrets not set' }, 500))
  }
  return handleBlobUrl(req, deps)
})
