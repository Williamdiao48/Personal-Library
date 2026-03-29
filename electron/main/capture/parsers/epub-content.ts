import AdmZip from 'adm-zip'
import sanitizeHtml from 'sanitize-html'

export interface EpubChapter { title: string; html: string }
export interface EpubBook    { chapters: EpubChapter[] }

// ── Constants ──────────────────────────────────────────────────────────────

const IMAGE_MAX_BYTES = 5 * 1_048_576  // skip images larger than 5 MB

// SVG intentionally excluded: SVG data URIs can embed event handlers,
// <foreignObject> HTML, and external resource references. Although Chromium
// sandboxes scripts inside <img src="data:image/svg+xml,...">, excluding SVG
// entirely is zero-cost defence-in-depth (books rarely embed SVG images).
const MIME_BY_EXT: Record<string, string> = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  gif:  'image/gif',
  webp: 'image/webp',
}

// Permitted data-URI prefixes for inlined images.
// Must match the keys in MIME_BY_EXT; listed explicitly so validation is fast.
const SAFE_IMG_DATA_PREFIXES = [
  'data:image/jpeg',
  'data:image/png',
  'data:image/gif',
  'data:image/webp',
] as const

function isSafeImgDataUri(src: string): boolean {
  return SAFE_IMG_DATA_PREFIXES.some(p => src.startsWith(p))
}

/** Strip the src="…" attribute from an img attribute string. */
function stripSrc(attrs: string): string {
  return attrs.replace(/\bsrc="[^"]*"\s*/g, '')
}

/** Clamp a colspan/rowspan attribute string to [1, 20]. */
function clampSpanAttr(value: string): string {
  const n = parseInt(value, 10)
  return String(Number.isFinite(n) && n >= 1 ? Math.min(n, 20) : 1)
}

// sanitize-html config for EPUB chapters.
// <style> / <script> / <iframe> are not in the allowedTags list so they are
// stripped automatically. All images have already been inlined as data URIs,
// so only the data: scheme is permitted for img.src.
//
// Security notes:
//   class/id  — intentionally OMITTED from allowedAttributes. EPUB stylesheets
//               are stripped, so classes serve no display purpose. However, an
//               attacker could set class="epub-settings-overlay" to trigger our
//               own CSS (position:fixed; inset:0; z-index:99) and clickjack the
//               entire UI. Removing class/id closes that vector entirely.
//
//   colspan / rowspan — clamped to ≤20 via transformTags to prevent table-layout
//               engine hangs from values like colspan=99999.
//
//   img.src   — restricted to data: scheme; transformTags provides a second-layer
//               check that the data URI uses a safe image MIME type.
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins',
    'sup', 'sub', 'mark', 'ruby', 'rt', 'rp',
    'blockquote', 'pre', 'code',
    'a', 'img',
    'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'div', 'span', 'section', 'article',
  ],
  allowedAttributes: {
    a:   ['href', 'title'],
    img: ['src', 'alt', 'title'],
    th:  ['colspan', 'rowspan'],
    td:  ['colspan', 'rowspan'],
    // class and id are intentionally absent — see security note above.
  },
  // Only data: URIs for img (images are inlined before sanitization).
  // http/https only for <a> — will-navigate in Electron main blocks all navigation.
  allowedSchemes: ['data'],
  allowedSchemesByTag: { a: ['http', 'https'], img: ['data'] },
  transformTags: {
    // Second-layer data-URI safety check on <img src>.
    // inlineImages() already validates/strips unsafe data URIs, but this
    // catches anything that bypasses pre-processing (e.g. a pre-existing
    // data:text/html URI that wasn't rewritten by inlineImages).
    img: (_tag: string, attribs: Record<string, string>) => {
      if (attribs.src?.startsWith('data:') && !isSafeImgDataUri(attribs.src)) {
        const { src: _removed, ...safe } = attribs
        return { tagName: 'img', attribs: safe }
      }
      return { tagName: 'img', attribs }
    },
    // Clamp colspan/rowspan so the table-layout engine can't be DoS'd.
    th: (_tag: string, attribs: Record<string, string>) => ({
      tagName: 'th',
      attribs: {
        ...attribs,
        ...(attribs.colspan !== undefined && { colspan: clampSpanAttr(attribs.colspan) }),
        ...(attribs.rowspan !== undefined && { rowspan: clampSpanAttr(attribs.rowspan) }),
      },
    }),
    td: (_tag: string, attribs: Record<string, string>) => ({
      tagName: 'td',
      attribs: {
        ...attribs,
        ...(attribs.colspan !== undefined && { colspan: clampSpanAttr(attribs.colspan) }),
        ...(attribs.rowspan !== undefined && { rowspan: clampSpanAttr(attribs.rowspan) }),
      },
    }),
  },
}

