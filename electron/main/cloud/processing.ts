import { readFile } from 'node:fs/promises'
import { getSupabase, isConfigured } from '../auth/client'
import { presignBlobUrl } from './presign'
import { sha256Hex } from './blobHash'
import { parseEpub } from '../workers/parse-host'
import { extractPdf, type PdfParseResult } from '../capture/extract'
import { COVER_MAX_BYTES } from '../security/validation'
import type { EpubParseResult } from '../workers/parse-protocol'

// ─────────────────────────────────────────────────────────────────────────────
// Cloud processing (Phase 4) — the client half of off-device file extraction.
//
// The whole point is SECURITY: an untrusted file is parsed inside a throwaway
// Cloud Run container, not on the user's machine. When the user opts in (and is
// signed in + reachable), an import uploads the RAW source to the user's own R2
// prefix, then calls the `process-extract` Edge Function, which presigns a GET
// for that same object, mints a Google ID token, and drives the private
// container. The container returns metadata + an INLINE cover, which we map back
// to the exact EpubParseResult the local sandboxed worker produces — so the
// capture pipeline is agnostic to where parsing happened.
//
// Opt-in + best-effort: OFF by default, and ANY failure (offline, signed out,
// server error) falls back to the local worker so an import never blocks on the
// network. Local parsing stays the default and the offline path.
//
// The master switch is renderer-owned (localStorage) and mirrored here on boot +
// on toggle, exactly like enableDiscover / enableSync.
// ─────────────────────────────────────────────────────────────────────────────

let enabled = false

// Bounds so a stalled network/container falls back to local parsing instead of
// hanging the import indefinitely. The upload can be a large book on a slow link;
// the invoke must outlast the container's own work ceiling (Cloud Run --timeout=120).
const SOURCE_UPLOAD_TIMEOUT_MS = 120_000
const EXTRACT_INVOKE_TIMEOUT_MS = 150_000
const SOURCE_REAP_TIMEOUT_MS = 30_000

/** Reject `p` if it hasn't settled within `ms` (best-effort cancel — the underlying
 *  call may still settle later and is ignored). supabase-js `invoke` takes no signal,
 *  so a timeout race is how we bound it. */
function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

// The last reap promise, so tests can await the fire-and-forget cleanup deterministically.
let lastReap: Promise<void> = Promise.resolve()

/** Mirror the renderer's master switch into the main process. */
export function setCloudProcessingEnabled(next: boolean): void {
  enabled = next
}

/** Current master-switch state (main-process copy of the renderer setting). */
export function isCloudProcessingEnabled(): boolean {
  return enabled
}

// The process-extract response — mirror of the container's ExtractResponse. The
// cover comes back base64-encoded inline (there is no cover R2 key to presign
// until its bytes — and thus its hash — exist).
interface CloudExtractResponse {
  title: string | null
  author: string | null
  coverBase64: string | null
  coverExt: string | null
  plainText: string
  wordCount: number | null
}

/** Enabled AND the build is configured AND a session exists. The network itself
 *  is probed implicitly — an offline upload/invoke just throws and we fall back. */
async function canCloudProcess(): Promise<boolean> {
  if (!enabled || !isConfigured()) return false
  const supabase = getSupabase()
  if (!supabase) return false
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return !!session
}

/**
 * Extract a source file off-device via the Phase 4 pipeline (kind-agnostic core).
 * Uploads the RAW source to the caller's own R2 prefix (content-addressed by the
 * raw bytes' sha256) so the container can GET it, invokes `process-extract`, and
 * returns the raw container response. Throws on any failure; the per-kind wrappers
 * map the result and callers fall back to local parsing.
 *
 * Note the key is sha256(raw bytes) — NOT the Phase-2 backup key, which is
 * sha256(packed archive) (itemBlob.buildContentBlob). It's uploaded under the dedicated
 * top-level `scratch/<uid>/<hash>` prefix (NOT `content/`, where real backups live), so
 * it dedupes only against another cloud-extract of the same file (idempotent overwrite),
 * never against the item's backup. It's a transient extraction input: reaped inline below
 * (fast path), with an R2 lifecycle rule on the `scratch/` prefix as the crash/offline
 * backstop. Segregating the prefix is what makes that age-based rule safe (it can never
 * touch a permanent `content/`/`cover/` object).
 */
