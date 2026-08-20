import AdmZip from 'adm-zip'
import sanitizeHtml from 'sanitize-html'
import { JSDOM } from 'jsdom'
import {
  readEntryTextCapped,
  assertEntryInflateOk,
  ZIP_TOTAL_MAX_BYTES,
} from '../../security/validation'

export interface EpubChapter {
  title: string
  html: string
  /** True for front/back matter (cover, title page, intro, prologue, appendix, …).
   *  The reader shows these unnumbered; only body chapters get a running number. */
  frontMatter: boolean
}
export interface EpubTocEntry {
  title: string
  /** Index into EpubBook.chapters — the spine file this TOC entry opens. */
  chapterIndex: number
  frontMatter: boolean
}
export interface EpubBook {
  chapters: EpubChapter[]
  /** Logical chapter list from the nav/ncx TOC, in reading order; empty if none. */
  toc: EpubTocEntry[]
}

// ── Constants ──────────────────────────────────────────────────────────────

const IMAGE_MAX_BYTES = 5 * 1_048_576 // skip images larger than 5 MB

// SVG intentionally excluded: SVG data URIs can embed event handlers,
// <foreignObject> HTML, and external resource references. Although Chromium
// sandboxes scripts inside <img src="data:image/svg+xml,...">, excluding SVG
// entirely is zero-cost defence-in-depth (books rarely embed SVG images).
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
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
  return SAFE_IMG_DATA_PREFIXES.some((p) => src.startsWith(p))
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
    'p',
    'br',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'ul',
    'ol',
    'li',
    'dl',
    'dt',
    'dd',
    'strong',
    'em',
    'b',
    'i',
    'u',
    's',
    'del',
    'ins',
    'sup',
    'sub',
    'mark',
    'ruby',
    'rt',
    'rp',
    'blockquote',
    'pre',
    'code',
    'a',
    'img',
    'figure',
    'figcaption',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'div',
    'span',
    'section',
    'article',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'data-epub-chapter', 'data-epub-fragment'],
    img: ['src', 'alt', 'title', 'data-epub-cover'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
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
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&#160;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

/** Normalise a text string for comparison: decode entities, collapse whitespace, lowercase. */
function normaliseText(s: string): string {
  return decodeEntities(s).replace(/\s+/g, ' ').trim().toLowerCase()
}

const TITLE_HEADER_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

/**
 * Many EPUB publishers insert the book title as a running header at the very
 * top of every chapter XHTML file.  Remove leading nodes (a bare text node or a
 * P/DIV/Hn block) whose plain text is exactly the book title, stopping at the
 * first node that is real chapter content.
 *
 * Operates on the parsed DOM *before* sanitization so `sanitize-html` remains
 * the final transformation (F9: no string surgery after the sanitizer runs).
 */
function stripLeadingTitleNodes(body: HTMLElement, bookTitle: string): void {
  if (!bookTitle) return
  const target = normaliseText(bookTitle)

  let node: ChildNode | null = body.firstChild
  while (node) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const text = node.textContent ?? ''
      if (text.trim() === '') {
        node = node.nextSibling
        continue
      } // skip layout whitespace
      if (normaliseText(text) === target) {
        const next = node.nextSibling
        node.remove()
        node = next
        continue
      }
      return // leading text that isn't the title → real content, stop
    }
    if (node.nodeType === 1 /* ELEMENT_NODE */) {
      const el = node as Element
      if (TITLE_HEADER_TAGS.has(el.tagName) && normaliseText(el.textContent ?? '') === target) {
        const next = node.nextSibling
        el.remove()
        node = next
        continue
      }
      return // leading element that isn't a title header → real content, stop
    }
    node = node.nextSibling // comments / other nodes — skip over
  }
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

interface ManifestItem {
  href: string
  mediaType: string
}

function parseManifest(opfContent: string): Map<string, ManifestItem> {
  const map = new Map<string, ManifestItem>()
  const itemRegex = /<item\s[^>]*/gi
  let m: RegExpExecArray | null
  while ((m = itemRegex.exec(opfContent)) !== null) {
    const tag = m[0]
    const id = /\bid="([^"]+)"/.exec(tag)?.[1]
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1]
    const mtype = /\bmedia-type="([^"]+)"/.exec(tag)?.[1] ?? ''
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
    let navText: string | null
    try {
      navText = readEntryTextCapped(zip, navZipPath)
    } catch {
      continue
    }
    if (!navText) continue
    if (!navText.includes('epub:type="toc"') && !navText.includes("epub:type='toc'")) continue

    // Extract <a href="...">Title</a> pairs from the toc nav (double or single quotes)
    const linkRegex = /<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([^<]+)<\/a>/gi
    let lm: RegExpExecArray | null
    while ((lm = linkRegex.exec(navText)) !== null) {
      const fn = filename(lm[1])
      const ttl = lm[2].trim()
      if (fn && ttl) titleMap.set(fn, ttl)
    }
    if (titleMap.size > 0) return titleMap
  }

  // ── EPUB2: toc.ncx ─────────────────────────────────────────
  for (const [, item] of manifest) {
    if (!item.mediaType.includes('ncx')) continue
    const ncxZipPath = resolveZipPath(opfDir, item.href)
    let ncxText: string | null
    try {
      ncxText = readEntryTextCapped(zip, ncxZipPath)
    } catch {
      continue
    }
    if (!ncxText) continue

    // Match <navPoint> blocks: extract content src and navLabel text
    const pointRegex = /<navPoint\b[\s\S]*?<\/navPoint>/gi
    let pm: RegExpExecArray | null
    while ((pm = pointRegex.exec(ncxText)) !== null) {
      const block = pm[0]
      const src = /<content\s[^>]*src="([^"]+)"/.exec(block)?.[1]
      const text = /<navLabel[\s\S]*?<text[^>]*>([^<]+)<\/text>/.exec(block)?.[1]?.trim()
      if (src && text) titleMap.set(filename(src), text)
    }
    if (titleMap.size > 0) return titleMap
  }

  return titleMap
}

