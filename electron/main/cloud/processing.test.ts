import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'

// Mock every seam so these tests are about the cloud-or-local DECISION + the
// upload/invoke/map plumbing — not real files, network, or EPUB parsing.
const h = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  getSession: vi.fn(async () => ({ data: { session: { access_token: 't' } } })),
  invoke: vi.fn(),
  presignBlobUrl: vi.fn(async () => 'https://r2.example/put-url'),
  readFile: vi.fn(async () => Buffer.from('RAW-EPUB-BYTES')),
  parseEpub: vi.fn(async () => ({
    title: 'Local Title',
    author: 'Local Author',
    coverBuffer: null,
    coverExt: null,
    plainText: 'local text',
    wordCount: 2,
  })),
  extractPdf: vi.fn(async () => ({ plainText: 'local pdf text', wordCount: 3 })),
}))
vi.mock('../auth/client', () => ({
  isConfigured: h.isConfigured,
  getSupabase: () => ({
    auth: { getSession: h.getSession },
    functions: { invoke: h.invoke },
  }),
}))
vi.mock('./presign', () => ({ presignBlobUrl: h.presignBlobUrl }))
vi.mock('node:fs/promises', () => ({ readFile: h.readFile }))
vi.mock('../workers/parse-host', () => ({ parseEpub: h.parseEpub }))
vi.mock('../capture/extract', () => ({ extractPdf: h.extractPdf }))

import {
  resolveEpubParse,
  resolvePdfParse,
  cloudExtractEpub,
  cloudExtractPdf,
  setCloudProcessingEnabled,
  isCloudProcessingEnabled,
  __resetForTest,
  __whenReapedForTest,
} from './processing'

const RAW = Buffer.from('RAW-EPUB-BYTES')
const RAW_HASH = createHash('sha256').update(RAW).digest('hex')
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  __resetForTest()
  h.isConfigured.mockReturnValue(true)
  h.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } })
  h.readFile.mockResolvedValue(RAW)
  h.extractPdf.mockResolvedValue({ plainText: 'local pdf text', wordCount: 3 })
  h.presignBlobUrl.mockResolvedValue('https://r2.example/put-url')
  h.invoke.mockResolvedValue({
    data: {
      title: 'Cloud Title',
      author: 'Cloud Author',
      coverBase64: PNG_B64,
      coverExt: 'png',
      plainText: 'cloud text',
      wordCount: 2,
    },
    error: null,
  })
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('setCloudProcessingEnabled / isCloudProcessingEnabled', () => {
  it('mirrors the master switch', () => {
    expect(isCloudProcessingEnabled()).toBe(false)
    setCloudProcessingEnabled(true)
    expect(isCloudProcessingEnabled()).toBe(true)
    setCloudProcessingEnabled(false)
    expect(isCloudProcessingEnabled()).toBe(false)
  })
})

