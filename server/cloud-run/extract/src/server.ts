// Cloud Run entrypoint. A minimal Node HTTP server (no framework — keeps the
// image tiny and the attack surface small) wrapping the extraction handler.
// Cloud Run injects $PORT; the service is deployed --no-allow-unauthenticated
// with --ingress=all (the Edge Function calls in from Supabase, OUTSIDE GCP, so
// internal-only ingress would block it). The ONLY authorized caller is the
// process-extract Edge Function (Chunk 3) presenting a Google-signed ID token —
// this server does no auth of its own; the IAM invoker check is the boundary.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { handleExtract, ExtractError, type ExtractRequest } from './extractHandler'

const PORT = Number(process.env.PORT) || 8080
// The request body is only the small JSON envelope {kind, sourceUrl}; the
// multi-MB source arrives out-of-band from R2, never through here.
const MAX_BODY_BYTES = 64 * 1024

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

export function createExtractServer() {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      return sendJson(res, 200, { ok: true })
    }
    if (req.method !== 'POST' || req.url !== '/extract') {
      return sendJson(res, 404, { error: 'not found' })
    }

    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (c: Buffer) => {
      // Once we've sent the 413 and destroyed the request, ignore any already-
      // buffered chunks — re-entering below would sendJson() a second time and
      // throw ERR_STREAM_WRITE_AFTER_END inside the event handler.
      if (aborted) return
      size += c.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        sendJson(res, 413, { error: 'request body too large' })
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return
      let parsed: ExtractRequest
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ExtractRequest
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' })
      }
      handleExtract(parsed)
        .then((result) => sendJson(res, 200, result))
        .catch((err: unknown) => {
          if (err instanceof ExtractError) return sendJson(res, err.status, { error: err.message })
          console.error('[extract] unexpected error:', err)
          sendJson(res, 500, { error: 'internal error' })
        })
    })
  })
}

// Only listen when run as the entrypoint, not when imported by a test.
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const server = createExtractServer()
  server.requestTimeout = 60_000
  server.headersTimeout = 65_000
  server.listen(PORT, () => console.log(`[extract] listening on :${PORT}`))
}
