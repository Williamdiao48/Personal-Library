// Mint a Google-signed ID token for invoking a PRIVATE Cloud Run service.
//
// The extract container is deployed with `--no-allow-unauthenticated`, so a
// caller must present a Google-signed ID token whose audience is the service
// URL. The Edge Function isn't on GCP (it runs on Supabase/Deno), so it can't
// use the metadata server — it authenticates as a service account via the
// JWT-bearer flow: sign a JWT asserting `target_audience = <Cloud Run URL>`,
// POST it to Google's token endpoint, get back an `id_token` for that audience.
//
// Cross-runtime (Web Crypto + fetch only) so it runs in both the Deno Edge
// Runtime and Node — the latter is how the vitest `server` project tests it.

export interface ServiceAccountKey {
  client_email: string
  /** PEM-encoded PKCS#8 private key (the `private_key` field of the SA JSON). */
  private_key: string
  /** Defaults to Google's public token endpoint. */
  token_uri?: string
}

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

/**
 * Return an ID token (JWT) whose `aud` is `audience` (the Cloud Run service URL).
 * `fetchImpl`/`now` are injectable for tests; production uses the globals.
 */
export async function mintIdToken(
  sa: ServiceAccountKey,
  audience: string,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000)
  const tokenUri = sa.token_uri ?? GOOGLE_TOKEN_URI

  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: tokenUri,
    iat: nowSec,
    exp: nowSec + 3600,
    target_audience: audience,
  }
  const unsigned = `${b64urlJson(header)}.${b64urlJson(claims)}`
  const key = await importPkcs8(sa.private_key)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const assertion = `${unsigned}.${b64urlBytes(new Uint8Array(sig))}`

  const res = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: JWT_BEARER, assertion }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`google token exchange failed: ${res.status} ${detail.slice(0, 200)}`)
  }
  const data = (await res.json()) as { id_token?: string }
  if (!data.id_token) throw new Error('google token exchange returned no id_token')
  return data.id_token
}

async function importPkcs8(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem)
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '')
  const bin = atob(base64)
  const der = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i)
  // Hand back the backing ArrayBuffer so Web Crypto's BufferSource type is
  // satisfied cleanly (a Node Uint8Array's generic buffer type otherwise trips
  // the SharedArrayBuffer-vs-ArrayBuffer check).
  return der.buffer as ArrayBuffer
}

function b64urlJson(obj: unknown): string {
  return b64url(btoa(JSON.stringify(obj)))
}

function b64urlBytes(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return b64url(btoa(bin))
}

function b64url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
