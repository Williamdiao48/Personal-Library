// ─────────────────────────────────────────────────────────────────────────────
// Cloud Run extraction handler (Phase 4). The container's one job: turn an
// UNTRUSTED source file (pulled from R2 via a presigned GET) into the app's
// canonical result shape, off the user's machine.
//
// It holds NO long-lived credential (Decision 3): the Edge Function mints a
// presigned GET for the source and a presigned PUT for the cover blob and hands
// both in per request. All CPU work runs through the SHARED extractor
// (electron/main/capture/extract) — the exact same code the Electron parse
// worker runs — so the cloud result is byte-identical to the local one, with the
// same zip-bomb / inflate / size guards baked in.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractEpub } from '../../../../electron/main/capture/extract'
import { EPUB_MAX_BYTES } from '../../../../electron/main/security/validation'

export interface ExtractRequest {
  /** Only EPUB in the Phase 4 MVP; PDF + scraped-HTML join in Chunk 6. */
  kind: 'epub'
  /** Presigned R2 GET URL for the untrusted source blob. */
  sourceUrl: string
  /** Presigned R2 PUT URL for the cover blob; omit to skip cover storage. */
  coverPutUrl?: string
}

/**
 * The wire result. Mirrors {@link EpubParseResult} but drops `coverBuffer` (the
 * bytes go straight to R2) and adds the content-addressed `coverHash` the
 * Phase-2/3 cover model keys on.
 */
export interface ExtractResponse {
  title: string | null
  author: string | null
  coverHash: string | null
  coverExt: string | null
  plainText: string
  wordCount: number | null
}

/** Carries an HTTP status so the server layer can map failures to responses. */
export class ExtractError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ExtractError'
  }
}

type FetchLike = typeof fetch

/**
 * Run one extraction job. `fetchImpl` is injectable so tests can stand in a fake
 * R2; production passes the global `fetch`. Never throws a bare error — every
 * failure path is an {@link ExtractError} with a status.
 */
export async function handleExtract(
  req: ExtractRequest,
  fetchImpl: FetchLike = fetch,
): Promise<ExtractResponse> {
  if (!req || req.kind !== 'epub') {
    throw new ExtractError(400, `unsupported kind: ${String(req?.kind)}`)
  }
  if (typeof req.sourceUrl !== 'string' || req.sourceUrl.length === 0) {
    throw new ExtractError(400, 'missing sourceUrl')
  }

  // 1. Pull the untrusted source from R2. Enforce the same whole-file size cap
  //    the local import path uses — reject early on a declared Content-Length,
  //    and again after read in case the header lied.
  const res = await fetchImpl(req.sourceUrl)
  if (!res.ok) throw new ExtractError(502, `source fetch failed: ${res.status}`)
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > EPUB_MAX_BYTES) {
    throw new ExtractError(413, `source too large: ${declared} bytes`)
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > EPUB_MAX_BYTES) {
    throw new ExtractError(413, `source too large: ${bytes.length} bytes`)
  }

  // 2. extractEpub reads a file PATH; stage the bytes in tmpfs (/tmp) and always
  //    clean up. The zip-bomb / per-entry inflate guards live inside the shared
  //    extractor, so a malicious archive is bounded here just as it is locally.
  const dir = await mkdtemp(join(tmpdir(), 'extract-'))
  const srcPath = join(dir, `${randomUUID()}.epub`)
  try {
    await writeFile(srcPath, bytes)
    const result = extractEpub(srcPath)

    // 3. Cover bytes (if any) become a content-addressed R2 blob; return the hash
    //    so the client can slot it straight into the Phase-2/3 cover model.
    let coverHash: string | null = null
    if (result.coverBuffer && req.coverPutUrl) {
      coverHash = createHash('sha256').update(result.coverBuffer).digest('hex')
      const put = await fetchImpl(req.coverPutUrl, {
        method: 'PUT',
        // Fresh Uint8Array view: a Node Buffer's generic type doesn't line up with
        // the DOM `BodyInit` the fetch types expect, though it works at runtime.
        body: new Uint8Array(result.coverBuffer),
        headers: { 'content-type': coverContentType(result.coverExt) },
      })
      if (!put.ok) throw new ExtractError(502, `cover upload failed: ${put.status}`)
    }

    return {
      title: result.title,
      author: result.author,
      coverHash,
      coverExt: result.coverExt,
      plainText: result.plainText,
      wordCount: result.wordCount,
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function coverContentType(ext: string | null): string {
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}
