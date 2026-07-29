// ─────────────────────────────────────────────────────────────────────────────
// Edge Function: blob-url — mint a short-lived presigned R2 URL scoped to the
// caller's own prefix. Implements Phase 2 Decision 7 (the client never holds an
// R2 credential; R2 has no row-level security, so this recreates the RLS
// guarantee for files).
//
// Flow:
//   client → POST here with its Supabase JWT
//        → we VERIFY the JWT (so the user id is trusted — read from the token,
//          never from the request body)
//        → sign a PUT/GET URL for exactly users/<verified-uid>/<kind>/<hash>
//        → return just the URL.
//   The book bytes then flow directly client ↔ R2. This function only signs a
//   URL; it never touches or proxies the file bytes.
//
// Runtime: Deno (Supabase Edge Runtime). Not part of the vitest suite — see the
// smoke-test recipe in server/README.md.
//
// Deploy:  supabase functions deploy blob-url
// Secrets: supabase secrets set R2_ACCOUNT_ID=… R2_BUCKET=… \
//            R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…
//   (SUPABASE_URL / SUPABASE_ANON_KEY are auto-injected by the platform.)
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { AwsClient } from 'npm:aws4fetch@1.0.20'

// ~5 min: long enough for one transfer, short enough that a leaked URL is nearly
// worthless. Each transfer fetches a fresh URL.
const EXPIRES_SECONDS = 300

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

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  })

// A key is scoped to a VERIFIED user id and addresses an immutable, sha256-named
// blob. Validate the shape so nothing outside `users/<uid>/{content,cover}/<hash>`
// can ever be signed (no path traversal, no arbitrary keys).
const HASH_RE = /^[0-9a-f]{64}$/
const KINDS = new Set(['content', 'cover'])
const OPS = new Set(['put', 'get'])

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  // Fail loud if the function is misconfigured rather than signing with empty
  // credentials (which would produce URLs R2 rejects with a confusing 403).
  if (!R2_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return json({ error: 'server misconfigured: R2 secrets not set' }, 500)
  }

  // 1 — Verify the caller's Supabase JWT. The user id comes from the TOKEN, so a
  //     client cannot ask for a URL outside its own prefix.
  const authHeader = req.headers.get('Authorization') ?? ''
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser()
  if (authErr || !user) return json({ error: 'unauthorized' }, 401)

  // 2 — Validate the request body: exactly { op, kind, hash }.
  let body: { op?: unknown; kind?: unknown; hash?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  const op = String(body.op ?? '')
  const kind = String(body.kind ?? '')
  const hash = String(body.hash ?? '')
  if (!OPS.has(op)) return json({ error: 'op must be "put" or "get"' }, 400)
  if (!KINDS.has(kind)) return json({ error: 'kind must be "content" or "cover"' }, 400)
  if (!HASH_RE.test(hash)) return json({ error: 'hash must be a sha256 hex string' }, 400)

  // 3 — Scope the key to the verified user id (never client-supplied).
  const key = `users/${user.id}/${kind}/${hash}`
  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${key}`

  // 4 — Presign with SigV4 query-signing. From here the bytes go direct to R2;
  //     this function has already done its whole job (mint the URL).
  const signed = await r2.sign(
    new Request(`${endpoint}?X-Amz-Expires=${EXPIRES_SECONDS}`, {
      method: op === 'put' ? 'PUT' : 'GET',
    }),
    { aws: { signQuery: true } },
  )

  return json({ url: signed.url, key, expiresIn: EXPIRES_SECONDS })
})
