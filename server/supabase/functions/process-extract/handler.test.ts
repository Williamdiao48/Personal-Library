import { describe, it, expect, vi } from 'vitest'
import { handleProcessExtract, type ProcessExtractDeps } from './handler'

const HASH = 'a'.repeat(64)

// Baseline deps: JWT ok, presign + token trivial, Cloud Run echoes a result.
function makeDeps(over: Partial<ProcessExtractDeps> = {}): ProcessExtractDeps {
  return {
    verifyJwt: vi.fn(async () => 'user-1'),
    presignSourceGet: vi.fn(async (uid: string, hash: string) => `https://r2/${uid}/${hash}?sig`),
    mintToken: vi.fn(async () => 'id-token-123'),
    invokeCloudRun: vi.fn(
      async () =>
        new Response(JSON.stringify({ title: 'The Hobbit', wordCount: 10 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
    cloudRunUrl: 'https://extract-abc.run.app',
    ...over,
  }
}

function post(
  body: unknown,
  headers: Record<string, string> = { Authorization: 'Bearer x' },
): Request {
  return new Request('https://fn/process-extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('handleProcessExtract', () => {
  it('runs the full orchestration and returns the container result', async () => {
    const deps = makeDeps()
    const res = await handleProcessExtract(post({ kind: 'epub', content_hash: HASH }), deps)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ title: 'The Hobbit', wordCount: 10 })

    // Presign was scoped to the VERIFIED user id + the requested hash.
    expect(deps.presignSourceGet).toHaveBeenCalledWith('user-1', HASH)
    // Cloud Run was invoked at /extract with the bearer token and the presigned URL.
    expect(deps.mintToken).toHaveBeenCalledWith('https://extract-abc.run.app')
    expect(deps.invokeCloudRun).toHaveBeenCalledWith(
      'https://extract-abc.run.app/extract',
      'id-token-123',
      { kind: 'epub', sourceUrl: `https://r2/user-1/${HASH}?sig` },
    )
  })

  it('does not double a slash when cloudRunUrl has a trailing one', async () => {
    const deps = makeDeps({ cloudRunUrl: 'https://extract-abc.run.app/' })
    await handleProcessExtract(post({ kind: 'epub', content_hash: HASH }), deps)
    expect(deps.invokeCloudRun).toHaveBeenCalledWith(
      'https://extract-abc.run.app/extract',
      expect.any(String),
      expect.anything(),
    )
  })

  it('401s when the JWT does not verify (and never touches Cloud Run)', async () => {
    const deps = makeDeps({ verifyJwt: vi.fn(async () => null) })
    const res = await handleProcessExtract(post({ kind: 'epub', content_hash: HASH }), deps)
    expect(res.status).toBe(401)
    expect(deps.presignSourceGet).not.toHaveBeenCalled()
    expect(deps.invokeCloudRun).not.toHaveBeenCalled()
  })

  it('405s a non-POST method', async () => {
    const req = new Request('https://fn/process-extract', { method: 'GET' })
    const res = await handleProcessExtract(req, makeDeps())
    expect(res.status).toBe(405)
  })

  it('handles a CORS preflight', async () => {
    const req = new Request('https://fn/process-extract', { method: 'OPTIONS' })
    const res = await handleProcessExtract(req, makeDeps())
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
  })

  it('400s invalid JSON', async () => {
    const req = new Request('https://fn/process-extract', {
      method: 'POST',
      headers: { Authorization: 'Bearer x', 'content-type': 'application/json' },
      body: 'not json',
    })
    const res = await handleProcessExtract(req, makeDeps())
    expect(res.status).toBe(400)
  })

  it('400s a non-epub kind', async () => {
    const res = await handleProcessExtract(post({ kind: 'pdf', content_hash: HASH }), makeDeps())
    expect(res.status).toBe(400)
  })

  it('400s a malformed content_hash', async () => {
    const res = await handleProcessExtract(post({ kind: 'epub', content_hash: 'nope' }), makeDeps())
    expect(res.status).toBe(400)
  })

  it('maps a Cloud Run failure to 502 with bounded detail', async () => {
    const deps = makeDeps({
      invokeCloudRun: vi.fn(async () => new Response('x'.repeat(2000), { status: 500 })),
    })
    const res = await handleProcessExtract(post({ kind: 'epub', content_hash: HASH }), deps)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; status: number; detail: string }
    expect(body.error).toBe('extraction failed')
    expect(body.status).toBe(500)
    expect(body.detail.length).toBeLessThanOrEqual(500)
  })
})
