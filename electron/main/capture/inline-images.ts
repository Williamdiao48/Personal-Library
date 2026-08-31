import { JSDOM } from 'jsdom'
import { safeFetch } from '../security/net-guard'
import {
  BODY_IMAGE_MAX_COUNT,
  BODY_IMAGE_TOTAL_MAX_BYTES,
  COVER_MAX_BYTES,
} from '../security/validation'

// ── Captured-HTML body-image inlining (M1) ──────────────────────────────────
//
// The reader CSP is `img-src 'self' data: library:` — remote images can't load.
// The sanitizer keeps `<img src="https://…">` in captured article/fic bodies, so
// those images render broken. This module downloads them at capture time and
// rewrites the src to a `data:` URI, matching what EPUB already does
// (`parsers/epub-content.ts`) and keeping the reader fully offline.
//
// Every fetch goes through `safeFetch` (private-IP block + per-redirect
// revalidation) because the URLs are page-controlled — the same F4 reasoning the
// cover download documents. A body image on a localhost/LAN-captured page is
// therefore dropped just like a localhost cover is; that's an accepted,
// already-established consequence, not a regression.
//
// Bounds (validation.ts): per-image ≤ COVER_MAX_BYTES, at most
// BODY_IMAGE_MAX_COUNT images, ≤ BODY_IMAGE_TOTAL_MAX_BYTES total. Any image over
// a cap — or that fails to fetch / isn't a permitted image type — has its src
// dropped so the browser renders the `alt` text; capture is never aborted.

const FETCH_TIMEOUT_MS = 6000
const CONCURRENCY = 5

interface FetchedImage {
  bytes: Buffer
  mime: string
}

// SVG is deliberately excluded — a `data:image/svg+xml` payload can carry script,
// and the reader would execute it. epub-content.ts excludes it for the same reason.
function imageMimeFromContentType(ct: string): string | null {
  const lower = ct.toLowerCase()
  if (lower.includes('svg')) return null
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'image/jpeg'
  if (lower.includes('png')) return 'image/png'
  if (lower.includes('gif')) return 'image/gif'
  if (lower.includes('webp')) return 'image/webp'
  if (lower.includes('avif')) return 'image/avif'
  return null
}

async function fetchImage(rawSrc: string, baseUrl: string): Promise<FetchedImage | null> {
  let absoluteUrl: string
  try {
    absoluteUrl = new URL(rawSrc, baseUrl).href
  } catch {
    return null
  }
  // Only real HTTP(S) images are inlinable. Relative paths that don't resolve to
  // http(s), mailto:, etc. can't be fetched — drop them (they'd break anyway).
  if (!/^https?:/i.test(absoluteUrl)) return null

  try {
    const res = await safeFetch(absoluteUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalLibrary/1.0; personal-use)' },
    })
    if (!res.ok) return null

    const mime = imageMimeFromContentType(res.headers.get('content-type') ?? '')
    if (!mime) return null

    // Cheap pre-check on the advertised size before buffering the body. A lying
    // server can still stream more, but this rejects honestly-oversized images
    // without allocating them (same residual downloadCover accepts).
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > COVER_MAX_BYTES) return null

    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0 || bytes.length > COVER_MAX_BYTES) return null

    return { bytes, mime }
  } catch {
    return null
  }
}

/**
 * Rewrite remote `<img>` sources in a captured HTML fragment to inline `data:`
 * URIs. Returns the input string untouched when there is nothing to inline (the
 * common text-only fic case pays no JSDOM round-trip and stays byte-identical).
 */
export async function inlineBodyImages(html: string, baseUrl: string): Promise<string> {
  // Fast path: no images at all → nothing to do, return the original bytes.
  if (!/<img\b/i.test(html)) return html

  const dom = new JSDOM(html)
  const doc = dom.window.document

  // Eligible = has a src that isn't already a data: URI (those are inline and
  // safe-checked by the sanitizer; leave them alone).
  const imgs = Array.from(doc.querySelectorAll('img')).filter((img) => {
    const src = (img.getAttribute('src') ?? '').trim()
    return src.length > 0 && !/^data:/i.test(src)
  })
  if (imgs.length === 0) return html

  let totalBytes = 0
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= imgs.length) return
      const img = imgs[i]
      const src = (img.getAttribute('src') ?? '').trim()

      // Count cap: past the Nth eligible image, don't even fetch — drop the src.
      if (i >= BODY_IMAGE_MAX_COUNT) {
        img.removeAttribute('src')
        continue
      }

      const fetched = await fetchImage(src, baseUrl)
      if (!fetched) {
        img.removeAttribute('src')
        continue
      }

      // Total-bytes cap. The check-and-add is synchronous (no await between), so
      // concurrent workers can't both slip past it.
      if (totalBytes + fetched.bytes.length > BODY_IMAGE_TOTAL_MAX_BYTES) {
        img.removeAttribute('src')
        continue
      }
      totalBytes += fetched.bytes.length
      img.setAttribute('src', `data:${fetched.mime};base64,${fetched.bytes.toString('base64')}`)
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, imgs.length) }, () => worker()))

  return doc.body.innerHTML
}
