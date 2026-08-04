import { describe, it, expect, vi } from 'vitest'
import { handleBlobUrl, MAX_PUT_BYTES, EXPIRES_SECONDS, type BlobUrlDeps } from './handler'

const HASH = 'a'.repeat(64)

// Baseline deps: JWT ok, presign echoes back its args so we can assert scoping +
// the size that will be baked into the signature.
function makeDeps(over: Partial<BlobUrlDeps> = {}): BlobUrlDeps {
  return {
    verifyJwt: vi.fn(async () => 'user-1'),
    presign: vi.fn(
      async ({ op, key, contentLength }) =>
        `https://r2/${key}?op=${op}${contentLength !== undefined ? `&len=${contentLength}` : ''}`,
    ),
    ...over,
  }
}

function post(
  body: unknown,
  headers: Record<string, string> = { Authorization: 'Bearer x' },
): Request {
  return new Request('https://fn/blob-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('handleBlobUrl', () => {
  it('signs a PUT scoped to the verified user, forwarding the declared size as the cap', async () => {
    const deps = makeDeps()
    const res = await handleBlobUrl(
      post({ op: 'put', kind: 'content', hash: HASH, size: 1234 }),
      deps,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      key: `users/user-1/content/${HASH}`,
      expiresIn: EXPIRES_SECONDS,
    })
    // Key is scoped to the VERIFIED user id + requested hash; size threaded through.
    expect(deps.presign).toHaveBeenCalledWith({
      op: 'put',
      key: `users/user-1/content/${HASH}`,
      contentLength: 1234,
    })
  })

  it('signs a GET with no size (size is not required and is ignored)', async () => {
    const deps = makeDeps()
    const res = await handleBlobUrl(post({ op: 'get', kind: 'content', hash: HASH }), deps)
    expect(res.status).toBe(200)
    expect(deps.presign).toHaveBeenCalledWith({
      op: 'get',
      key: `users/user-1/content/${HASH}`,
      contentLength: undefined,
    })
  })

  it('accepts a PUT exactly at the per-kind cap', async () => {
    const deps = makeDeps()
    const res = await handleBlobUrl(
      post({ op: 'put', kind: 'content', hash: HASH, size: MAX_PUT_BYTES.content }),
      deps,
    )
    expect(res.status).toBe(200)
    expect(deps.presign).toHaveBeenCalledWith(
      expect.objectContaining({ contentLength: MAX_PUT_BYTES.content }),
    )
  })

  it('400s a PUT with no size (never presigns)', async () => {
    const deps = makeDeps()
    const res = await handleBlobUrl(post({ op: 'put', kind: 'content', hash: HASH }), deps)
    expect(res.status).toBe(400)
    expect(deps.presign).not.toHaveBeenCalled()
  })

  it('400s a PUT whose size exceeds the per-kind cap (never presigns)', async () => {
    const deps = makeDeps()
    const res = await handleBlobUrl(
      post({ op: 'put', kind: 'cover', hash: HASH, size: MAX_PUT_BYTES.cover + 1 }),
      deps,
    )
    expect(res.status).toBe(400)
    expect(deps.presign).not.toHaveBeenCalled()
  })

  it('400s a non-integer, zero, negative, or non-numeric size', async () => {
    for (const size of [0, -1, 3.5, '100', null]) {
      const deps = makeDeps()
      const res = await handleBlobUrl(post({ op: 'put', kind: 'content', hash: HASH, size }), deps)
      expect(res.status).toBe(400)
      expect(deps.presign).not.toHaveBeenCalled()
    }
  })

  it('caps covers below content', () => {
    expect(MAX_PUT_BYTES.cover).toBeLessThan(MAX_PUT_BYTES.content)
  })

  it('401s when the JWT does not verify (and never presigns)', async () => {
    const deps = makeDeps({ verifyJwt: vi.fn(async () => null) })
    const res = await handleBlobUrl(post({ op: 'put', kind: 'content', hash: HASH, size: 1 }), deps)
    expect(res.status).toBe(401)
    expect(deps.presign).not.toHaveBeenCalled()
  })

  it('400s an unknown op', async () => {
    const res = await handleBlobUrl(
      post({ op: 'delete', kind: 'content', hash: HASH, size: 1 }),
      makeDeps(),
    )
    expect(res.status).toBe(400)
  })

  it('400s an unknown kind', async () => {
    const res = await handleBlobUrl(post({ op: 'get', kind: 'thumbnail', hash: HASH }), makeDeps())
    expect(res.status).toBe(400)
  })

  it('400s a malformed hash', async () => {
    const res = await handleBlobUrl(post({ op: 'get', kind: 'content', hash: 'nope' }), makeDeps())
    expect(res.status).toBe(400)
  })

  it('405s a non-POST method', async () => {
    const res = await handleBlobUrl(
      new Request('https://fn/blob-url', { method: 'PUT' }),
      makeDeps(),
    )
    expect(res.status).toBe(405)
  })

  it('handles a CORS preflight', async () => {
    const res = await handleBlobUrl(
      new Request('https://fn/blob-url', { method: 'OPTIONS' }),
      makeDeps(),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
  })

  it('400s invalid JSON', async () => {
    const req = new Request('https://fn/blob-url', {
      method: 'POST',
      headers: { Authorization: 'Bearer x', 'content-type': 'application/json' },
      body: 'not json',
    })
    const res = await handleBlobUrl(req, makeDeps())
    expect(res.status).toBe(400)
  })
})