// ── Book-title header stripping ────────────────────────────────────────────

/** Pull the book title out of OPF metadata. */
function extractBookTitle(opfContent: string): string {
  return /<dc:title[^>]*>([^<]+)<\/dc:title>/i.exec(opfContent)?.[1]?.trim() ?? ''
}

/** Decode common HTML entities so text comparisons work even after sanitization. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi,  ' ')
    .replace(/&amp;/gi,   '&')
    .replace(/&lt;/gi,    '<')
    .replace(/&gt;/gi,    '>')
    .replace(/&quot;/gi,  '"')
    .replace(/&apos;/gi,  "'")
    .replace(/&#39;/gi,   "'")
    .replace(/&#160;/gi,  ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

/** Normalise a text string for comparison: decode entities, collapse whitespace, lowercase. */
function normaliseText(s: string): string {
  return decodeEntities(s).replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Many EPUB publishers insert the book title as a running header at the very
 * top of every chapter XHTML file.  Strip any leading content (bare text node
 * or block element) whose plain-text content is exactly the book title.
 */
function stripLeadingTitleElements(html: string, bookTitle: string): string {
  if (!bookTitle) return html
  const target = normaliseText(bookTitle)
  let result = html

  // Case 1: title is a bare text node before the first tag (e.g. calibre cover pages)
  const firstTagIdx = result.indexOf('<')
  if (firstTagIdx > 0) {
    const leadingText = normaliseText(result.slice(0, firstTagIdx))
    if (leadingText === target) result = result.slice(firstTagIdx)
  }

  // Case 2: title is wrapped in a block element
  const blockRe = /^(\s*<(p|div|h[1-6])[^>]*>([\s\S]*?)<\/\2>)/i
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(result)) !== null) {
    const innerText = normaliseText(m[3].replace(/<[^>]+>/g, ''))
    if (innerText === target) {
      result = result.slice(m[0].length)
    } else {
      break
    }
  }
  return result
}

// ── Path utilities ─────────────────────────────────────────────────────────

/** Resolve a relative href against a base directory path within the EPUB zip. */
function resolveZipPath(baseDir: string, relative: string): string {
  // Strip fragment identifier
  const noFrag = relative.split('#')[0]
  if (!noFrag) return ''
  // Absolute path inside ZIP (leading slash removed)
  if (noFrag.startsWith('/')) return noFrag.slice(1)
  const parts = (baseDir + noFrag).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p !== '.') out.push(p)
  }
  return out.join('/')
}

/** Return just the filename part of a path (after last /). */
function filename(path: string): string {
  return path.split('#')[0].split('/').pop() ?? ''
}

// ── OPF parsing ────────────────────────────────────────────────────────────

interface ManifestItem { href: string; mediaType: string }

function parseManifest(opfContent: string): Map<string, ManifestItem> {
  const map = new Map<string, ManifestItem>()
  const itemRegex = /<item\s[^>]*/gi
  let m: RegExpExecArray | null
  while ((m = itemRegex.exec(opfContent)) !== null) {
    const tag = m[0]
    const id       = /\bid="([^"]+)"/.exec(tag)?.[1]
    const href     = /\bhref="([^"]+)"/.exec(tag)?.[1]
    const mtype    = /\bmedia-type="([^"]+)"/.exec(tag)?.[1] ?? ''
    if (id && href) map.set(id, { href, mediaType: mtype })
  }
  return map
}

