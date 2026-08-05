// ─────────────────────────────────────────────────────────────────────────────
// Cloud Run extraction handler (Phase 4). The container's one job: turn an
// UNTRUSTED source file (pulled from R2 via a presigned GET) into the app's
// canonical result shape, off the user's machine.
//
// It holds NO long-lived credential (Decision 3): the Edge Function mints ONE
// presigned GET for the source and hands it in per request — that's the only
// capability the container ever gets. All CPU work runs through the SHARED
// extractor (electron/main/capture/extract) — the exact same code the Electron
// parse worker runs — so the cloud result is byte-identical to the local one,
// with the same zip-bomb / inflate / size guards baked in.
//
// The cover is returned INLINE (base64), not PUT to R2 by the container: covers
// are content-addressed by sha256(cover bytes), a hash only known AFTER
// extraction, so the Edge Function can't presign the right key ahead of time.
// Returning the (small) cover lets the CLIENT content-address + store it via the
// exact same Phase-2 path it uses for locally-extracted covers — one code path,
// and the container stays a pure GET-only, credential-light worker.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractEpub, extractPdf } from '../../../../electron/main/capture/extract'
import { EPUB_MAX_BYTES, PDF_MAX_BYTES } from '../../../../electron/main/security/validation'

export interface ExtractRequest {
  /** EPUB + PDF supported (Chunk 6); scraped-HTML joins in a later chunk. */
  kind: 'epub' | 'pdf'
  /** Presigned R2 GET URL for the untrusted source blob. */
  sourceUrl: string
}

/** Whole-file size cap per kind — the same guard the local import path enforces. */
const MAX_BYTES: Record<ExtractRequest['kind'], number> = {
  epub: EPUB_MAX_BYTES,
  pdf: PDF_MAX_BYTES,
}

// Bound the R2 GET so a stalled fetch can't pin an instance until Cloud Run's own
// request timeout (--timeout=120). The source is already in R2, so this is generous.
const SOURCE_FETCH_TIMEOUT_MS = 60_000

/**
 * The wire result. Mirrors {@link EpubParseResult} but carries the cover as
 * base64 (`coverBase64`) instead of a Node Buffer, since it travels as JSON. The
 * client decodes it back to bytes and stores it exactly as a local cover.
 */
export interface ExtractResponse {
  title: string | null
  author: string | null
  coverBase64: string | null
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
  if (!req || (req.kind !== 'epub' && req.kind !== 'pdf')) {
    throw new ExtractError(400, `unsupported kind: ${String(req?.kind)}`)
  }
  if (typeof req.sourceUrl !== 'string' || req.sourceUrl.length === 0) {
    throw new ExtractError(400, 'missing sourceUrl')
  }

  // 1. Pull the untrusted source from R2. Enforce the same per-kind whole-file
  //    size cap the local import path uses — reject early on a declared
  //    Content-Length, and again after read in case the header lied.
  const maxBytes = MAX_BYTES[req.kind]
  const res = await fetchImpl(req.sourceUrl, {
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new ExtractError(502, `source fetch failed: ${res.status}`)
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ExtractError(413, `source too large: ${declared} bytes`)
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > maxBytes) {
    throw new ExtractError(413, `source too large: ${bytes.length} bytes`)
  }

  // 2. The shared extractors read a file PATH; stage the bytes in tmpfs (/tmp)
  //    and always clean up. The zip-bomb / inflate / pdf.js guards live inside the
  //    shared extractor, so a malicious file is bounded here just as it is locally.
  const dir = await mkdtemp(join(tmpdir(), 'extract-'))
  const srcPath = join(dir, `${randomUUID()}.${req.kind}`)
  try {
    await writeFile(srcPath, bytes)

    // PDF: text-only, no metadata/cover (parity with the local capturePdf path).
    if (req.kind === 'pdf') {
      const result = await extractPdf(srcPath)
      return {
        title: null,
        author: null,
        coverBase64: null,
        coverExt: null,
        plainText: result.plainText,
        wordCount: result.wordCount,
      }
    }

    // EPUB: metadata + text; the cover (if any) rides back inline as base64 so the
    // client hashes + stores it just like a local cover. No PUT — see header note.
    const result = extractEpub(srcPath)
    return {
      title: result.title,
      author: result.author,
      coverBase64: result.coverBuffer ? result.coverBuffer.toString('base64') : null,
      coverExt: result.coverExt,
      plainText: result.plainText,
      wordCount: result.wordCount,
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
