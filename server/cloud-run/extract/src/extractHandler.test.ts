import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleExtract, ExtractError } from './extractHandler'
import { createExtractServer } from './server'
import { buildEpub, PNG_1x1 } from '../../../../test/fixtures/epub'
import { buildPdf } from '../../../../test/fixtures/pdf'

type FetchLike = typeof fetch

// A normal EPUB (two chapters + a PNG cover) and, per test, a garbage blob.
const EPUB = buildEpub({
  title: 'The Hobbit',
  author: 'J.R.R. Tolkien',
  chapters: [
    { href: 'c1.xhtml', title: 'Ch 1', body: '<p>In a hole in the ground.</p>' },
    { href: 'c2.xhtml', title: 'Ch 2', body: '<p>There lived a hobbit.</p>' },
  ],
  cover: { href: 'cover.png', data: PNG_1x1 },
})
const EPUB_NO_COVER = buildEpub({
  title: 'No Cover',
  chapters: [{ href: 'c1.xhtml', title: 'Ch 1', body: '<p>Body.</p>' }],
})
const PDF = Buffer.from(buildPdf('Hello World from PDF'))

// A fake R2: a GET that serves `sourceBytes`. `opts` tweaks status / content-
// length to exercise the guard paths. The container only ever does a GET now.
function fakeR2(
  sourceBytes: Buffer,
  opts: { contentLength?: string; getStatus?: number } = {},
): FetchLike {
  return (async () => {
    if (opts.getStatus && opts.getStatus >= 400)
      return new Response('no', { status: opts.getStatus })
    const headers: Record<string, string> = {
      'content-length': opts.contentLength ?? String(sourceBytes.length),
    }
    return new Response(new Uint8Array(sourceBytes), { status: 200, headers })
  }) as unknown as FetchLike
}

describe('handleExtract', () => {
  it('extracts metadata + text and returns the cover inline as base64', async () => {
    const r = await handleExtract({ kind: 'epub', sourceUrl: 'https://r2/source' }, fakeR2(EPUB))

    expect(r.title).toBe('The Hobbit')
    expect(r.author).toBe('J.R.R. Tolkien')
    expect(r.plainText).toContain('In a hole in the ground.')
    expect(r.plainText).toContain('There lived a hobbit.')
    expect(r.wordCount).toBe(10)
    // Cover rides back inline; it must round-trip to the original bytes.
    expect(r.coverExt).toBe('png')
    expect(r.coverBase64).not.toBeNull()
    expect(Buffer.compare(Buffer.from(r.coverBase64!, 'base64'), PNG_1x1)).toBe(0)
    // The container holds no bytes for R2 — no PUT concept remains.
    expect(r).not.toHaveProperty('coverHash')
  })

  it('returns a null cover for an EPUB without one', async () => {
    const r = await handleExtract(
      { kind: 'epub', sourceUrl: 'https://r2/source' },
      fakeR2(EPUB_NO_COVER),
    )
    expect(r.title).toBe('No Cover')
    expect(r.coverBase64).toBeNull()
    expect(r.coverExt).toBeNull()
  })

  it('is best-effort on garbage bytes: empty result, no throw', async () => {
    const r = await handleExtract(
      { kind: 'epub', sourceUrl: 'https://r2/source' },
      fakeR2(Buffer.from('not a zip at all')),
    )
    expect(r).toEqual({
      title: null,
      author: null,
      coverBase64: null,
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

  it('extracts a PDF: text + word count, null metadata/cover', async () => {
    const r = await handleExtract({ kind: 'pdf', sourceUrl: 'https://r2/source' }, fakeR2(PDF))
    expect(r.plainText).toContain('Hello World from PDF')
    expect(r.wordCount).toBe(4)
    expect(r.title).toBeNull()
    expect(r.author).toBeNull()
    expect(r.coverBase64).toBeNull()
    expect(r.coverExt).toBeNull()
  })

  it('is best-effort on a garbage PDF: empty result, no throw', async () => {
    const r = await handleExtract(
      { kind: 'pdf', sourceUrl: 'https://r2/source' },
      fakeR2(Buffer.from('not a pdf at all')),
    )
    expect(r).toEqual({
      title: null,
      author: null,
      coverBase64: null,
      coverExt: null,
      plainText: '',
      wordCount: null,
    })
  })

  it('rejects an oversized PDF source (declared Content-Length) before reading it', async () => {
    const fetchImpl = fakeR2(PDF, { contentLength: String(300 * 1_048_576) })
    await expect(
      handleExtract({ kind: 'pdf', sourceUrl: 'https://r2/source' }, fetchImpl),
    ).rejects.toMatchObject({ status: 413 })
  })

  it('rejects an unsupported kind', async () => {
    await expect(
      handleExtract(
        { kind: 'html' as unknown as 'epub', sourceUrl: 'https://r2/source' },
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
    const r2Port = await listen(
      createServer((_req, res) => {
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
      body: JSON.stringify({ kind: 'epub', sourceUrl: `${r2}/source` }),
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as {
      title: string
      coverBase64: string
      wordCount: number
    }
    expect(body.title).toBe('The Hobbit')
    expect(body.wordCount).toBe(10)
    expect(Buffer.compare(Buffer.from(body.coverBase64, 'base64'), PNG_1x1)).toBe(0)
  })
})
