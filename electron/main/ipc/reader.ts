import { ipcMain, app } from 'electron'
import { join, sep, resolve } from 'path'
import { readFile, stat } from 'fs/promises'
import { extractEpubContent } from '../capture/parsers/epub-content'

// ── Security constants ─────────────────────────────────────────────────────
// Hard caps before allocating buffers — prevents zip-bomb / memory exhaustion.
const PDF_MAX_BYTES  = 200 * 1_048_576  // 200 MB
const EPUB_MAX_BYTES = 150 * 1_048_576  // 150 MB

// PDF files must start with the %PDF- magic bytes (0x25 0x50 0x44 0x46 0x2D).
// Checking these blocks masquerading: a malicious file (HTML, JS, etc.)
// renamed to .pdf is rejected before any bytes reach the renderer / pdf.js.
const PDF_MAGIC  = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]) // %PDF-
// EPUB files are ZIP archives and must start with PK\x03\x04.
const EPUB_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])        // PK\x03\x04

export function registerReaderHandlers(): void {

  const contentDir = () => resolve(join(app.getPath('userData'), 'content'))

  function safeFullPath(relativePath: string): string {
    const dir      = contentDir()
    const fullPath = resolve(join(dir, relativePath))
    // Prevent path traversal. Append sep so that a sibling directory whose
    // name starts with "content" (e.g. content_backup) is not matched.
    if (!fullPath.startsWith(dir + sep)) throw new Error('Invalid content path')
    return fullPath
  }

  // Returns HTML/text content as a UTF-8 string (articles).
  ipcMain.handle('reader:loadContent', (_e, relativePath: string) =>
    readFile(safeFullPath(relativePath), 'utf8')
  )

  // Returns the number of chapter files for a multi-chapter item.
  // relativePath must be the first chapter file, e.g. "{uuid}-ch0.html".
  // Returns 1 for single-chapter (legacy) items.
  ipcMain.handle('reader:getChapterCount', async (_e, relativePath: string): Promise<number> => {
    if (!relativePath.match(/-ch\d+\.html$/)) return 1
    const dir = contentDir()
    const base = relativePath.replace(/-ch\d+\.html$/, '')
    let count = 0
    while (true) {
      try {
        await stat(resolve(join(dir, `${base}-ch${count}.html`)))
        count++
      } catch { break }
    }
    return Math.max(count, 1)
  })

  // Returns the HTML of a specific chapter by index.
  // relativePath is the first chapter file path (e.g. "{uuid}-ch0.html").
  // For single-chapter/legacy items (no -ch0 suffix), index is ignored and
  // the full file is returned.
  ipcMain.handle('reader:loadChapter', async (_e, relativePath: string, index: number): Promise<string> => {
    if (!relativePath.match(/-ch\d+\.html$/)) {
      return readFile(safeFullPath(relativePath), 'utf8')
    }
    const base = relativePath.replace(/-ch\d+\.html$/, '')
    return readFile(safeFullPath(`${base}-ch${index}.html`), 'utf8')
  })

  // Returns raw bytes of a PDF after validating size + magic bytes.
  // Validation runs in the main process so the renderer never receives bytes
  // from a file that fails the checks.
  ipcMain.handle('reader:loadBinaryContent', async (_e, relativePath: string) => {
    const fullPath = safeFullPath(relativePath)

    // 1. Stat first — avoids allocating a huge buffer for oversized files.
    const { size } = await stat(fullPath)
    if (size > PDF_MAX_BYTES) {
      throw new Error(
        `File too large (${(size / 1_048_576).toFixed(0)} MB). ` +
        `Maximum allowed size is ${PDF_MAX_BYTES / 1_048_576} MB.`
      )
    }

    const buf = await readFile(fullPath)

    // 2. Magic-byte check — block masquerading attacks where a non-PDF file
    //    is renamed to .pdf.  A valid PDF must begin with the literal %PDF-
    //    sequence at byte offset 0 (PDF/A and PDF/X specs enforce this too).
    if (!PDF_MAGIC.equals(buf.subarray(0, PDF_MAGIC.length))) {
      throw new Error('File is not a valid PDF (missing %PDF- header).')
    }

    return buf
  })

  // Parses an EPUB file and returns structured chapter data.
  // All file I/O and parsing happens here in the main process; the renderer
  // receives only sanitized HTML strings — no file system access needed.
  ipcMain.handle('reader:loadEpub', async (_e, relativePath: string) => {
    const fullPath = safeFullPath(relativePath)

    // 1. Size check before reading the file into memory.
    const { size } = await stat(fullPath)
    if (size > EPUB_MAX_BYTES) {
      throw new Error(
        `File too large (${(size / 1_048_576).toFixed(0)} MB). ` +
        `Maximum allowed size is ${EPUB_MAX_BYTES / 1_048_576} MB.`
      )
    }

    // 2. Magic-byte check — EPUB is a ZIP archive; must start with PK\x03\x04.
    const buf = await readFile(fullPath)
    if (!EPUB_MAGIC.equals(buf.subarray(0, EPUB_MAGIC.length))) {
      throw new Error('File is not a valid EPUB (missing ZIP header).')
    }

    // 3. Parse synchronously — adm-zip operates on the already-loaded buffer
    //    or on the file path directly (we pass fullPath; adm-zip re-reads it).
    return extractEpubContent(fullPath)
  })

}
