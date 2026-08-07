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
import { extractEpubContent } from '../parsers/epub-content'
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
 * resolves (parseEpubMetadata is internally fault-tolerant); content extraction is
 * best-effort — a failure yields empty text + null word count while still
 * returning the (fault-tolerant) metadata. This mirrors the prior in-worker
 * behavior exactly.
 */
export function extractEpub(filePath: string): EpubParseResult {
  const meta = parseEpubMetadata(filePath)

  let plainText = ''
  let wordCount: number | null = null
  try {
    const book = extractEpubContent(filePath)
    plainText = book.chapters
      .map((ch) =>
        ch.html
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .join(' ')
    wordCount = wordCountOf(plainText)
  } catch {
    // content extraction failure is non-fatal
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
