// process-extract — the Phase 4 orchestration handler (runtime-agnostic core).
//
// Flow (MVP, synchronous):
//   client → POST { kind:'epub', content_hash } + Supabase JWT
//        → verify JWT (trusted user id)
//        → presign a GET for users/<uid>/content/<content_hash> (the source the
//          client already uploaded to R2 via the Phase-2 uploader)
//        → mint a Google ID token and invoke the PRIVATE Cloud Run /extract
//        → pass the extraction result straight back to the client.
//
// The bytes never pass through here: the container GETs the source from R2 and
// returns metadata + inline cover. This module is the same trust boundary as
// blob-url — the user id comes from the verified token, never the body.
//
// The Deno-specific wiring (env, Supabase client, R2 presign via aws4fetch) lives
// in index.ts; everything worth testing is here and injected via `deps`, so the
// vitest `server` project exercises it in Node against fakes.

export interface ProcessExtractDeps {
  /** Verify the Authorization header; resolve the trusted user id or null. */
  verifyJwt: (authHeader: string) => Promise<string | null>
  /** Presign a short-lived R2 GET for the caller's own source blob. */
  presignSourceGet: (userId: string, contentHash: string) => Promise<string>
  /** Mint a Google ID token for the Cloud Run audience. */
  mintToken: (audience: string) => Promise<string>
  /** POST to Cloud Run /extract with the bearer token; return its raw Response. */
  invokeCloudRun: (extractUrl: string, idToken: string, body: unknown) => Promise<Response>
  /** Base URL of the private Cloud Run service. */
  cloudRunUrl: string
}

const HASH_RE = /^[0-9a-f]{64}$/

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  })

export async function handleProcessExtract(
  req: Request,
  deps: ProcessExtractDeps,
): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  // 1 — Verify the JWT; the user id is read from the TOKEN, never the body.
  const userId = await deps.verifyJwt(req.headers.get('Authorization') ?? '')
  if (!userId) return json({ error: 'unauthorized' }, 401)

  // 2 — Validate the request: exactly { kind:'epub', content_hash:<sha256> }.
  let body: { kind?: unknown; content_hash?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  const kind = String(body.kind ?? '')
  const contentHash = String(body.content_hash ?? '')
  if (kind !== 'epub') return json({ error: 'kind must be "epub"' }, 400)
  if (!HASH_RE.test(contentHash)) {
    return json({ error: 'content_hash must be a sha256 hex string' }, 400)
  }

  // 3 — Presign the source, authenticate to Cloud Run, invoke it.
  const sourceUrl = await deps.presignSourceGet(userId, contentHash)
  const idToken = await deps.mintToken(deps.cloudRunUrl)
  const extractUrl = `${deps.cloudRunUrl.replace(/\/$/, '')}/extract`
  const cr = await deps.invokeCloudRun(extractUrl, idToken, { kind, sourceUrl })

  // 4 — Pass the container's result (or a bounded error) back to the client.
  if (!cr.ok) {
    const detail = await cr.text().catch(() => '')
    return json(
      { error: 'extraction failed', status: cr.status, detail: detail.slice(0, 500) },
      502,
    )
  }
  const result = await cr.json()
  return json(result, 200)
}
