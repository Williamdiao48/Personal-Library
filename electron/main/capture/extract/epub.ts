// ─────────────────────────────────────────────────────────────────────────────
// Shared EPUB extraction — the SINGLE source of truth for turning an EPUB file
// into the app's canonical result shape. Consumed by BOTH:
//   • the Electron sandboxed parse worker (workers/parse-worker.ts), and
//   • the Phase 4 cloud-processing container (server/cloud-run/extract), which
//     vendors this module at image-build time.
//
// It reads only a file PATH and returns structured text/metadata. It imports NO
// electron, DB, or network code (its whole dependency closure — parsers/epub*,
// security/validation, adm-zip, jsdom, sanitize-html — is likewise Electron-free),
// so it runs identically in a utilityProcess child or a throwaway container.
// ─────────────────────────────────────────────────────────────────────────────

import { parseEpubMetadata } from '../parsers/epub'
import { extractEpubPlainText } from '../parsers/epub-content'
import type { EpubParseResult } from '../../workers/parse-protocol'

// Re-export the canonical result type so both consumers (worker + container) can
// import the extractor and its output shape from one place. The type itself still
// lives in the dependency-free parse-protocol contract.
export type { EpubParseResult }

function wordCountOf(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * Extract an EPUB into the canonical {@link EpubParseResult}. Metadata always
 * resolves (parseEpubMetadata is internally fault-tolerant); text extraction is
 * best-effort — a failure yields empty text + null word count while still
 * returning the (fault-tolerant) metadata.
 *
 * Text comes from the lean {@link extractEpubPlainText} (spine walk + tag strip),
 * NOT the full render transform: the import only needs text + word count, and the
 * reader re-renders from the stored .epub on open, so paying the render cost
 * (jsdom, base64 image inlining, sanitize) here just to strip it back to text was
 * pure waste.
 */
export function extractEpub(filePath: string): EpubParseResult {
  const meta = parseEpubMetadata(filePath)

  let plainText = ''
  let wordCount: number | null = null
  try {
    plainText = extractEpubPlainText(filePath)
    wordCount = wordCountOf(plainText)
  } catch {
    // text extraction failure is non-fatal
  }

  return {
    title: meta.title,
    author: meta.author,
    coverBuffer: meta.coverBuffer,
    coverExt: meta.coverExt,
    plainText,
    wordCount,
  }
}
