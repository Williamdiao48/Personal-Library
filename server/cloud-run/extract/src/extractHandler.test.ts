import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { handleExtract, ExtractError } from './extractHandler'
import { createExtractServer } from './server'
import { buildEpub, PNG_1x1 } from '../../../../test/fixtures/epub'

type FetchLike = typeof fetch

// A normal EPUB (two chapters + a PNG cover) and a matching garbage blob.
const EPUB = buildEpub({
  title: 'The Hobbit',
  author: 'J.R.R. Tolkien',
  chapters: [
    { href: 'c1.xhtml', title: 'Ch 1', body: '<p>In a hole in the ground.</p>' },
    { href: 'c2.xhtml', title: 'Ch 2', body: '<p>There lived a hobbit.</p>' },
  ],
  cover: { href: 'cover.png', data: PNG_1x1 },
})
const COVER_HASH = createHash('sha256').update(PNG_1x1).digest('hex')

// A fake R2: GET serves `sourceBytes`; PUT records the uploaded body. `opts`
// tweaks status codes / content-length to exercise the guard paths.
function fakeR2(
  sourceBytes: Buffer,
  opts: {
    contentLength?: string
    getStatus?: number
    putStatus?: number
    onPut?: (body: Buffer) => void
  } = {},
): FetchLike {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      opts.onPut?.(Buffer.from(init.body as Uint8Array))
      return new Response(null, { status: opts.putStatus ?? 200 })
    }
    if (opts.getStatus && opts.getStatus >= 400)
      return new Response('no', { status: opts.getStatus })
    const headers: Record<string, string> = {
      'content-length': opts.contentLength ?? String(sourceBytes.length),
    }
    return new Response(new Uint8Array(sourceBytes), { status: 200, headers })
  }) as unknown as FetchLike
}

describe('handleExtract', () => {
  it('extracts metadata + text and uploads the cover, returning its hash', async () => {
    let putBody: Buffer | null = null
    const fetchImpl = fakeR2(EPUB, { onPut: (b) => (putBody = b) })

    const r = await handleExtract(
      { kind: 'epub', sourceUrl: 'https://r2/source', coverPutUrl: 'https://r2/cover' },
      fetchImpl,
    )

    expect(r.title).toBe('The Hobbit')
    expect(r.author).toBe('J.R.R. Tolkien')
    expect(r.plainText).toContain('In a hole in the ground.')
    expect(r.plainText).toContain('There lived a hobbit.')
    expect(r.wordCount).toBe(10)
    // Cover bytes went to R2; the response carries only the content hash, no buffer.
    expect(r.coverHash).toBe(COVER_HASH)
    expect(r.coverExt).toBe('png')
    expect(r).not.toHaveProperty('coverBuffer')
    expect(putBody).not.toBeNull()
    expect(Buffer.compare(putBody!, PNG_1x1)).toBe(0)
  })

  it('skips cover upload (null hash) when no coverPutUrl is given', async () => {
    let putCount = 0
    const fetchImpl = fakeR2(EPUB, { onPut: () => putCount++ })

    const r = await handleExtract({ kind: 'epub', sourceUrl: 'https://r2/source' }, fetchImpl)

    expect(r.title).toBe('The Hobbit')
    expect(r.coverHash).toBeNull()
    expect(putCount).toBe(0)
  })

  it('is best-effort on garbage bytes: empty result, no throw', async () => {
    const r = await handleExtract(
      { kind: 'epub', sourceUrl: 'https://r2/source', coverPutUrl: 'https://r2/cover' },
      fakeR2(Buffer.from('not a zip at all')),
    )
    expect(r).toEqual({
      title: null,
      author: null,
      coverHash: null,
      coverExt: null,
      plainText: '',
      wordCount: null,
    })
  })

  it('rejects an oversized source (declared Content-Length) before reading it', async () => {
    const fetchImpl = fakeR2(EPUB, { contentLength: String(200 * 1_048_576) })
    await expect(
      handleExtract({ kind: 'epub', sourceUrl: 'https://r2/source' }, fetchImpl),
    ).rejects.toMatchObject({ status: 413 })
  })

  it('rejects an unsupported kind', async () => {
    await expect(
      handleExtract(
        { kind: 'pdf' as unknown as 'epub', sourceUrl: 'https://r2/source' },
        fakeR2(EPUB),
      ),
    ).rejects.toBeInstanceOf(ExtractError)
  })

  it('rejects a missing sourceUrl', async () => {
    await expect(
      handleExtract({ kind: 'epub', sourceUrl: '' }, fakeR2(EPUB)),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('maps a failed source fetch to 502', async () => {
    await expect(
      handleExtract(
        { kind: 'epub', sourceUrl: 'https://r2/source' },
        fakeR2(EPUB, { getStatus: 403 }),
      ),
    ).rejects.toMatchObject({ status: 502 })
  })

  it('maps a failed cover upload to 502', async () => {
    await expect(
      handleExtract(
        { kind: 'epub', sourceUrl: 'https://r2/source', coverPutUrl: 'https://r2/cover' },
        fakeR2(EPUB, { putStatus: 500 }),
      ),
    ).rejects.toMatchObject({ status: 502 })
  })
})

// End-to-end plumbing: a real loopback "R2" server + the real extract HTTP
// server, exercised over the network with the global fetch — no GCP, no mocks.
describe('createExtractServer (HTTP plumbing)', () => {
  const servers: Server[] = []
  const listen = (s: Server): Promise<number> =>
    new Promise((resolve) => {
      servers.push(s)
      s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port))
    })
  afterAll(() => servers.forEach((s) => s.close()))

  it('serves /health and runs a full extract round-trip', async () => {
    const puts: Buffer[] = []
    const r2Port = await listen(
      createServer((req, res) => {
        if (req.method === 'PUT') {
          const chunks: Buffer[] = []
          req.on('data', (c) => chunks.push(c))
          req.on('end', () => {
            puts.push(Buffer.concat(chunks))
            res.writeHead(200)
            res.end()
          })
          return
        }
        res.writeHead(200, { 'content-length': String(EPUB.length) })
        res.end(EPUB)
      }),
    )
    const appPort = await listen(createExtractServer())
    const base = `http://127.0.0.1:${appPort}`
    const r2 = `http://127.0.0.1:${r2Port}`

    const health = await fetch(`${base}/health`)
    expect(health.status).toBe(200)

    const missing = await fetch(`${base}/nope`)
    expect(missing.status).toBe(404)

    const resp = await fetch(`${base}/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'epub', sourceUrl: `${r2}/source`, coverPutUrl: `${r2}/cover` }),
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { title: string; coverHash: string; wordCount: number }
    expect(body.title).toBe('The Hobbit')
    expect(body.coverHash).toBe(COVER_HASH)
    expect(body.wordCount).toBe(10)
    expect(puts).toHaveLength(1)
    expect(Buffer.compare(puts[0], PNG_1x1)).toBe(0)
  })
})