async function cloudExtract(filePath: string, kind: 'epub' | 'pdf'): Promise<CloudExtractResponse> {
  const supabase = getSupabase()
  if (!supabase) throw new Error('cloud not configured')

  // Hashing is not parsing — reading the raw bytes to address + upload them keeps
  // the untrusted content unparsed on this machine (the whole security premise).
  const bytes = await readFile(filePath)
  const contentHash = sha256Hex(bytes)

  // 1 — Upload the raw source so the container can GET it. scratch/<uid>/<hash>, the same
  //     key process-extract will presign a GET for. Bounded upload deadline.
  const putUrl = await presignBlobUrl('put', 'scratch', contentHash, bytes.length)
  const put = await fetch(putUrl, {
    method: 'PUT',
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(SOURCE_UPLOAD_TIMEOUT_MS),
  })
  if (!put.ok) {
    const detail = await Promise.resolve()
      .then(() => put.text())
      .catch(() => '')
    throw new Error(
      `source upload failed (${put.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }

  try {
    // 2 — Drive the orchestrator (JWT attached by supabase-js). It presigns the GET,
    //     mints the Google ID token, and invokes the private container. Bounded so a
    //     stalled container/network falls back to local instead of hanging the import.
    const { data, error } = await withTimeout(
      supabase.functions.invoke('process-extract', { body: { kind, content_hash: contentHash } }),
      EXTRACT_INVOKE_TIMEOUT_MS,
      'process-extract',
    )
    if (error) throw new Error(`process-extract failed: ${error.message ?? String(error)}`)
    const res = data as CloudExtractResponse | null
    if (!res || typeof res.plainText !== 'string') {
      throw new Error('process-extract returned an unexpected response')
    }
    return res
  } finally {
    // 3 — The uploaded source is a TRANSIENT extraction input; reap it (best-effort,
    //     non-blocking) so it doesn't linger in R2. The `scratch/`-prefix R2 lifecycle
    //     rule is the backstop for the rare case this never runs (crash/offline mid-import).
    lastReap = reapSourceBlob(contentHash)
  }
}

/** Best-effort delete of the transient raw-source object from R2 after extraction.
 *  Never throws — a failure just leaves the object for the `scratch/` lifecycle rule. */
async function reapSourceBlob(contentHash: string): Promise<void> {
  try {
    const url = await presignBlobUrl('delete', 'scratch', contentHash)
    await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(SOURCE_REAP_TIMEOUT_MS) })
  } catch {
    // Opportunistic cleanup — swallow (offline, expired URL, R2 hiccup, …).
  }
}

/**
 * Extract an EPUB off-device and map the result back to the local EpubParseResult
 * shape (decode the inline cover). Throws on any failure; callers fall back.
 */
export async function cloudExtractEpub(filePath: string): Promise<EpubParseResult> {
  const res = await cloudExtract(filePath, 'epub')
  // The inline cover is untrusted container output, outside the local zip-inflate
  // caps. Bound it (SEC-4): an over-cap cover is dropped, not honored — the import
  // proceeds cover-less rather than materializing an unbounded buffer. The ext is
  // re-validated authoritatively at the capture-site write (normalizeCoverExt).
  let coverBuffer = res.coverBase64 ? Buffer.from(res.coverBase64, 'base64') : null
  let coverExt = res.coverExt ?? null
  if (coverBuffer && coverBuffer.length > COVER_MAX_BYTES) {
    coverBuffer = null
    coverExt = null
  }
  return {
    title: res.title ?? null,
    author: res.author ?? null,
    coverBuffer,
    coverExt,
    plainText: res.plainText,
    wordCount: res.wordCount ?? null,
  }
}

/**
 * Extract a PDF off-device and map the result back to the local PdfParseResult
 * shape (text + word count only — PDFs carry no title/author/cover on either
 * path). Throws on any failure; callers fall back.
 */
export async function cloudExtractPdf(filePath: string): Promise<PdfParseResult> {
  const res = await cloudExtract(filePath, 'pdf')
  return { plainText: res.plainText, wordCount: res.wordCount ?? null }
}

/**
 * Parse an EPUB for import — off-device when the user opted in and it's available,
 * otherwise in the local sandboxed worker. Cloud is best-effort: any failure falls
 * back to the local worker so an import never blocks on the network.
 */
export async function resolveEpubParse(filePath: string): Promise<EpubParseResult> {
  if (await canCloudProcess()) {
    try {
      const res = await cloudExtractEpub(filePath)
      // A cloud SUCCESS with empty text AND no title is a strong "the container
      // mis-parsed this EPUB" signal (every real EPUB has spine text) — the local
      // worker would likely handle it, so treat it as a soft failure and fall
      // through. (PDFs are NOT retried this way: an empty PDF result is legitimately
      // ambiguous — a scanned/image-only PDF really has no extractable text.)
      if (res.plainText.trim() || res.title) return res
      console.warn(
        '[cloud-processing] cloud returned an empty EPUB result, retrying with local parse',
      )
    } catch (err) {
      console.warn(
        '[cloud-processing] cloud extract failed, falling back to local parse:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }
  return parseEpub(filePath)
}

/**
 * Parse a PDF for import — off-device when the user opted in and it's available,
 * otherwise via the local (shared) pdf.js extractor. Cloud is best-effort: any
 * failure falls back to local so an import never blocks on the network.
 */
export async function resolvePdfParse(filePath: string): Promise<PdfParseResult> {
  if (await canCloudProcess()) {
    try {
      return await cloudExtractPdf(filePath)
    } catch (err) {
      console.warn(
        '[cloud-processing] cloud pdf extract failed, falling back to local parse:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }
  return extractPdf(filePath)
}

/** Test-only: reset the master switch between tests. */
export function __resetForTest(): void {
  enabled = false
  lastReap = Promise.resolve()
}

/** Test-only: await the last fire-and-forget source reap (deterministic assertions). */
export function __whenReapedForTest(): Promise<void> {
  return lastReap
}