function parseSpine(opfContent: string, manifest: Map<string, ManifestItem>): string[] {
  const hrefs: string[] = []
  const itemrefRegex = /<itemref\s[^>]*/gi
  let m: RegExpExecArray | null
  while ((m = itemrefRegex.exec(opfContent)) !== null) {
    const idref = /\bidref="([^"]+)"/.exec(m[0])?.[1]
    if (!idref) continue
    const item = manifest.get(idref)
    if (item && (item.mediaType.includes('xhtml') || item.mediaType.includes('html'))) {
      hrefs.push(item.href)
    }
  }
  return hrefs
}

// ── Title extraction ───────────────────────────────────────────────────────

/**
 * Build a map from chapter filename → title string.
 * Tries EPUB3 nav.xhtml first, then EPUB2 toc.ncx.
 */
function buildTitleMap(
  zip: AdmZip,
  opfDir: string,
  manifest: Map<string, ManifestItem>,
): Map<string, string> {
  const titleMap = new Map<string, string>()

  // ── EPUB3: nav document (properties="nav") ──────────────────
  for (const [, item] of manifest) {
    if (!item.mediaType.includes('xhtml')) continue
    const navZipPath = resolveZipPath(opfDir, item.href)
    let navText: string
    try { navText = zip.readAsText(navZipPath) } catch { continue }
    if (!navText.includes('epub:type="toc"') && !navText.includes("epub:type='toc'")) continue

    // Extract <a href="...">Title</a> pairs from the toc nav (double or single quotes)
    const linkRegex = /<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([^<]+)<\/a>/gi
    let lm: RegExpExecArray | null
    while ((lm = linkRegex.exec(navText)) !== null) {
      const fn  = filename(lm[1])
      const ttl = lm[2].trim()
      if (fn && ttl) titleMap.set(fn, ttl)
    }
    if (titleMap.size > 0) return titleMap
  }

  // ── EPUB2: toc.ncx ─────────────────────────────────────────
  for (const [, item] of manifest) {
    if (!item.mediaType.includes('ncx')) continue
    const ncxZipPath = resolveZipPath(opfDir, item.href)
    let ncxText: string
    try { ncxText = zip.readAsText(ncxZipPath) } catch { continue }

    // Match <navPoint> blocks: extract content src and navLabel text
    const pointRegex = /<navPoint\b[\s\S]*?<\/navPoint>/gi
    let pm: RegExpExecArray | null
    while ((pm = pointRegex.exec(ncxText)) !== null) {
      const block = pm[0]
      const src   = /<content\s[^>]*src="([^"]+)"/.exec(block)?.[1]
      const text  = /<navLabel[\s\S]*?<text[^>]*>([^<]+)<\/text>/.exec(block)?.[1]?.trim()
      if (src && text) titleMap.set(filename(src), text)
    }
    if (titleMap.size > 0) return titleMap
  }

  return titleMap
}

/** Extract a title from a single XHTML document as a fallback. */
function extractTitleFromXhtml(xhtml: string, index: number): string {
  // <title> element
  const titleTag = /<title[^>]*>([^<]+)<\/title>/i.exec(xhtml)?.[1]?.trim()
  if (titleTag) return titleTag

  // First h1 or h2 in body
  const heading = /<h[12][^>]*>([^<]*(?:<[^>]+>[^<]*<\/[^>]+>)*[^<]*)<\/h[12]>/i
    .exec(xhtml)?.[1]
    ?.replace(/<[^>]+>/g, '')
    .trim()
  if (heading) return heading

  return `Chapter ${index + 1}`
}

// ── Image inlining ─────────────────────────────────────────────────────────