describe('cloudExtractEpub', () => {
  it('uploads the raw source, invokes process-extract, and maps the result', async () => {
    const result = await cloudExtractEpub('/tmp/book.epub')

    // Presigned a PUT for the transient scratch blob keyed by the RAW bytes' sha256,
    // with the raw byte count as the upload-size cap ('RAW-EPUB-BYTES' = 14 bytes).
    expect(h.presignBlobUrl).toHaveBeenCalledWith('put', 'scratch', RAW_HASH, RAW.length)
    // Raw bytes PUT to the presigned URL (the first fetch; a reap DELETE may follow).
    expect(fetchMock.mock.calls[0][0]).toBe('https://r2.example/put-url')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT' })
    // process-extract invoked with the SAME content_hash (not the request body's).
    expect(h.invoke).toHaveBeenCalledWith('process-extract', {
      body: { kind: 'epub', content_hash: RAW_HASH },
    })
    // Result mapped to the EpubParseResult shape, inline cover decoded to a Buffer.
    expect(result.title).toBe('Cloud Title')
    expect(result.author).toBe('Cloud Author')
    expect(result.coverExt).toBe('png')
    expect(result.coverBuffer).toBeInstanceOf(Buffer)
    expect(result.coverBuffer?.toString('base64')).toBe(PNG_B64)
    expect(result.plainText).toBe('cloud text')
    expect(result.wordCount).toBe(2)
  })

  it('maps a null cover and null metadata cleanly', async () => {
    h.invoke.mockResolvedValue({
      data: {
        title: null,
        author: null,
        coverBase64: null,
        coverExt: null,
        plainText: '',
        wordCount: null,
      },
      error: null,
    })
    const result = await cloudExtractEpub('/tmp/book.epub')
    expect(result.coverBuffer).toBeNull()
    expect(result.title).toBeNull()
    expect(result.wordCount).toBeNull()
  })

  it('drops an over-cap inline cover (untrusted container output, SEC-4)', async () => {
    // >10 MiB decoded — beyond COVER_MAX_BYTES; must be dropped, not materialized.
    const huge = Buffer.alloc(11 * 1024 * 1024, 0x41).toString('base64')
    h.invoke.mockResolvedValue({
      data: {
        title: 'Cloud Title',
        author: null,
        coverBase64: huge,
        coverExt: 'png',
        plainText: 'cloud text',
        wordCount: 1,
      },
      error: null,
    })
    const result = await cloudExtractEpub('/tmp/book.epub')
    expect(result.coverBuffer).toBeNull()
    expect(result.coverExt).toBeNull()
    // The rest of the extraction still comes through.
    expect(result.title).toBe('Cloud Title')
    expect(result.plainText).toBe('cloud text')
  })

  it('throws when the source upload fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '<Error>denied</Error>',
    } as unknown as Response)
    await expect(cloudExtractEpub('/tmp/book.epub')).rejects.toThrow(/source upload failed \(403\)/)
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('throws when process-extract returns an error', async () => {
    h.invoke.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await expect(cloudExtractEpub('/tmp/book.epub')).rejects.toThrow(/process-extract failed: boom/)
  })

  it('throws on an unexpected response shape', async () => {
    h.invoke.mockResolvedValue({ data: { nope: true }, error: null })
    await expect(cloudExtractEpub('/tmp/book.epub')).rejects.toThrow(/unexpected response/)
  })
})

describe('source reaping (HYGIENE-1)', () => {
  it('deletes the transient source object after a successful extraction', async () => {
    await cloudExtractEpub('/tmp/book.epub')
    await __whenReapedForTest()
    // Presigned a DELETE for the same scratch hash, then issued it to R2.
    expect(h.presignBlobUrl).toHaveBeenCalledWith('delete', 'scratch', RAW_HASH)
    const del = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'DELETE')
    expect(del).toBeDefined()
    expect(del![0]).toBe('https://r2.example/put-url') // mock returns one URL for every op
  })

  it('still reaps after a failed extraction (finally runs)', async () => {
    h.invoke.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await expect(cloudExtractEpub('/tmp/book.epub')).rejects.toThrow(/boom/)
    await __whenReapedForTest()
    expect(h.presignBlobUrl).toHaveBeenCalledWith('delete', 'scratch', RAW_HASH)
  })

  it('swallows a reap failure without affecting the extraction result', async () => {
    h.presignBlobUrl.mockImplementation(async (op: string) => {
      if (op === 'delete') throw new Error('reap presign failed')
      return 'https://r2.example/put-url'
    })
    const result = await cloudExtractEpub('/tmp/book.epub')
    expect(result.title).toBe('Cloud Title') // extraction unaffected
    await expect(__whenReapedForTest()).resolves.toBeUndefined() // reap never throws
  })
})

