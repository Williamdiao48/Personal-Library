// PDF plaintext extraction via the app's bundled pdfjs-dist — the SAME engine the
// reader renders with (src/workers/pdf-worker.ts). Replaces pdf-parse (audit
// LEAN-1): the packaged app now ships one copy of pdf.js instead of two and drops
// pdf-parse's heavy @napi-rs/canvas native binary, which text extraction never
// needs (it doesn't rasterize).
//
// pdfjs-dist is ESM-only and exposes no CJS entry for its `legacy` subpath, so it
// can't be `require()`d from the CJS main bundle. It's loaded with a dynamic
// import() instead, which electron-vite preserves as a native ESM import in the
// CJS output (the same mechanism the bundle already uses for better-sqlite3). The
// `legacy` build is the Node-targeted one and needs no DOM globals or canvas for
// text extraction.

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

// Import pdfjs once and reuse it; nothing is paid until the first PDF is parsed,
// so an app session that never opens a PDF never loads the engine.
let pdfjsPromise: Promise<PdfjsModule> | null = null
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjsPromise
}

/**
 * Extract a PDF's readable plaintext from its bytes. Hardened for the F3 threat
 * model — no eval in the pdf.js sandbox, no external font fetching, no XFA form
 * scripting — matching the flags the old pdf-parse call passed.
 *
 * Throws on a corrupt/encrypted PDF or any pdf.js error; callers wrap this and
 * treat failure as non-fatal (null word count / Tier-A metadata embedding), so an
 * image-only or unreadable PDF never aborts capture or a backfill.
 */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false, // no eval() in the pdf.js worker (F3)
    disableFontFace: true, // no external font fetching (F3)
    enableXfa: false, // no XFA form scripting (F3)
    useSystemFonts: false,
    verbosity: 0, // errors only — silence the benign "standardFontDataUrl" notice
  }).promise
  try {
    const parts: string[] = []
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      parts.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '))
    }
    return parts.join(' ')
  } finally {
    await doc.destroy()
  }
}
