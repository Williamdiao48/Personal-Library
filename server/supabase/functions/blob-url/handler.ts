// blob-url — mint a short-lived presigned R2 URL scoped to the caller's own
// prefix (Phase 2 Decision 7: the client never holds an R2 credential; R2 has no
// row-level security, so this recreates the RLS guarantee for files).
//
// Runtime-agnostic core. The Deno wiring (env, Supabase client, aws4fetch R2
// signer) lives in index.ts and is injected via `deps`, so the vitest `server`
// project exercises this in Node against fakes — mirroring
// process-extract/{handler,index}.ts.

export type BlobOp = 'put' | 'get'
export type BlobKind = 'content' | 'cover'

export interface BlobUrlDeps {
  /** Verify the Authorization header; resolve the trusted user id or null. */
  verifyJwt: (authHeader: string) => Promise<string | null>
  /**
   * Presign a short-lived R2 URL for `key`. For a PUT, `contentLength` is the
   * exact byte count to bind into the signature so R2 rejects a larger body; it
   * is undefined for a GET.
   */
  presign: (args: { op: BlobOp; key: string; contentLength?: number }) => Promise<string>
}

// ~5 min: long enough for one transfer, short enough that a leaked URL is nearly
// worthless. Each transfer fetches a fresh URL.
export const EXPIRES_SECONDS = 300

// Per-kind ceiling on a single presigned PUT, mirroring the local import caps
// (electron/main/security/validation.ts: PDF_MAX_BYTES 200 MiB is the largest
// content kind; EPUB 150 MiB, scraped HTML smaller). Covers are small images
// (local IMAGE_MAX_BYTES is 5 MiB — 10 leaves headroom). Defined here, not
// imported, so the Edge Function stays self-contained (like HASH_RE / KINDS).
const MiB = 1024 * 1024
export const MAX_PUT_BYTES: Record<BlobKind, number> = {
  content: 200 * MiB,
  cover: 10 * MiB,
}

// A key is scoped to a VERIFIED user id and addresses an immutable, sha256-named
// blob. Validate the shape so nothing outside `users/<uid>/{content,cover}/<hash>`
// can ever be signed (no path traversal, no arbitrary keys).
const HASH_RE = /^[0-9a-f]{64}$/
const KINDS = new Set<string>(['content', 'cover'])
const OPS = new Set<string>(['put', 'get'])

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

export async function handleBlobUrl(req: Request, deps: BlobUrlDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  // 1 — Verify the caller's Supabase JWT. The user id comes from the TOKEN, so a
  //     client cannot ask for a URL outside its own prefix.
  const userId = await deps.verifyJwt(req.headers.get('Authorization') ?? '')
  if (!userId) return json({ error: 'unauthorized' }, 401)

  // 2 — Validate the request body: { op, kind, hash, size? }.
  let body: { op?: unknown; kind?: unknown; hash?: unknown; size?: unknown }
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

  // 3 — A PUT must declare its exact byte size, bounded by the per-kind cap. The
  //     size is baked into the signature (index.ts), so R2 — not just this check —
  //     rejects an over-cap or mismatched upload; a lying client cannot exceed it.
  let contentLength: number | undefined
  if (op === 'put') {
    const size = body.size
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
      return json({ error: 'size must be a positive integer byte count for a put' }, 400)
    }
    if (size > MAX_PUT_BYTES[kind as BlobKind]) {
      return json(
        { error: `size exceeds the ${kind} limit of ${MAX_PUT_BYTES[kind as BlobKind]} bytes` },
        400,
      )
    }
    contentLength = size
  }

  // 4 — Scope the key to the verified user id (never client-supplied), then sign.
  //     From here the bytes go direct to R2; this function only mints the URL.
  const key = `users/${userId}/${kind}/${hash}`
  const url = await deps.presign({ op: op as BlobOp, key, contentLength })
  return json({ url, key, expiresIn: EXPIRES_SECONDS })
}