describe('cloudExtractPdf', () => {
  it('uploads the raw source, invokes process-extract with kind:pdf, maps text + count', async () => {
    h.invoke.mockResolvedValue({
      data: {
        title: null,
        author: null,
        coverBase64: null,
        coverExt: null,
        plainText: 'cloud pdf text',
        wordCount: 5,
      },
      error: null,
    })
    const result = await cloudExtractPdf('/tmp/doc.pdf')

    expect(h.presignBlobUrl).toHaveBeenCalledWith('put', 'scratch', RAW_HASH, RAW.length)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT' })
    expect(h.invoke).toHaveBeenCalledWith('process-extract', {
      body: { kind: 'pdf', content_hash: RAW_HASH },
    })
    // PDFs carry no title/author/cover — the mapped result is text + count only.
    expect(result).toEqual({ plainText: 'cloud pdf text', wordCount: 5 })
  })

  it('throws when the source upload fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'denied',
    } as unknown as Response)
    await expect(cloudExtractPdf('/tmp/doc.pdf')).rejects.toThrow(/source upload failed \(403\)/)
    expect(h.invoke).not.toHaveBeenCalled()
  })
})

describe('resolveEpubParse', () => {
  it('parses locally when cloud processing is disabled', async () => {
    setCloudProcessingEnabled(false)
    const result = await resolveEpubParse('/tmp/book.epub')
    expect(result.title).toBe('Local Title')
    expect(h.parseEpub).toHaveBeenCalledWith('/tmp/book.epub')
    expect(h.presignBlobUrl).not.toHaveBeenCalled()
  })

  it('parses locally when enabled but the build is not configured', async () => {
    setCloudProcessingEnabled(true)
    h.isConfigured.mockReturnValue(false)
    const result = await resolveEpubParse('/tmp/book.epub')
    expect(result.title).toBe('Local Title')
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('parses locally when enabled + configured but signed out', async () => {
    setCloudProcessingEnabled(true)
    h.getSession.mockResolvedValue({ data: { session: null } })
    const result = await resolveEpubParse('/tmp/book.epub')
    expect(result.title).toBe('Local Title')
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('parses in the cloud when enabled + configured + signed in', async () => {
    setCloudProcessingEnabled(true)
    const result = await resolveEpubParse('/tmp/book.epub')
    expect(result.title).toBe('Cloud Title')
    expect(h.invoke).toHaveBeenCalledOnce()
    expect(h.parseEpub).not.toHaveBeenCalled()
  })

  it('falls back to local when cloud extraction throws', async () => {
    setCloudProcessingEnabled(true)
    fetchMock.mockRejectedValue(new Error('offline'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await resolveEpubParse('/tmp/book.epub')
    expect(result.title).toBe('Local Title')
    expect(h.parseEpub).toHaveBeenCalledWith('/tmp/book.epub')
    warn.mockRestore()
  })
})

describe('resolvePdfParse', () => {
  it('parses locally when cloud processing is disabled', async () => {
    setCloudProcessingEnabled(false)
    const result = await resolvePdfParse('/tmp/doc.pdf')
    expect(result).toEqual({ plainText: 'local pdf text', wordCount: 3 })
    expect(h.extractPdf).toHaveBeenCalledWith('/tmp/doc.pdf')
    expect(h.presignBlobUrl).not.toHaveBeenCalled()
  })

  it('parses in the cloud when enabled + configured + signed in', async () => {
    setCloudProcessingEnabled(true)
    h.invoke.mockResolvedValue({
      data: {
        title: null,
        author: null,
        coverBase64: null,
        coverExt: null,
        plainText: 'cloud pdf text',
        wordCount: 5,
      },
      error: null,
    })
    const result = await resolvePdfParse('/tmp/doc.pdf')
    expect(result).toEqual({ plainText: 'cloud pdf text', wordCount: 5 })
    expect(h.invoke).toHaveBeenCalledOnce()
    expect(h.extractPdf).not.toHaveBeenCalled()
  })

  it('falls back to local when cloud extraction throws', async () => {
    setCloudProcessingEnabled(true)
    fetchMock.mockRejectedValue(new Error('offline'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await resolvePdfParse('/tmp/doc.pdf')
    expect(result).toEqual({ plainText: 'local pdf text', wordCount: 3 })
    expect(h.extractPdf).toHaveBeenCalledWith('/tmp/doc.pdf')
    warn.mockRestore()
  })
})