/** Strip tags + decode entities + collapse whitespace from a raw TOC label. */
function cleanTitle(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

interface RawTocEntry {
  title: string
  /** Resolved zip path of the spine file this entry targets (fragment dropped). */
  targetPath: string
}

/**
 * Build the ordered logical chapter list from the EPUB's TOC — EPUB3 nav
 * (`epub:type="toc"`) first, then EPUB2 `toc.ncx`. Unlike buildTitleMap
 * (filename→title, order-lossy, one-per-file), this preserves reading order and
 * emits one entry PER TOC item, so a Calibre-split book (many page-sized spine
 * files per chapter, all sharing the book's `<title>`) still lists real chapters
 * rather than page fragments. Hrefs are resolved to spine zip paths; the caller
 * maps each to a chapter index. Fragments are dropped — navigation targets the
 * file, not the intra-file anchor.
 */
function buildToc(zip: AdmZip, opfDir: string, manifest: Map<string, ManifestItem>): RawTocEntry[] {
  // ── EPUB3 nav document ──
  for (const [, item] of manifest) {
    if (!item.mediaType.includes('xhtml')) continue
    const navZipPath = resolveZipPath(opfDir, item.href)
    let navText: string | null
    try {
      navText = readEntryTextCapped(zip, navZipPath)
    } catch {
      continue
    }
    if (!navText) continue
    if (!navText.includes('epub:type="toc"') && !navText.includes("epub:type='toc'")) continue

    const navDir = navZipPath.includes('/')
      ? navZipPath.slice(0, navZipPath.lastIndexOf('/') + 1)
      : ''
    // Scope to the toc <nav> so a landmarks/page-list nav in the same file can't leak in.
    const tocNav =
      /<nav\b[^>]*epub:type=["'][^"']*\btoc\b[^"']*["'][\s\S]*?<\/nav>/i.exec(navText)?.[0] ??
      navText

    const entries: RawTocEntry[] = []
    const linkRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    let lm: RegExpExecArray | null
    while ((lm = linkRe.exec(tocNav)) !== null) {
      const target = resolveZipPath(navDir, lm[1])
      const title = cleanTitle(lm[2])
      if (target && title) entries.push({ title, targetPath: target })
    }
    if (entries.length > 0) return entries
  }

  // ── EPUB2 toc.ncx ──
  for (const [, item] of manifest) {
    if (!item.mediaType.includes('ncx')) continue
    const ncxZipPath = resolveZipPath(opfDir, item.href)
    let ncxText: string | null
    try {
      ncxText = readEntryTextCapped(zip, ncxZipPath)
    } catch {
      continue
    }
    if (!ncxText) continue

    const ncxDir = ncxZipPath.includes('/')
      ? ncxZipPath.slice(0, ncxZipPath.lastIndexOf('/') + 1)
      : ''
    // navLabel texts and content srcs each appear once per navPoint, in document
    // order (nesting preserves order), so the k-th of each pair up — robust to
    // nested navPoints that a per-block regex would drop.
    const labels: string[] = []
    const labelRe = /<navLabel\b[\s\S]*?<text[^>]*>([\s\S]*?)<\/text>/gi
    let lm: RegExpExecArray | null
    while ((lm = labelRe.exec(ncxText)) !== null) labels.push(cleanTitle(lm[1]))

    const srcs: string[] = []
    const srcRe = /<content\b[^>]*\bsrc=["']([^"']+)["']/gi
    let sm: RegExpExecArray | null
    while ((sm = srcRe.exec(ncxText)) !== null) srcs.push(sm[1])

    const entries: RawTocEntry[] = []
    const n = Math.min(labels.length, srcs.length)
    for (let i = 0; i < n; i++) {
      const target = resolveZipPath(ncxDir, srcs[i])
      if (target && labels[i]) entries.push({ title: labels[i], targetPath: target })
    }
    if (entries.length > 0) return entries
  }

  return []
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

// ── Front/back matter classification ─────────────────────────────────────────

// Titles that NAME front/back matter — these render without a chapter number.
// Prefix match: a distinctive leading word, optionally followed by " A" / " I" /
// ":" / a number (e.g. "Appendix B", "Author's Note:").
const MATTER_PREFIX_RE =
  /^(half[\s-]?title|title\s?page|frontispiece|copyright|colophon|imprint|dedication|epigraph|foreword|preface|prologue|prelude|introduction|epilogue|afterword|postscript|acknowledge?ments?|appendix|appendices|glossary|bibliography|discography|filmography|maps? of|list of|about the author|about the publisher|also by|by the same author|other books(?: by)?|coming soon|praise for|permissions|author.?s note|translator.?s note|publisher.?s note)\b/

// Generic single words that are front/back matter ONLY when they are the whole
// title — guards against real chapters like "Notes from Underground" or "The
// Index Case". Allows a trailing colon / dash / period.
const MATTER_EXACT_RE =
  /^(cover|contents|table of contents|notes|endnotes?|footnotes?|index|references?|credits|excerpt|newsletter|dramatis personae|maps?)[\s:.-]*$/

/** Does this chapter title name front/back matter (so it should be unnumbered)? */
function isFrontBackMatterTitle(title: string): boolean {
  const t = normaliseText(title)
  return t.length > 0 && (MATTER_PREFIX_RE.test(t) || MATTER_EXACT_RE.test(t))
}

/** A TOC entry whose label is exactly the book's own title is a title-page entry,
 *  not a chapter — shown unnumbered. (Applied to TOC labels only, never to the
 *  spine, where Calibre-split files all carry the book title as a running head.) */
function isBookTitleLabel(label: string, bookTitle: string): boolean {
  return bookTitle !== '' && normaliseText(label) === normaliseText(bookTitle)
}

/**
 * Find where the book's body matter begins, in OUTPUT-chapter-index space, so
 * every entry before it can be flagged front matter even when its title gives no
 * hint (untitled title pages, "Chapter 1" fallbacks on a copyright page, …).
 *
 * Two structural signals, cheapest first:
 *   • EPUB2 `<guide>`: `<reference type="text" href="…">` marks the start of reading.
 *   • EPUB3 landmarks nav: `<a epub:type="bodymatter" href="…">`.
 *
 * Returns the output index of the first body chapter, or -1 if neither signal is
 * present or resolvable (then classification falls back to titles alone).
 */
function findBodyStartIndex(
  zip: AdmZip,
  opfDir: string,
  opfContent: string,
  manifest: Map<string, ManifestItem>,
  spineHrefToIndex: Map<string, number>,
): number {
  // ── EPUB2 <guide> (lives in the OPF — no extra entry read) ──
  const guideBlock = /<guide\b[\s\S]*?<\/guide>/i.exec(opfContent)?.[0]
  if (guideBlock) {
    const ref =
      /<reference\b[^>]*\btype=["']text["'][^>]*\bhref=["']([^"'#]+)/i.exec(guideBlock)?.[1] ??
      /<reference\b[^>]*\bhref=["']([^"'#]+)["'][^>]*\btype=["']text/i.exec(guideBlock)?.[1]
    if (ref) {
      const idx = spineHrefToIndex.get(resolveZipPath(opfDir, ref))
      if (idx !== undefined) return idx
    }
  }

  // ── EPUB3 landmarks nav ──
  for (const [, item] of manifest) {
    if (!item.mediaType.includes('xhtml')) continue
    const navZipPath = resolveZipPath(opfDir, item.href)
    let navText: string | null
    try {
      navText = readEntryTextCapped(zip, navZipPath)
    } catch {
      continue
    }
    if (!navText || !/epub:type=["'][^"']*landmarks/i.test(navText)) continue

    const navDir = navZipPath.includes('/')
      ? navZipPath.slice(0, navZipPath.lastIndexOf('/') + 1)
      : ''
    // The bodymatter landmark link (attribute order varies).
    const href =
      /<a\b[^>]*epub:type=["'][^"']*bodymatter[^"']*["'][^>]*href=["']([^"'#]+)/i.exec(
        navText,
      )?.[1] ??
      /<a\b[^>]*href=["']([^"'#]+)["'][^>]*epub:type=["'][^"']*bodymatter/i.exec(navText)?.[1]
    if (href) {
      const idx = spineHrefToIndex.get(resolveZipPath(navDir, href))
      if (idx !== undefined) return idx
    }
  }

  return -1
}

// ── Image inlining ─────────────────────────────────────────────────────────

/**
 * Resolve one image reference (a relative/absolute ZIP path or a pre-existing
 * data: URI) to a safe inlined data URI, or `null` if it can't be safely inlined.
 * Shared by <img> and SVG <image> handling. Returning `null` means "drop the
 * source" — the same defence-in-depth failure policy for every rejection reason
 * (unresolvable, decompression bomb, oversized, or unknown/unsafe MIME).
 */
function resolveImageDataUri(src: string, xhtmlDir: string, zip: AdmZip): string | null {
  // Pre-existing data: URI — keep only safe image MIME types; drop
  // data:text/html, data:application/javascript, etc. before the sanitizer.
  if (src.startsWith('data:')) {
    return isSafeImgDataUri(src) ? src : null
  }

  // External/relative URL — attempt to inline from the ZIP. On any failure,
  // return null (never leave an http:// tracking URL or a broken reference).
  const zipPath = resolveZipPath(xhtmlDir, src)
  const entry = zipPath ? zip.getEntry(zipPath) : null
  if (!zipPath || !entry) return null

  // Reject a decompression-bomb image before materializing it.
  try {
    assertEntryInflateOk(entry)
  } catch {
    return null
  }
  const data = entry.getData()
  if (data.length > IMAGE_MAX_BYTES) return null

  const ext = zipPath.split('.').pop()?.toLowerCase() ?? ''
  const mime = MIME_BY_EXT[ext]
  if (!mime) return null

  return `data:${mime};base64,${data.toString('base64')}`
}

/**
 * Inline every <img> reference as a base64 data URI, editing nodes on the parsed
 * DOM (no regex over raw markup). Unresolvable, oversized, or unsafe sources have
 * their `src` removed rather than the whole book aborting.
 */
function inlineImageNodes(doc: Document, xhtmlDir: string, zip: AdmZip): void {
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src')
    if (src === null) continue
    const dataUri = resolveImageDataUri(src, xhtmlDir, zip)
    if (dataUri === null) img.removeAttribute('src')
    else img.setAttribute('src', dataUri)
  }
}

const XLINK_NS = 'http://www.w3.org/1999/xlink'

/** Read an SVG <image> reference from any of the href spellings it may use. */
function svgImageHref(el: Element): string | null {
  return (
    el.getAttribute('xlink:href') ?? el.getAttributeNS(XLINK_NS, 'href') ?? el.getAttribute('href')
  )
}

/**
 * Convert SVG <image> elements into plain inlined <img> tags before sanitizing.
 *
 * The common trigger is the Calibre cover-page pattern —
 * `<svg viewBox="…"><image xlink:href="cover.jpeg"/></svg>` — used as the book's
 * first spine page. `sanitize-html` strips <svg>/<image>/xlink:href wholesale, so
 * without this the cover page renders as a blank white page. We extract only the
 * raster reference and emit an <img> (inlined via the same validated path as any
 * other chapter image); no SVG markup ever reaches the renderer, so the SVG
 * exclusion (scripts / <foreignObject> / external refs) stays fully intact.
 *
 * The <img> is left in place inside the <svg>; sanitize-html discards the <svg>
 * wrapper but preserves the allowed <img> child. (markCoverImageNode later tags
 * and hoists it if the page is nothing but this image.)
 */
function inlineSvgImageNodes(doc: Document, xhtmlDir: string, zip: AdmZip): void {
  for (const image of doc.querySelectorAll('image')) {
    const href = svgImageHref(image)
    const dataUri = href ? resolveImageDataUri(href, xhtmlDir, zip) : null

    const img = doc.createElement('img')
    if (dataUri) img.setAttribute('src', dataUri)
    const alt = image.getAttribute('alt')
    if (alt) img.setAttribute('alt', alt)

    image.replaceWith(img)
  }
}

/**
 * Detect a full-page cover/plate page — a chapter whose body is a single image
 * with no real text — and prepare it for full-page display: tag the image
 * `data-epub-cover` (which the sanitizer keeps and the renderer styles to fill
 * the page) and hoist it to a direct child of <body>.
 *
 * The hoist matters: publishers wrap the cover in `<p class="cover">` (plain
 * <img>) or `<svg>` (SVG <image>). A percentage `max-height` only resolves
 * against a parent with a definite height, so nested inside an auto-height <p>
 * the height cap silently does nothing and the image overflows and clips. As a
 * direct child of the fixed-height page it fits correctly. Covers both the
 * SVG-wrapped and plain-<img> cover styles with one rule.
 */
function markCoverImageNode(doc: Document): void {
  const body = doc.body
  const imgs = body.querySelectorAll('img')
  if (imgs.length !== 1) return
  if ((body.textContent ?? '').trim() !== '') return

  const img = imgs[0]
  img.setAttribute('data-epub-cover', '')
  body.replaceChildren(img) // discard now-empty wrappers (<p>, <svg>, …)
}

// ── Container flattening ────────────────────────────────────────────────────

// Generic block wrappers we flatten. Element grouping carries no visual meaning
// here (all EPUB CSS is stripped), so unwrapping these is visually neutral —
// while structurally it lets the renderer's per-block side padding apply on
// every page. Everything else (p, headings, blockquote, pre, lists, table,
// figure, …) is meaningful or has known CSS and is never touched.
const FLATTEN_CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE'])

// Block-level content a phantom wrapper might swallow. Used to tell a structural
// wrapper artifact from an inline link/marker.
const BLOCK_CONTENT_SELECTOR =
  'div,p,section,article,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,pre,table,figure,hr,dl'

// Fixed-point cap: enough for realistic wrapper nesting, bounded so a
// pathological input can't spin.
const MAX_UNWRAP_PASSES = 16

/**
 * A container is "pure" (safe to unwrap) iff it has no direct non-whitespace
 * text of its own — every direct child is an element or layout whitespace. Such
 * a container is a layout wrapper (`<div class="chapter">`, nested
 * `<section><div>`, per-chapter `<section>`s), not content.
 *
 * A container that holds direct text is a div-as-paragraph *leaf* — kept, so the
 * renderer's baseline CSS can give it paragraph spacing (see epub-reader.css).
 */
function isPureContainer(el: Element): boolean {
  if (!FLATTEN_CONTAINER_TAGS.has(el.tagName)) return false
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 /* TEXT_NODE */ && (n.textContent ?? '').trim() !== '') return false
  }
  // Must actually WRAP block-level content. A div/section holding only inline
  // content (a chapter number `<div><b>7</b></div>`, a heading `<div><span>…`)
  // is a paragraph-like block, not a layout wrapper — keep it as its own block
  // rather than dissolving it into an inline run.
  return el.querySelector(BLOCK_CONTENT_SELECTOR) !== null
}

/**
 * A "layout anchor" is a phantom <a> that wraps block content and carries no
 * href. Its usual origin: a self-closing XHTML chapter bookmark `<a id="c07"/>`.
 * jsdom parses chapters as HTML (like the renderer will), where `/>` on an <a>
 * is meaningless — so the anchor is left UNCLOSED and the HTML adoption-agency
 * algorithm reconstructs it around the rest of the chapter, wrapping every
 * paragraph in one spanning <a>. As the sole direct child of the page that <a>
 * swallows the renderer's per-child side padding on all interior columns.
 *
 * Unwrap it: it has no href (a bookmark target, not a link). Real links (with an
 * href) are untouched — and this runs before rewriteLinkNodes, so hrefs are
 * still intact here. Anchors that wrap only inline content don't break the
 * layout, so they're left alone (smaller blast radius). The lost `id` is a
 * non-issue: the sanitizer strips id anyway, and cross-chapter nav targets whole
 * chapters, not intra-chapter ids.
 */
function isLayoutAnchor(el: Element): boolean {
  return (
    el.tagName === 'A' &&
    !el.hasAttribute('href') &&
    el.querySelector(BLOCK_CONTENT_SELECTOR) !== null
  )
}

/** Rename an element to <div>, preserving its children (attributes are dropped —
 *  they'd be stripped by the sanitizer anyway). */
function retagToDiv(el: Element): void {
  const div = el.ownerDocument.createElement('div')
  while (el.firstChild) div.appendChild(el.firstChild)
  el.replaceWith(div)
}

/**
 * Some converters (notably Calibre) author ordinary paragraphs as
 * `<blockquote>` — often deeply nested — using stripped CSS for indentation, not
 * quotation. With the source CSS gone, the renderer's real blockquote styling
 * (grey, italic, left border) would then paint the *entire book* as a quote.
 *
 * Detect that abuse and retag those blockquotes to plain <div> paragraphs (the
 * later container flatten + baseline CSS then space them like any paragraph).
 * Gated conservatively so a book's genuine, occasional quotes keep their styling:
 * fire only on a Calibre class marker, or when blockquotes DOMINATE the chapter's
 * block content (a real document quotes sparingly).
 */
function normalizeBlockquoteParagraphs(body: HTMLElement): void {
  const bqs = Array.from(body.querySelectorAll('blockquote'))
  if (bqs.length === 0) return
  const totalBlocks = body.querySelectorAll(BLOCK_CONTENT_SELECTOR).length
  const hasCalibreMarker = bqs.some((bq) => /calibre/i.test(bq.getAttribute('class') ?? ''))
  const dominant = bqs.length >= 6 && totalBlocks > 0 && bqs.length / totalBlocks >= 0.5
  if (!(hasCalibreMarker && bqs.length >= 3) && !dominant) return
  for (const bq of bqs) retagToDiv(bq)
}

/**
 * Flatten redundant wrappers so the chapter's real block elements become direct
 * children of <body>: pure generic containers (div/section/article) and phantom
 * layout anchors (see isPureContainer / isLayoutAnchor).
 *
 * WHY: the renderer applies side padding to `.epub-page-content > *` (direct
 * children only). A chapter wrapped in a single element is one direct child that
 * spans every column, and CSS multicolumn's default `box-decoration-break:
 * slice` paints that box's horizontal padding on only the first column's left
 * and the last column's right — so every interior page renders flush to the
 * edges. Hoisting the wrapper's children up makes each real block a direct child
 * that gets padded on the page it lands on.
 *
 * Runs before stripLeadingTitleNodes (so a title buried in a wrapper is now
 * reachable) and before the final sanitize (F9: no string surgery after
 * sanitize). Bounded fixed-point so nested wrappers collapse fully.
 */
function unwrapRedundantContainers(body: HTMLElement): void {
  for (let pass = 0; pass < MAX_UNWRAP_PASSES; pass++) {
    // Collect this pass's targets first, then mutate — replaceWith moves the
    // children into the live tree, so a deeper wrapper surfaces on the next pass
    // rather than being visited mid-iteration.
    const targets: Element[] = []
    for (const el of body.querySelectorAll('a, div, section, article')) {
      if (el.tagName === 'A' ? isLayoutAnchor(el) : isPureContainer(el)) targets.push(el)
    }
    if (targets.length === 0) return
    for (const el of targets) el.replaceWith(...el.childNodes)
  }
}

// ── Internal link rewriting ────────────────────────────────────────────────

/**
 * Rewrite EPUB-internal <a href="..."> links into data-epub-* attributes so
 * they survive sanitization and can be intercepted by the renderer at runtime.
 * Node-based — attribute values are escaped by the DOM serializer, so no manual
 * HTML-encoding is needed (and no regex can mis-parse a malformed tag).
 *
 * - Cross-chapter:  href → data-epub-chapter="N" [data-epub-fragment="..."]
 * - Same-chapter:   #anchor → data-epub-fragment="..."
 * - External:       http/https hrefs pass through unchanged
 * - Non-spine:      href stripped, no data attrs (renders as non-clickable text)
 * - No-href anchors (<a id="...">): left untouched (section markers)
 *
 * Security note: pre-existing data-epub-* attributes from the EPUB source are
 * removed before we set ours, so a malicious EPUB can't spoof chapter navigation
 * (the sanitizer allows these attrs to survive our rewrite, so it can't be relied
 * on to strip attacker-supplied values).
 */
function rewriteLinkNodes(
  doc: Document,
  xhtmlDir: string,
  spineHrefToIndex: Map<string, number>,
): void {
  for (const a of doc.querySelectorAll('a')) {
    const href = a.getAttribute('href')
    if (href === null) continue // <a id="..."> section marker — leave untouched

    const hashIdx = href.indexOf('#')
    const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href
    const fragment = hashIdx >= 0 ? href.slice(hashIdx + 1) : ''

    // External links — sanitizer keeps http/https hrefs as-is
    if (/^https?:\/\//i.test(pathPart)) continue

    // Strip href + any pre-existing data-epub-* (spoofing prevention)
    a.removeAttribute('href')
    a.removeAttribute('data-epub-chapter')
    a.removeAttribute('data-epub-fragment')

    if (!pathPart) {
      a.setAttribute('data-epub-fragment', fragment) // pure same-chapter fragment
      continue
    }

    const resolved = resolveZipPath(xhtmlDir, pathPart)
    const chapterIdx = resolved ? spineHrefToIndex.get(resolved) : undefined
    if (chapterIdx === undefined) continue // non-spine dead link — href already stripped

    a.setAttribute('data-epub-chapter', String(chapterIdx))
    if (fragment) a.setAttribute('data-epub-fragment', fragment)
  }
}

// ── Chapter transform (DOM-based, sanitize last) ────────────────────────────

export interface ChapterContext {
  xhtmlDir: string
  zip: AdmZip
  spineHrefToIndex: Map<string, number>
  bookTitle: string
}

/**
 * Turn one untrusted chapter's XHTML into safe, render-ready HTML.
 *
 * The chapter is parsed once with jsdom — the same lenient HTML parsing the
 * renderer will use — and all rewrites happen as node edits, so no regex ever
 * touches raw attacker markup (F9). jsdom is inert here: default options mean no
 * script execution and no subresource loading. `sanitize-html` runs last, with
 * nothing mutating its output afterward.
 */
export function transformChapterHtml(xhtml: string, ctx: ChapterContext): string {
  const dom = new JSDOM(xhtml)
  try {
    const doc = dom.window.document
    inlineImageNodes(doc, ctx.xhtmlDir, ctx.zip)
    inlineSvgImageNodes(doc, ctx.xhtmlDir, ctx.zip)
    markCoverImageNode(doc)
    normalizeBlockquoteParagraphs(doc.body)
    unwrapRedundantContainers(doc.body)
    rewriteLinkNodes(doc, ctx.xhtmlDir, ctx.spineHrefToIndex)
    stripLeadingTitleNodes(doc.body, ctx.bookTitle)
    return sanitizeHtml(doc.body.innerHTML, SANITIZE_OPTIONS)
  } finally {
    dom.window.close()
  }
}

// ── Malformed-TOC skew correction ────────────────────────────────────────────

const CHAPTER_KEY_RE = /\bchapter\s+([\w-]+)/i

/** Comparable key from an ordinal chapter label: "Chapter One" → "one",
 *  "Chapter 12" → "12"; null if the label isn't a "Chapter N" heading. */
function chapterLabelKey(label: string): string | null {
  return CHAPTER_KEY_RE.exec(label)?.[1]?.toLowerCase() ?? null
}

/** Does a chapter's opening text lead with the given "chapter <key>" heading? */
function chapterOpensWith(html: string, key: string): boolean {
  const head = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .toLowerCase()
  return head.includes(`chapter ${key}`)
}

/**
 * Some EPUBs (notably certain Calibre conversions) ship a TOC whose links are
 * uniformly shifted one entry early — every "Chapter N" points at the *previous*
 * section's file. Verified on a real book: 0/15 chapter labels matched their own
 * target, 15/15 matched the NEXT entry's target.
 *
 * Detect that with high confidence by comparing ordinal chapter labels to the
 * actual chapter headings, then realign each entry to the following entry's
 * target (dropping the now-orphaned last one). A correctly authored TOC has its
 * labels matching in place, so this is a strict no-op for it — the gate needs
 * several chapter entries, almost none matching in place, and almost all matching
 * one entry over, or the TOC is returned untouched.
 */
export function realignSkewedToc(toc: EpubTocEntry[], chapters: EpubChapter[]): EpubTocEntry[] {
  let n = 0
  let inPlace = 0
  let shifted = 0
  for (let k = 0; k < toc.length; k++) {
    const key = chapterLabelKey(toc[k].title)
    if (key === null) continue
    n++
    if (chapterOpensWith(chapters[toc[k].chapterIndex]?.html ?? '', key)) inPlace++
    const nextIdx = toc[k + 1]?.chapterIndex
    if (nextIdx !== undefined && chapterOpensWith(chapters[nextIdx]?.html ?? '', key)) shifted++
  }
  const skewed = n >= 3 && inPlace / n < 0.3 && shifted / n > 0.7
  if (!skewed) return toc

  const corrected: EpubTocEntry[] = []
  for (let k = 0; k < toc.length - 1; k++) {
    corrected.push({ ...toc[k], chapterIndex: toc[k + 1].chapterIndex })
  }
  return corrected
}

// ── Main export ────────────────────────────────────────────────────────────

export function extractEpubContent(filePath: string): EpubBook {
  const zip = new AdmZip(filePath)

  // 1. Locate OPF via container.xml
  const containerXml = readEntryTextCapped(zip, 'META-INF/container.xml') ?? ''
  const opfPath = /full-path="([^"]+\.opf)"/i.exec(containerXml)?.[1]
  if (!opfPath) throw new Error('Invalid EPUB: cannot find OPF file in container.xml')

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''

  const opfContent = readEntryTextCapped(zip, opfPath) ?? ''

  // 2. Parse manifest and spine
  const manifest = parseManifest(opfContent)
  const spineHrefs = parseSpine(opfContent, manifest)
  if (spineHrefs.length === 0) throw new Error('EPUB spine is empty — no readable content found.')

  // 3. Book title (used to strip running-header elements from chapter content)
  const bookTitle = extractBookTitle(opfContent)

  // 4. Build title map from nav/ncx
  const titleMap = buildTitleMap(zip, opfDir, manifest)

  // 4b. Build href → output-chapter-index map for internal link rewriting.
  // Mirrors the main loop's continue condition so indices match exactly.
  const spineHrefToIndex = new Map<string, number>()
  let outIdxPre = 0
  for (const href of spineHrefs) {
    // Existence probe only (no decompression) — mirrors the main loop's
    // "skip if missing" so output-chapter indices line up.
    const zp = resolveZipPath(opfDir, href)
    if (zp && zip.getEntry(zp)) spineHrefToIndex.set(zp, outIdxPre++)
  }

  // 4c. Locate where body matter begins (front matter before it is unnumbered).
  const bodyStartIndex = findBodyStartIndex(zip, opfDir, opfContent, manifest, spineHrefToIndex)

  // 5. Extract each chapter
  const chapters: EpubChapter[] = []
  let totalInflated = 0

  for (let i = 0; i < spineHrefs.length; i++) {
    const href = spineHrefs[i]
    const zipPath = resolveZipPath(opfDir, href)
    const xhtmlDir = zipPath.includes('/') ? zipPath.slice(0, zipPath.lastIndexOf('/') + 1) : ''

    const entry = zip.getEntry(zipPath)
    if (!entry) {
      console.warn(`[epub-content] Missing spine entry: ${zipPath} — skipping`)
      continue
    }
    // Cap per-entry and aggregate decompressed size before materializing text.
    // A bomb here throws and aborts the whole EPUB (rejected, not silently skipped).
    assertEntryInflateOk(entry)
    totalInflated += entry.header.size
    if (totalInflated > ZIP_TOTAL_MAX_BYTES) {
      throw new Error('EPUB total decompressed size exceeds the allowed maximum.')
    }
    const xhtml = entry.getData().toString('utf8')

    // Determine chapter title
    const fn = filename(href)
    const title = titleMap.get(fn) ?? extractTitleFromXhtml(xhtml, i)

    // Parse once, rewrite images + internal links on the DOM, strip running-header
    // titles, then sanitize as the final step (see transformChapterHtml / F9).
    const html = transformChapterHtml(xhtml, { xhtmlDir, zip, spineHrefToIndex, bookTitle })

    // Classify: a title that names front/back matter, OR anything before the
    // structural body-matter start, is unnumbered. `chapters.length` is this
    // entry's output index — the same space as bodyStartIndex/spineHrefToIndex.
    const frontMatter =
      isFrontBackMatterTitle(title) || (bodyStartIndex > 0 && chapters.length < bodyStartIndex)

    chapters.push({ title, html, frontMatter })
  }

  if (chapters.length === 0) {
    throw new Error('Could not extract any chapters from this EPUB.')
  }

  // 6. Logical chapter list from the TOC (nav/ncx), mapped to spine chapter
  //    indices. Entries pointing outside the spine are dropped. Empty when the
  //    book has no usable TOC — the reader then falls back to the spine list.
  const toc: EpubTocEntry[] = []
  for (const raw of buildToc(zip, opfDir, manifest)) {
    const chapterIndex = spineHrefToIndex.get(raw.targetPath)
    if (chapterIndex === undefined) continue
    const frontMatter =
      isFrontBackMatterTitle(raw.title) ||
      isBookTitleLabel(raw.title, bookTitle) ||
      (bodyStartIndex > 0 && chapterIndex < bodyStartIndex)
    toc.push({ title: raw.title, chapterIndex, frontMatter })
  }

  // 7. Repair a uniformly one-early TOC (malformed Calibre conversions); no-op
  //    for a correctly authored TOC.
  return { chapters, toc: realignSkewedToc(toc, chapters) }
}

// ── Text-only extraction (import / FTS) ──────────────────────────────────────

/**
 * Reduce one chapter's raw XHTML to plain body text — no DOM, no image inlining,
 * no sanitize. Isolates <body> (dropping the <head>'s <title>/CSS, mirroring the
 * render path, which strips text from body.innerHTML only), removes <script> /
 * <style> blocks wholesale so their contents don't leak into the text, strips the
 * remaining tags, and decodes entities.
 *
 * Regex over raw markup is deliberate here: the output is plain TEXT that is never
 * re-rendered as HTML, so the F9 "no string surgery producing markup" rule does
 * not apply (the render path in transformChapterHtml still sanitizes, DOM-based).
 */
function xhtmlToPlainText(xhtml: string): string {
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(xhtml)?.[1] ?? xhtml
  return decodeEntities(
    body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract an EPUB's readable plain text for the import word count + FTS index.
 *
 * Walks the spine with the SAME security caps as {@link extractEpubContent}
 * (per-entry inflate guard + aggregate {@link ZIP_TOTAL_MAX_BYTES}) but skips the
 * expensive render machinery — jsdom parse, base64 image inlining, link rewriting,
 * and the sanitize-html pass — none of which affect the plain text. The import
 * path only needs text/word-count (the reader re-renders from the stored .epub on
 * open), so paying the render cost here just to strip it back to text is pure
 * waste. Throws on an invalid EPUB, exactly like extractEpubContent; the caller
 * ({@link extractEpub}) treats a throw as empty text + null word count.
 *
 * NOTE: unlike the render path this does NOT strip publisher running-header title
 * nodes (stripLeadingTitleNodes), so a repeated chapter-header book title stays in
 * the indexed text — harmless for search (the title is already indexed) and it
 * slightly raises the word count. Replicating node-based header stripping in a
 * text-only path isn't worth the cost.
 */
export function extractEpubPlainText(filePath: string): string {
  const zip = new AdmZip(filePath)

  const containerXml = readEntryTextCapped(zip, 'META-INF/container.xml') ?? ''
  const opfPath = /full-path="([^"]+\.opf)"/i.exec(containerXml)?.[1]
  if (!opfPath) throw new Error('Invalid EPUB: cannot find OPF file in container.xml')

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const opfContent = readEntryTextCapped(zip, opfPath) ?? ''

  const manifest = parseManifest(opfContent)
  const spineHrefs = parseSpine(opfContent, manifest)
  if (spineHrefs.length === 0) throw new Error('EPUB spine is empty — no readable content found.')

  const parts: string[] = []
  let totalInflated = 0
  for (const href of spineHrefs) {
    const zipPath = resolveZipPath(opfDir, href)
    const entry = zip.getEntry(zipPath)
    if (!entry) {
      console.warn(`[epub-content] Missing spine entry: ${zipPath} — skipping`)
      continue
    }
    // Same bomb guards as the render path: per-entry cap, then aggregate cap.
    assertEntryInflateOk(entry)
    totalInflated += entry.header.size
    if (totalInflated > ZIP_TOTAL_MAX_BYTES) {
      throw new Error('EPUB total decompressed size exceeds the allowed maximum.')
    }
    const text = xhtmlToPlainText(entry.getData().toString('utf8'))
    if (text) parts.push(text)
  }

  return parts.join(' ')
}
