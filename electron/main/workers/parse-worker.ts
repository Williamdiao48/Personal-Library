// Sandboxed parse worker (Electron utilityProcess child) — security finding F7.
//
// EPUB unzip/parse (adm-zip) and the sanitize-html pass over untrusted imported
// EPUBs run HERE instead of the main process. A memory-safety or logic bug in
// those libraries — triggered by a malicious file (zip bomb, malformed XHTML) —
// crashes this restartable child, not the app or the DB.
//
// PDF text extraction deliberately stays in main: pdf.js requires DOM globals
// (DOMMatrix, etc.) that a utilityProcess does not provide.
//
// IMPORTANT: this module must never import `electron`, the database, or the
// network/BrowserWindow layer (capture/fetch.ts). It only reads the input file
// it is handed and posts structured results back to the host.

import { parseEpubMetadata } from '../capture/parsers/epub'
import { extractEpubContent } from '../capture/parsers/epub-content'
import type { ParseRequest, ParseResponse, EpubParseResult } from './parse-protocol'

// Log async failures instead of letting them silently exit the process (code 1).
process.on('uncaughtException', (err) => console.error('[parse-worker] uncaughtException:', err))
process.on('unhandledRejection', (err) => console.error('[parse-worker] unhandledRejection:', err))

function wordCountOf(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

// Metadata always resolves (parseEpubMetadata is internally fault-tolerant);
// content extraction is best-effort — a failure yields null word count, matching
// the previous in-main behavior, while still importing the (copied) file.
function handleEpub(filePath: string): EpubParseResult {
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

function handle(req: ParseRequest): ParseResponse {
  try {
    return { id: req.id, ok: true, result: handleEpub(req.filePath) }
  } catch (err) {
    return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const parentPort = process.parentPort
if (!parentPort) {
  // Not running as a utilityProcess child — nothing to do.
  throw new Error('parse-worker must be launched via utilityProcess.fork')
}

parentPort.on('message', (e: { data: ParseRequest }) => {
  parentPort.postMessage(handle(e.data))
})
