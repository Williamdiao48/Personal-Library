# `electron/main/security/`

Centralized home for the security fixes tracked in [`security.md`](../../../security.md).
Each finding gets one file; helpers here are the single source of truth so call
sites across the main process route through audited primitives instead of
re-implementing (or omitting) their own checks.

## Roadmap

| Finding | Severity | File | Status |
|---|---|---|---|
| **F1** — arbitrary file deletion via unvalidated `file_path`/`cover_path` | HIGH | `paths.ts` | ✅ implemented |
| **F2** — no decompressed-size cap (EPUB zip bomb) + no import-time gate | MEDIUM | `validation.ts` | ✅ implemented |
| **F3** — `pdf-parse` pdf.js hardening (CVE-2024-4367 class) | MEDIUM | `validation.ts` + `../capture/index.ts` | ✅ implemented¹ |
| **F4** — SSRF via cover / subresource fetch | MEDIUM | `net-guard.ts` | ⬜ stub / roadmap |
| **F5** — `zip.extractAllTo` on untrusted backup (Zip Slip) | MEDIUM | `zip.ts` | ✅ implemented |
| **F6** — capture `BrowserWindow`s lack explicit `webPreferences` | LOW | `../capture/fetch.ts` | ⬜ roadmap |
| **F7** — untrusted parsing runs in the main process | LOW / arch | (new `utilityProcess`) | ⬜ roadmap |
| **F8** — `sandbox: false` on the main window | LOW | `../index.ts` | ⬜ roadmap |
| **F9** — regex-based pre-sanitization HTML rewriting | LOW | `../capture/parsers/` | ⬜ roadmap |
| **F10** — capture URL scheme not validated on direct path | INFO | `../ipc/capture.ts` | ⬜ roadmap |

## Implemented: F1 — `paths.ts`

- `resolveWithin(baseDir, relative)` — pure, Electron-independent core; throws
  `Invalid content path` if `relative` escapes `baseDir`. Unit-tested in
  `paths.test.ts`.
- `contentDir()` — `<userData>/content`.
- `safeContentPath(rel)` — for DB `file_path` (bare filename under `content/`).
- `safeUserDataPath(rel)` — for DB `cover_path` (stored as `content/<file>`,
  relative to `userData`) and the `library://` protocol handler.

Routed through these: `ipc/library.ts`, `db/index.ts`, `capture/index.ts`
(appendChapters), `ipc/reader.ts` (consolidated `safeFullPath`, incl. the
previously-unguarded `getChapterCount`), and `index.ts` (`library://` guard).

## Implemented: P2 (F2 / F3 / F5) — `validation.ts` + `zip.ts`

Theme: validate and bound every untrusted import before it reaches a parser.

- **`validation.ts`** — one home for the magic/size + inflate primitives:
  - `PDF_MAGIC`/`EPUB_MAGIC`/`PDF_MAX_BYTES`/`EPUB_MAX_BYTES` (moved here from
    `reader.ts`, which now imports them, so the read path and import path agree).
  - `assertImportFile(path, kind)` — stat (size cap) + header-byte magic check,
    run at the top of `captureEpub`/`capturePdf` before any parse or copy (the
    import path previously had **no** gate). Buffer variants `assertPdfBuffer` /
    `assertEpubBuffer` back the read-path checks in `reader.ts`.
  - `assertEntryInflateOk(entry)` — rejects a zip entry by its declared
    uncompressed `header.size` and compression ratio **before** decompressing
    (zip-bomb defense). `readEntryTextCapped(zip, name)` wraps get→assert→decode.
- **F2** — every `readAsText`/`getData` in `capture/parsers/epub-content.ts` and
  `epub.ts` routes through the capped helpers; the chapter loop also enforces an
  aggregate total (`ZIP_TOTAL_MAX_BYTES`). Oversized *images* are stripped;
  oversized *chapters* abort the book.
- **F3** — the audited CVE is already patched (bundled pdfjs is 5.4.x ≫ 4.2.67).
  The broken v1-style `require('pdf-parse')` call is replaced with the v2
  `new PDFParse({ … }).getText()` API (which also restores PDF word-count/FTS)
  and hardened with `isEvalSupported:false` / `disableFontFace:true` /
  `enableXfa:false`.
- **`zip.ts` (F5)** — `safeExtractAll(zip, destDir)` replaces
  `zip.extractAllTo` in `ipc/backup.ts`: rejects absolute/backslash names,
  routes every entry through `resolveWithin` (F1 guard) so a `../` entry aborts
  the whole import *before* `closeDb()`/the DB swap, and applies the inflate cap.

¹ F3: the version-level CVE was already mitigated; P2 adds pdf.js sandbox
hardening + fixes the silently-broken extraction call.

## Suggested implementation order for the rest

Remaining: **F4** (SSRF guard, `net-guard.ts`) → **F6 / F8** (Electron
`webPreferences` / `sandbox:true`) → **F9 / F10** (DOM-based pre-sanitize
rewriting; capture-IPC scheme allow-list) → **F7** (move parsing into a
sandboxed `utilityProcess`; largest — greenfield, no existing
`child_process`/`utilityProcess` precedent — do last).
