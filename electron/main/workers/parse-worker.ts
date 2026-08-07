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

import { extractEpub } from '../capture/extract'
import type { ParseRequest, ParseResponse } from './parse-protocol'

// Log async failures instead of letting them silently exit the process (code 1).
process.on('uncaughtException', (err) => console.error('[parse-worker] uncaughtException:', err))
process.on('unhandledRejection', (err) => console.error('[parse-worker] unhandledRejection:', err))

// The extraction logic itself is the shared, runtime-agnostic capture/extract
// module (also vendored by the Phase 4 cloud container) — this worker is just the
// utilityProcess message envelope around it.
function handle(req: ParseRequest): ParseResponse {
  try {
    return { id: req.id, ok: true, result: extractEpub(req.filePath) }
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
