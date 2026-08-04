import { readFile } from 'node:fs/promises'
import { getSupabase, isConfigured } from '../auth/client'
import { presignBlobUrl } from './presign'
import { sha256Hex } from './blobHash'
import { parseEpub } from '../workers/parse-host'
import { extractPdf, type PdfParseResult } from '../capture/extract'
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
 * Uploads the raw source to the caller's own R2 prefix (content-addressed by the
 * raw bytes' sha256, reusing the Phase-2 `content` presign — so it dedupes against
 * a backup of the same file), invokes `process-extract`, and returns the raw
 * container response. Throws on any failure; the per-kind wrappers map the result
 * and callers fall back to local parsing.
 */
async function cloudExtract(filePath: string, kind: 'epub' | 'pdf'): Promise<CloudExtractResponse> {
  const supabase = getSupabase()
  if (!supabase) throw new Error('cloud not configured')

  // Hashing is not parsing — reading the raw bytes to address + upload them keeps
  // the untrusted content unparsed on this machine (the whole security premise).
  const bytes = await readFile(filePath)
  const contentHash = sha256Hex(bytes)

  // 1 — Upload the raw source so the container can GET it. users/<uid>/content/<hash>,
  //     the same key process-extract will presign a GET for.
  const putUrl = await presignBlobUrl('put', 'content', contentHash, bytes.length)
  const put = await fetch(putUrl, { method: 'PUT', body: new Uint8Array(bytes) })
  if (!put.ok) {
    const detail = await Promise.resolve()
      .then(() => put.text())
      .catch(() => '')
    throw new Error(
      `source upload failed (${put.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }

  // 2 — Drive the orchestrator (JWT attached by supabase-js). It presigns the GET,
  //     mints the Google ID token, and invokes the private container.
  const { data, error } = await supabase.functions.invoke('process-extract', {
    body: { kind, content_hash: contentHash },
  })
  if (error) throw new Error(`process-extract failed: ${error.message ?? String(error)}`)
  const res = data as CloudExtractResponse | null
  if (!res || typeof res.plainText !== 'string') {
    throw new Error('process-extract returned an unexpected response')
  }
  return res
}

/**
 * Extract an EPUB off-device and map the result back to the local EpubParseResult
 * shape (decode the inline cover). Throws on any failure; callers fall back.
 */
export async function cloudExtractEpub(filePath: string): Promise<EpubParseResult> {
  const res = await cloudExtract(filePath, 'epub')
  return {
    title: res.title ?? null,
    author: res.author ?? null,
    coverBuffer: res.coverBase64 ? Buffer.from(res.coverBase64, 'base64') : null,
    coverExt: res.coverExt ?? null,
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
      return await cloudExtractEpub(filePath)
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
}
