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
| **F4** — SSRF via cover / subresource fetch | MEDIUM | `net-guard.ts` | ✅ implemented² |
| **F5** — `zip.extractAllTo` on untrusted backup (Zip Slip) | MEDIUM | `zip.ts` | ✅ implemented |
| **F6** — capture `BrowserWindow`s lack explicit `webPreferences` | LOW | `../capture/fetch.ts` | ✅ implemented |
| **F7** — untrusted parsing runs in the main process | LOW / arch | (new `utilityProcess`) | ⬜ roadmap |
| **F8** — `sandbox: false` on the main window | LOW | `../index.ts` | ✅ implemented |
| **F9** — regex-based pre-sanitization HTML rewriting | LOW | `../capture/parsers/` | ⬜ roadmap |
| **F10** — capture URL scheme not validated on direct path | INFO | `../capture/index.ts` | ✅ implemented |

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

## Implemented: P3 (F4 / F6 / F8 / F10) — `net-guard.ts` + Electron prefs

Theme: lock down the outbound-network and renderer trust boundaries.

- **`net-guard.ts`** — dependency-free (`node:net` + `node:dns` only):
  - `assertHttpUrl(url)` — scheme allow-list (http/https).
  - `isPrivateAddress(ip)` — pure classifier for loopback/private/link-local/ULA/
    multicast + IPv4-mapped IPv6; unit-tested without network.
  - `assertPublicHttpUrl(url)` — scheme + `dns.lookup(all)` → reject if the host
    is, or resolves to, any private/internal address.
  - `safeFetch(url, init)` — validates the host on the URL and re-validates on
    every redirect hop (manual redirect, depth cap).
- **F4 (SSRF)** — the page-controlled `og:image` fetch in `downloadCover`
  (`capture/index.ts`) now goes through `safeFetch`; the website-controlled
  `personallibrary://save?url=…` target is gated with `assertPublicHttpUrl` in
  `handleProtocolUrl` (`index.ts`). The user-*typed* capture target is
  intentionally **not** host-blocked (only scheme-checked) so deliberate
  localhost/LAN capture still works.
- **F10** — `assertHttpUrl` at the top of `dispatchCapture` (`capture/index.ts`),
  the single chokepoint for capture / refresh / append target fetches; errors
  surface through the existing `capture:error` channel.
- **F6** — both hidden capture windows (`capture/fetch.ts`) get an explicit
  hardened `CAPTURE_WINDOW_PREFS` (`sandbox:true`, `contextIsolation:true`,
  `nodeIntegration:false`, no preload). The **default session is kept** on
  purpose — `fetchPagesWithSession` reuses the `cf_clearance` cookies set there.
- **F8** — main window flipped to `sandbox: true` (`index.ts`). Verified safe:
  the preload imports only `contextBridge`/`ipcRenderer`, no Node APIs.

² F4: closes the blind-SSRF vectors; a residual resolve→connect DNS-rebind TOCTOU
window remains (full IP-pinning via a custom undici dispatcher is deferred, LOW
impact). Capture paths that use `BrowserWindow.loadURL` are not host-pre-validated
(Chromium does its own DNS and returns no cross-origin response body).

## Suggested implementation order for the rest

Remaining: **F9** (move pre-sanitize HTML rewriting onto a DOM) and **F7** (move
parsing into a sandboxed `utilityProcess`; largest — greenfield, no existing
`child_process`/`utilityProcess` precedent — do last).