/** Inline all <img src="..."> references as base64 data URIs. */
function inlineImages(xhtml: string, xhtmlDir: string, zip: AdmZip): string {
  return xhtml.replace(/<img\b([^>]*)>/gi, (tag, attrs: string) => {
    const srcMatch = /\bsrc="([^"]+)"/.exec(attrs)
    if (!srcMatch) return tag

    const srcValue = srcMatch[1]

    // Pre-existing data: URI — pass through only safe image MIME types.
    // data:text/html, data:application/javascript, etc. are stripped here
    // before they ever reach sanitize-html (which provides a second check).
    if (srcValue.startsWith('data:')) {
      return isSafeImgDataUri(srcValue) ? tag : `<img${stripSrc(attrs)}>`
    }

    // External/relative URL — attempt to inline from the ZIP.
    // On any failure, strip the src entirely rather than returning the
    // original tag (which may carry an http:// tracking URL). sanitize-html
    // would also strip non-data schemes, but defence-in-depth is free here.
    const zipPath = resolveZipPath(xhtmlDir, srcValue)
    if (!zipPath) return `<img${stripSrc(attrs)}>`

    const entry = zip.getEntry(zipPath)
    if (!entry) return `<img${stripSrc(attrs)}>`

    const data = entry.getData()
    if (data.length > IMAGE_MAX_BYTES) return `<img${stripSrc(attrs)}>`

    const ext = zipPath.split('.').pop()?.toLowerCase() ?? ''
    const mime = MIME_BY_EXT[ext]
    if (!mime) return `<img${stripSrc(attrs)}>`

    const dataUri = `data:${mime};base64,${data.toString('base64')}`
    const newAttrs = attrs.replace(/\bsrc="[^"]+"/, `src="${dataUri}"`)
    return `<img${newAttrs}>`
  })
}

// ── Main export ────────────────────────────────────────────────────────────

export function extractEpubContent(filePath: string): EpubBook {
  const zip = new AdmZip(filePath)

  // 1. Locate OPF via container.xml
  const containerXml = zip.readAsText('META-INF/container.xml')
  const opfPath = /full-path="([^"]+\.opf)"/i.exec(containerXml)?.[1]
  if (!opfPath) throw new Error('Invalid EPUB: cannot find OPF file in container.xml')

  const opfDir = opfPath.includes('/')
    ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1)
    : ''

  const opfContent = zip.readAsText(opfPath)

  // 2. Parse manifest and spine
  const manifest   = parseManifest(opfContent)
  const spineHrefs = parseSpine(opfContent, manifest)
  if (spineHrefs.length === 0) throw new Error('EPUB spine is empty — no readable content found.')

  // 3. Book title (used to strip running-header elements from chapter content)
  const bookTitle = extractBookTitle(opfContent)

  // 4. Build title map from nav/ncx
  const titleMap = buildTitleMap(zip, opfDir, manifest)

  // 5. Extract each chapter
  const chapters: EpubChapter[] = []

  for (let i = 0; i < spineHrefs.length; i++) {
    const href       = spineHrefs[i]
    const zipPath    = resolveZipPath(opfDir, href)
    const xhtmlDir   = zipPath.includes('/')
      ? zipPath.slice(0, zipPath.lastIndexOf('/') + 1)
      : ''

    let xhtml: string
    try {
      xhtml = zip.readAsText(zipPath)
    } catch {
      console.warn(`[epub-content] Missing spine entry: ${zipPath} — skipping`)
      continue
    }

    // Determine chapter title
    const fn    = filename(href)
    const title = titleMap.get(fn) ?? extractTitleFromXhtml(xhtml, i)

    // Inline images before sanitization (data URIs are in the allowed scheme list)
    const withImages = inlineImages(xhtml, xhtmlDir, zip)

    // Sanitize — strips <style>, <script>, <iframe>, and all non-allow-listed content
    const sanitized = sanitizeHtml(withImages, SANITIZE_OPTIONS)

    // Remove any leading elements that are just the book title (running headers)
    const html = stripLeadingTitleElements(sanitized, bookTitle)

    chapters.push({ title, html })
  }

  if (chapters.length === 0) {
    throw new Error('Could not extract any chapters from this EPUB.')
  }

  return { chapters }
}
