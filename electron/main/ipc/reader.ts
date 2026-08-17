import { ipcMain, BrowserWindow } from 'electron'
import { readFile, stat } from 'fs/promises'
import { extractEpubContent } from '../capture/parsers/epub-content'
import { safeContentPath } from '../security/paths'
import { ensureLocalContent } from '../cloud/downloader'
// Magic-byte + size caps are defined once in security/validation.ts and shared
// with the import path (capture/index.ts) so both gates agree.
import {
  PDF_MAX_BYTES,
  EPUB_MAX_BYTES,
  assertPdfBuffer,
  assertEpubBuffer,
} from '../security/validation'

// Tiny offscreen child window used only to bounce macOS key status away from and
// back to the reader window (see reader:resyncFocus). Lazily created, reused.
let focusHelper: BrowserWindow | null = null

// How long key status rests on the helper window before returning to the reader.
// Must be long enough for the native key-status transition to register (which is
// what re-syncs the text-input context); shorter = less perceptible flicker. Tune
// here if typing ever fails to catch (raise) or the flicker is noticeable (lower).
const RESYNC_KEY_BOUNCE_MS = 30

export function registerReaderHandlers(): void {
  // Path-traversal guard lives in security/paths.ts (safeContentPath).

  // When the PDF reader's search input is focused programmatically on macOS,
  // keydowns reach it but Chromium never syncs the input's text-input state to the
  // OS, so no text is inserted until the window loses and regains key status
  // (observed: Cmd-Tab away and back, or a physical click on the input, both fix
  // it). webContents.focus()/focusOnWebView() are no-ops — they only move
  // first-responder inside the window without the OS-level key-status change that
  // re-queries the macOS text-input context. Calling win.blur()/win.focus() works
  // but visibly deactivates the window (title bar grays). Instead we hand key status
  // to a tiny offscreen transparent CHILD window and take it straight back: the key
  // transition still re-queries the input context, but macOS keeps the parent
  // looking active while its child is key, so there's no visible flicker. The helper
  // is created once, reused, and dies with its parent. PDF reader only.
  ipcMain.handle('reader:resyncFocus', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (!focusHelper || focusHelper.isDestroyed()) {
      focusHelper = new BrowserWindow({
        parent: win,
        show: false,
        width: 1,
        height: 1,
        x: -10000,
        y: -10000,
        frame: false,
        transparent: true,
        hasShadow: false,
        skipTaskbar: true,
        webPreferences: { sandbox: true },
      })
    }
    const helper = focusHelper
    helper.showInactive()
    helper.focus() // steal key from the parent (which keeps its active appearance)
    setTimeout(() => {
      if (!win.isDestroyed()) win.focus() // key returns to the parent → context re-syncs
      if (!helper.isDestroyed()) helper.hide()
    }, RESYNC_KEY_BOUNCE_MS)
  })

  // Returns HTML/text content as a UTF-8 string (articles).
  ipcMain.handle('reader:loadContent', async (_e, relativePath: string) => {
    await ensureLocalContent(relativePath) // pull-on-open if this device lacks the bytes
    return readFile(safeContentPath(relativePath), 'utf8')
  })

  // Returns the number of chapter files for a multi-chapter item.
  // relativePath must be the first chapter file, e.g. "{uuid}-ch0.html".
  // Returns 1 for single-chapter (legacy) items.
  ipcMain.handle('reader:getChapterCount', async (_e, relativePath: string): Promise<number> => {
    if (!relativePath.match(/-ch\d+\.html$/)) return 1
    // Pull the whole item first — one archive restores every chapter file, so the
    // stat loop below sees the full set (not a truncated count) on a fresh device.
    await ensureLocalContent(relativePath)
    const base = relativePath.replace(/-ch\d+\.html$/, '')
    let count = 0
    while (true) {
      try {
        await stat(safeContentPath(`${base}-ch${count}.html`))
        count++
      } catch {
        break
      }
    }
    return Math.max(count, 1)
  })

  // Returns the HTML of a specific chapter by index.
  // relativePath is the first chapter file path (e.g. "{uuid}-ch0.html").
  // For single-chapter/legacy items (no -ch0 suffix), index is ignored and
  // the full file is returned.
  ipcMain.handle(
    'reader:loadChapter',
    async (_e, relativePath: string, index: number): Promise<string> => {
      await ensureLocalContent(relativePath)
      if (!relativePath.match(/-ch\d+\.html$/)) {
        return readFile(safeContentPath(relativePath), 'utf8')
      }
      const base = relativePath.replace(/-ch\d+\.html$/, '')
      return readFile(safeContentPath(`${base}-ch${index}.html`), 'utf8')
    },
  )

  // Returns raw bytes of a PDF after validating size + magic bytes.
  // Validation runs in the main process so the renderer never receives bytes
  // from a file that fails the checks.
  ipcMain.handle('reader:loadBinaryContent', async (_e, relativePath: string) => {
    await ensureLocalContent(relativePath) // pull-on-open if this device lacks the bytes
    const fullPath = safeContentPath(relativePath)

    // 1. Stat first — avoids allocating a huge buffer for oversized files.
    const { size } = await stat(fullPath)
    if (size > PDF_MAX_BYTES) {
      throw new Error(
        `File too large (${(size / 1_048_576).toFixed(0)} MB). ` +
          `Maximum allowed size is ${PDF_MAX_BYTES / 1_048_576} MB.`,
      )
    }

    const buf = await readFile(fullPath)

    // 2. Magic-byte check — block masquerading attacks where a non-PDF file
    //    is renamed to .pdf.  A valid PDF must begin with the literal %PDF-
    //    sequence at byte offset 0 (PDF/A and PDF/X specs enforce this too).
    assertPdfBuffer(buf)

    return buf
  })

  // Parses an EPUB file and returns structured chapter data.
  // All file I/O and parsing happens here in the main process; the renderer
  // receives only sanitized HTML strings — no file system access needed.
  ipcMain.handle('reader:loadEpub', async (_e, relativePath: string) => {
    await ensureLocalContent(relativePath) // pull-on-open if this device lacks the bytes
    const fullPath = safeContentPath(relativePath)

    // 1. Size check before reading the file into memory.
    const { size } = await stat(fullPath)
    if (size > EPUB_MAX_BYTES) {
      throw new Error(
        `File too large (${(size / 1_048_576).toFixed(0)} MB). ` +
          `Maximum allowed size is ${EPUB_MAX_BYTES / 1_048_576} MB.`,
      )
    }

    // 2. Magic-byte check — EPUB is a ZIP archive; must start with PK\x03\x04.
    const buf = await readFile(fullPath)
    assertEpubBuffer(buf)

    // 3. Parse synchronously — adm-zip operates on the already-loaded buffer
    //    or on the file path directly (we pass fullPath; adm-zip re-reads it).
    return extractEpubContent(fullPath)
  })
}
