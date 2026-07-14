import { readFile } from 'fs/promises'
import { readFileSync } from 'fs'
import { safeContentPath } from '../security/paths'
import { extractEpubContent } from '../capture/parsers/epub-content'
import { extractPdfText as extractPdfBytes } from '../capture/pdfText'

// C1.3 — content → plaintext. Extracts the readable text of a library item so
// C1.4 can build the D8 Tier-B content fingerprint. One branch per content_type,
// reusing the app's existing storage conventions (multi-chapter -ch{N}.html,
// extractEpubContent, the F3-hardened pdfjs-dist text extractor). No embedding here.

/** Minimal item shape this module needs (structurally satisfied by Item). */
export interface EmbeddableItem {
  content_type: 'article' | 'epub' | 'pdf'
  file_path: string
}

/**
 * Below this many chars we treat content as unusable (scanned/encrypted PDF, a
 * stub page, etc.) and the D8 blender (C1.4) falls back to Tier-A metadata alone.
 */
export const MIN_CONTENT_CHARS = 200

/**
 * Strip HTML → text with a lightweight O(n) tag-strip — deliberately NOT jsdom.
 * We only need a bag of words to sample+embed, and a full DOM of a multi-MB
 * item balloons RSS toward ~1 GB (a 2.2 MB fanfic pushed it to 958 MB), which
 * across a backfill aborts the native allocator (observed as SIGTRAP). Stored
 * article/EPUB HTML is already sanitized at capture, so a regex strip is safe.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ') // drop script/style bodies
    .replace(/<[^>]+>/g, ' ') // strip remaining tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

/** Collapse all runs of whitespace to single spaces and trim. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Article text. Multi-chapter items are stored as `{base}-ch{N}.html` (N from 0)
 * — probe siblings upward until one is missing (same convention as
 * reader:getChapterCount). Single/legacy items are one file.
 */
async function extractArticleText(filePath: string): Promise<string> {
  if (/-ch\d+\.html$/.test(filePath)) {
    const base = filePath.replace(/-ch\d+\.html$/, '')
    const parts: string[] = []
    for (let i = 0; ; i++) {
      let html: string
      try {
        html = await readFile(safeContentPath(`${base}-ch${i}.html`), 'utf8')
      } catch {
        break // no more chapters
      }
      parts.push(htmlToText(html))
    }
    return parts.join(' ')
  }
  const html = await readFile(safeContentPath(filePath), 'utf8')
  return htmlToText(html)
}

/** EPUB text: reuse the hardened extractor, concat chapter HTML, strip to text. */
function extractEpubText(filePath: string): string {
  const book = extractEpubContent(safeContentPath(filePath))
  const combined = book.chapters.map((c) => c.html).join(' ')
  return htmlToText(combined)
}

/**
 * PDF text via the same F3-hardened pdfjs-dist extractor capture uses. Non-fatal:
 * a scanned/encrypted/image-only PDF yields no text → return '' so the caller uses
 * Tier A.
 */
async function extractPdfText(filePath: string): Promise<string> {
  try {
    const buffer = readFileSync(safeContentPath(filePath))
    return await extractPdfBytes(buffer)
  } catch {
    return ''
  }
}

/**
 * Extract an item's readable plaintext (collapsed whitespace) for D8 Tier-B
 * embedding. Returns '' when there is no usable content — a scanned PDF, a
 * missing/unreadable file, or a corrupt EPUB (extractEpubContent throws on a bad
 * archive). Extraction failure is non-fatal by design: the item still embeds via
 * Tier-A metadata, and a single bad file never aborts a backfill. Callers gate on
 * {@link MIN_CONTENT_CHARS} via {@link hasUsableContent}.
 */
export async function extractPlainText(item: EmbeddableItem): Promise<string> {
  let raw = ''
  try {
    switch (item.content_type) {
      case 'article':
        raw = await extractArticleText(item.file_path)
        break
      case 'epub':
        raw = extractEpubText(item.file_path)
        break
      case 'pdf':
        raw = await extractPdfText(item.file_path)
        break
    }
  } catch {
    return '' // unreadable/corrupt file → degrade to Tier A
  }
  return collapse(raw)
}

/** True when extracted text is long enough to build a content fingerprint. */
export function hasUsableContent(text: string): boolean {
  return text.length >= MIN_CONTENT_CHARS
}
