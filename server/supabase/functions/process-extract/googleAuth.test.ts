import { describe, it, expect } from 'vitest'
import { mintIdToken, createCachedIdTokenMinter, type ServiceAccountKey } from './googleAuth'

type FetchLike = typeof fetch

// Generate a throwaway RSA key and export it as PKCS#8 PEM — the exact shape of
// the `private_key` field in a Google service-account JSON.
async function makeServiceAccount(): Promise<ServiceAccountKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  let bin = ''
  for (const b of pkcs8) bin += String.fromCharCode(b)
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`
  return { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: pem }
}

function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(payload))
}

describe('mintIdToken', () => {
  it('signs a target_audience assertion and returns the exchanged id_token', async () => {
    const sa = await makeServiceAccount()
    let captured: { url: string; assertion: string; grant: string } | null = null

    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(init!.body as string)
      captured = {
        url: String(url),
        assertion: form.get('assertion') ?? '',
        grant: form.get('grant_type') ?? '',
      }
      return new Response(JSON.stringify({ id_token: 'signed-id-token' }), { status: 200 })
    }) as unknown as FetchLike

    const token = await mintIdToken(sa, 'https://extract-abc.run.app', {
      fetchImpl,
      now: 1_700_000_000_000,
    })

    expect(token).toBe('signed-id-token')
    expect(captured!.url).toBe('https://oauth2.googleapis.com/token')
    expect(captured!.grant).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')

    // The signed assertion carries the SA identity + the Cloud Run audience.
    const claims = decodeJwtClaims(captured!.assertion)
    expect(claims.iss).toBe('svc@proj.iam.gserviceaccount.com')
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token')
    expect(claims.target_audience).toBe('https://extract-abc.run.app')
    expect(claims.iat).toBe(1_700_000_000)
    expect(claims.exp).toBe(1_700_000_000 + 3600)
    // Three dot-separated segments = a well-formed JWS.
    expect(captured!.assertion.split('.')).toHaveLength(3)
  })

  it('throws when the token endpoint rejects the assertion', async () => {
    const sa = await makeServiceAccount()
    const fetchImpl = (async () => new Response('bad', { status: 400 })) as unknown as FetchLike
    await expect(mintIdToken(sa, 'https://x.run.app', { fetchImpl })).rejects.toThrow(
      /token exchange failed/,
    )
  })

  it('throws when the response carries no id_token', async () => {
    const sa = await makeServiceAccount()
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: 'nope' }), {
        status: 200,
      })) as unknown as FetchLike
    await expect(mintIdToken(sa, 'https://x.run.app', { fetchImpl })).rejects.toThrow(/no id_token/)
  })
})

describe('createCachedIdTokenMinter', () => {
  function countingFetch(): { fetchImpl: FetchLike; calls: () => number } {
    let n = 0
    const fetchImpl = (async () => {
      n += 1
      return new Response(JSON.stringify({ id_token: `tok-${n}` }), { status: 200 })
    }) as unknown as FetchLike
    return { fetchImpl, calls: () => n }
  }

  it('reuses a cached token within its TTL and re-mints after it expires', async () => {
    const sa = await makeServiceAccount()
    const { fetchImpl, calls } = countingFetch()
    let clock = 1_700_000_000_000
    const mint = createCachedIdTokenMinter(sa, { fetchImpl, now: () => clock, ttlMs: 60_000 })

    expect(await mint('https://a.run.app')).toBe('tok-1')
    expect(await mint('https://a.run.app')).toBe('tok-1') // cached — no new exchange
    expect(calls()).toBe(1)

    clock += 60_001 // past the TTL
    expect(await mint('https://a.run.app')).toBe('tok-2') // re-minted
    expect(calls()).toBe(2)
  })

  it('caches per audience', async () => {
    const sa = await makeServiceAccount()
    const { fetchImpl, calls } = countingFetch()
    const mint = createCachedIdTokenMinter(sa, { fetchImpl, now: () => 0, ttlMs: 60_000 })

    expect(await mint('https://a.run.app')).toBe('tok-1')
    expect(await mint('https://b.run.app')).toBe('tok-2') // different audience → its own token
    expect(calls()).toBe(2)
  })
})
