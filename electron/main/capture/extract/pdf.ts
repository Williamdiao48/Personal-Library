// ─────────────────────────────────────────────────────────────────────────────
// Shared PDF text extraction — the SINGLE source of truth for turning a PDF file
// into the app's canonical result shape. Consumed by BOTH:
//   • the local import path (capture/index.ts capturePdf, run in the main process
//     — pdf.js text extraction needs no worker, unlike EPUB unzip), and
//   • the Phase 4 cloud-processing container (server/cloud-run/extract), which
//     vendors this module at image-build time.
//
// It reads only a file PATH and returns plaintext + word count. Unlike EPUB there
// is no title/author/cover: the local PDF import derives the title from the
// filename and stores no author/cover, so parity is just { plainText, wordCount }.
//
// The heavy lifting is the bundled, F3-hardened `extractPdfText` (pdfjs-dist
// `legacy` build — pure JS, no DOM globals or canvas for text extraction), so this
// runs identically in the main process and a throwaway container. Best-effort: an
// image-only/encrypted/corrupt PDF yields empty text + null word count rather than
// throwing, mirroring capturePdf's prior in-line behavior exactly.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises'
import { extractPdfText } from '../pdfText'

export interface PdfParseResult {
  plainText: string
  wordCount: number | null
}

/**
 * Extract a PDF into the canonical {@link PdfParseResult}. Text extraction is
 * best-effort — a failure (scanned/encrypted/corrupt PDF) yields empty text and a
 * null word count while never throwing, so an import never aborts on a bad PDF.
 */
export async function extractPdf(filePath: string): Promise<PdfParseResult> {
  const buf = await readFile(filePath)
  // pdfjs-dist (v5) rejects a Node Buffer outright ("provide binary data as
  // Uint8Array, rather than Buffer"), so hand it a plain Uint8Array VIEW over the
  // same bytes — no copy, and no `instanceof Buffer` tripwire.
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)

  let plainText = ''
  let wordCount: number | null = null
  try {
    plainText = await extractPdfText(bytes)
    wordCount = plainText.split(/\s+/).filter(Boolean).length
  } catch {
    // scanned/encrypted/corrupt PDF — non-fatal (null word count)
  }

  return { plainText, wordCount }
}
