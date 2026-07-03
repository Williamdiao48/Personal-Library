# Personal Library — Security Review

> Pre-refactor security audit. Reviewed the full main-process attack surface (EPUB/PDF parsing, HTML capture/sanitization, IPC boundary, filesystem access, custom protocol, auto-update, backup import) and renderer rendering paths.
>
> **Scope note:** This is a local-first, single-user desktop app with no server and no multi-tenant data. That shapes severity throughout — "SSRF" and "stored XSS" mean something different when the attacker's payload arrives as a file *the user chose to import* or a web page *the user chose to capture*, versus an internet-facing service. Severities below are calibrated to this threat model, not a generic web app.

---

## Executive Summary

**Overall: the security fundamentals here are strong and clearly deliberate.** contextIsolation is on, nodeIntegration is off, there's a strict Content-Security-Policy, navigation is locked down, path traversal is blocked on the content-read path, binary files are magic-byte-validated before rendering, and both HTML sanitizers are thoughtfully configured (the EPUB one even reasons about clickjacking via CSS class injection). This is well above the bar for a hobby Electron app.

The findings below are the gaps that remain. The one that matters most is **F1 (arbitrary file deletion via malicious backup import)** — it's the only issue I'd call a genuine vulnerability rather than defense-in-depth hardening. The rest range from real-but-mitigated (zip decompression bombs, PDF parser CVEs) to hardening recommendations worth folding into the upcoming refactor while the code is already being moved around.

### Threat Model — where untrusted data enters

| Entry point | Trust level | Primary risk |
|---|---|---|
| Captured web pages (HTML) | Untrusted, user-initiated | XSS, SSRF via cover/subresource fetch |
| Imported EPUB files | Untrusted, user-initiated | Malicious XHTML/zip → parser attack, zip bomb, XSS |
| Imported PDF files | Untrusted, user-initiated | Malicious PDF → pdf.js/pdf-parse code exec |
| Backup files (`.plbackup`) | Untrusted, user-initiated | **Malicious DB rows → arbitrary file ops; zip-slip on extract** |
| `personallibrary://` protocol URLs | Semi-remote (a website can trigger these) | SSRF, capture-of-attacker-choice |
| Auto-update feed | Remote (GitHub) | Supply-chain (unsigned builds) |

---

## Findings

### F1 — Arbitrary file deletion via unvalidated `file_path` / `cover_path` `unlinkSync` — **HIGH**

**Files:**
- `electron/main/ipc/library.ts:71` (`permanentlyDelete`)
- `electron/main/ipc/library.ts:83–84` (`emptyTrash`)
- `electron/main/db/index.ts:123–124` (30-day startup purge)
- `electron/main/ipc/library.ts:216`, `404` (cover replacement)

Every deletion path takes `file_path` / `cover_path` straight from the `items` table and feeds it to `unlinkSync(join(userData, 'content', row.file_path))` **with no path-traversal check**:

```ts
try { unlinkSync(join(userData, 'content', row.file_path)) } catch {}
if (row.cover_path) { try { unlinkSync(join(userData, row.cover_path)) } catch {} }
```

Normally `file_path` is an app-generated UUID filename, so this is safe. **But the DB is fully attacker-controllable via `backup:import`** — the import replaces `library.db` wholesale after only an `integrity_check` (which validates SQLite structure, not row *values*). A crafted backup can set:

```
file_path  = ../../../../../../Users/<user>/.ssh/id_rsa
cover_path = ../../../../../../Users/<user>/Documents/taxes.pdf
```

Then any permanent-delete, empty-trash, or the **automatic 30-day purge on next launch** will `unlinkSync` those paths — arbitrary file deletion outside `content/`, silently (errors are swallowed). The startup-purge case means the user doesn't even have to take an action; importing the backup and relaunching is enough.

**Mitigation:** Reuse the existing `safeFullPath()` pattern (already implemented in `reader.ts:22`) for *every* filesystem operation that consumes a DB-sourced path. Resolve the absolute path and confirm it stays within `content/ + sep` before unlinking. Centralize this — a single `contentFilePath(relative)` helper that all of library.ts, db/index.ts, and backup.ts call. Consider also validating `file_path`/`cover_path` shape (UUID pattern) at import time and rejecting any row whose paths contain `/` or `..`.

---

### F2 — No decompressed-size cap on EPUB entries (zip bomb) — **MEDIUM**

**Files:** `electron/main/capture/parsers/epub-content.ts:423,431,467` and `epub.ts`; size gate at `electron/main/ipc/reader.ts:99–105`.

The EPUB size check caps the **compressed** file at 150 MB (`reader:loadEpub`), then `extractEpubContent` calls `zip.readAsText(zipPath)` on manifest/spine entries and `entry.getData()` on images. ZIP/DEFLATE routinely hits 1000:1 ratios, so a 150 MB archive can contain a single XHTML entry that decompresses to tens of gigabytes. `readAsText` decompresses the entire entry into memory with **no per-entry limit** — the 5 MB `IMAGE_MAX_BYTES` check happens *after* `getData()` already decompressed the payload. Result: main-process OOM / hang from a single malicious book (denial of service, and on some OSes a hard crash).

Additionally, the import path (`captureEpub` in `capture/index.ts:345`) runs `extractEpubContent` with **no size or magic-byte gate at all** — the 150 MB / ZIP-header check only exists on the later `reader:loadEpub` read path. So the *first* time a malicious EPUB is parsed (at import) is the least protected moment.

**Mitigation:**
- Check `entry.header.size` (the declared uncompressed size) *before* calling `getData()`/`readAsText`, and skip/abort entries above a sane cap (e.g. 25 MB per entry, 250 MB total inflated).
- Also guard against a compression-ratio bomb by comparing `entry.header.compressedSize` vs `size`.
- Apply the magic-byte + size gate at **import time** too, not just read time, so the first parse is protected.

---

### F3 — `pdf-parse` bundles an out-of-date pdf.js (potential RCE from malicious PDF) — **MEDIUM**

**Files:** `electron/main/capture/index.ts:21,419` (`pdfParse` on import); dependency `pdf-parse ^2.4.5`, `pdfjs-dist ^5.4.624`.

PDF text extraction runs `pdf-parse` **in the main process** on raw imported bytes (`capturePdf`). `pdf-parse` vendors its own copy of pdf.js, which historically lags upstream. pdf.js has a track record of parser CVEs — most notably **CVE-2024-4367**, where a malicious PDF could achieve arbitrary JavaScript execution via unchecked font handling (fixed upstream in pdfjs 4.2.67). If the bundled pdfjs inside `pdf-parse` predates that fix, a crafted PDF imported by the user could execute code in the Node main process — the highest-privilege context in the app.

Note the renderer's `PdfReader` uses `pdfjs-dist` 5.x directly (patched), but the **main-process** `pdf-parse` path is the exposed one, and it's the first thing that touches the file (again with no magic-byte gate at import — `capturePdf` copies and parses without the `%PDF-` check that `reader:loadBinaryContent` enforces).

**Mitigation:**
- Audit the actual pdfjs version inside `pdf-parse` (`npm ls` / inspect its bundle). If it predates 4.2.67, replace it: extract text with the already-bundled modern `pdfjs-dist` and set `isEvalSupported: false`, or move extraction off the main process.
- Ensure `isEvalSupported: false` and `disableFontFace`/standard-font-data hardening wherever pdf.js runs.
- Add the magic-byte + size gate at PDF import time.
- Strongly consider running PDF/EPUB parsing in a **utility process or sandboxed worker** rather than the main process (see F7).

---

### F4 — SSRF via cover-image (`og:image`) download and subresource fetch — **MEDIUM (LOW in practice for desktop)**

**Files:** `electron/main/capture/index.ts:449–477` (`downloadCover`); `fetch.ts` fetch helpers.

When capturing a page, the app reads the page's `og:image` meta and fetches whatever absolute URL it finds (`downloadCover`). A malicious page can point that at internal infrastructure:

```
<meta property="og:image" content="http://169.254.169.254/latest/meta-data/iam/...">
<meta property="og:image" content="http://192.168.1.1/admin/reboot">
```

The request *is issued* (blind SSRF); the response is only saved if it looks like an image, but the side effect (hitting a LAN admin endpoint, cloud metadata, `localhost` service) already happened. This is amplified by the **`personallibrary://` protocol handler**, which lets an arbitrary website trigger a capture of a URL of its choosing (`index.ts:29`). The handler validates the scheme is http/https but **not** the destination host, so a web page could induce the app to probe the user's LAN.

Real-world severity on a personal laptop is limited (no cloud metadata endpoint, LAN probing is the main concern), hence LOW in practice — but it's a genuine SSRF primitive.

**Mitigation:**
- Before any capture/cover fetch, resolve the host and reject private/loopback/link-local ranges (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`) and non-http(s) schemes.
- Apply the same allow-check to the capture target itself, especially on the protocol-handler path.
- Cap redirect following and re-validate the host after each redirect (DNS-rebind / redirect-to-internal).

---

### F5 — `zip.extractAllTo` on untrusted backup (Zip Slip) — **MEDIUM**

**File:** `electron/main/ipc/backup.ts:89` (`zip.extractAllTo(tmpDir, true)`).

Backup import extracts a user-selected `.plbackup`/`.zip` with `adm-zip`'s `extractAllTo`. adm-zip has a recurring history of path-traversal ("Zip Slip") advisories where entry names like `../../../foo` escape the target directory. Combined with F1, a malicious backup is the most dangerous single input to this app. Even with a patched adm-zip, relying on the library's internal check for a security boundary is fragile.

**Mitigation:**
- Validate every entry name before extraction: reject absolute paths and any entry whose resolved destination isn't inside `tmpDir + sep`.
- Extract entries explicitly (iterate `getEntries()`, resolve+check each target) rather than trusting `extractAllTo`.
- Keep adm-zip pinned to the latest patched release and add it to your dependency-audit watchlist.

---

### F6 — Hidden capture `BrowserWindow`s created without explicit security prefs — **LOW**

**File:** `electron/main/capture/fetch.ts:39,111` (`new BrowserWindow({ show: false })`).

The Cloudflare-bypass path loads **attacker-controlled URLs** into hidden `BrowserWindow`s with no `webPreferences` specified. On Electron 31 the defaults are safe (contextIsolation on, nodeIntegration off, and windows without a preload are sandboxed), so this is currently OK by inheritance — but it's implicit, and a future Electron upgrade or an accidental preload addition could silently weaken it. These windows execute the remote page's JavaScript (required to solve JS challenges), so they should be maximally locked down.

**Mitigation:** Set prefs explicitly and defensively:
```ts
new BrowserWindow({
  show: false,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    // no preload
  },
})
```
Also consider a dedicated non-persistent `session` partition for these fetches so captured-site cookies don't mingle with app state, and clear it periodically.

---

### F7 — Untrusted parsing runs in the main (highest-privilege) process — **LOW / architectural**

**Files:** `capture/index.ts` (pdf-parse, jsdom, EPUB), `parsers/*`.

EPUB unzip/parse, PDF text extraction, and jsdom HTML parsing all execute in the **main process**, which has full Node/OS access. Any memory-safety or logic bug in `adm-zip`, `pdf-parse`/pdf.js, or `jsdom` on a malicious file is therefore a full-privilege compromise, not a sandboxed one. This is the common thread under F2/F3/F5.

**Mitigation (good candidate for the upcoming refactor):** Move file parsing into an Electron **`utilityProcess`** (or a `child_process` with restricted permissions). It communicates over a message port, has no `ipcMain`/DB/filesystem handles beyond what you pass it, and a crash or exploit there can't directly touch the DB or user files. This single change contains the blast radius of F2, F3, and F5 at once.

*(Positive note: jsdom is used correctly everywhere — no `runScripts`, no `resources:'usable'` — so it neither executes page scripts nor fetches subresources. XXE is not a concern because OPF/NCX parsing uses regex, not an entity-expanding XML parser. Those are the right calls; this finding is only about privilege isolation, not a current jsdom bug.)*

---

### F8 — `sandbox: false` on the main window — **LOW**

**File:** `electron/main/index.ts:87` (`webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false }`).

The main renderer window disables the Chromium sandbox. With contextIsolation on and nodeIntegration off, the renderer itself can't reach Node directly, but `sandbox: false` means the **preload** runs in a full Node context and the renderer process isn't OS-sandboxed — so a renderer RCE (e.g. via a V8/Chromium bug or a sanitizer bypass, see F9) has a shorter path to the system than it would with the sandbox on. The preload here only uses `ipcRenderer`, which works fine under `sandbox: true`.

**Mitigation:** Try flipping to `sandbox: true`. Verify the preload still loads (it should — it only needs `ipcRenderer`/`contextBridge`). This is the single highest-leverage renderer hardening available and pairs naturally with a refactor.

---

### F9 — Sanitizer bypass surface: regex-based HTML rewriting before sanitization — **LOW**

**Files:** `epub-content.ts` — `inlineImages` (308), `rewriteEpubLinks` (366), `stripLeadingTitleElements` (152), `parseManifest`/`parseSpine` (regex over OPF).

Content sanitization is solid (`sanitize-html` with tight allow-lists, `data:`-only images, class/id stripped, colspan clamps). The residual risk is that a lot of **pre-sanitization** manipulation is done with regex against attacker HTML (`<img>` rewriting, `<a>` rewriting, entity decoding, title stripping). Regex HTML handling is historically where mutation-XSS and parser-differential bugs hide — e.g. a malformed tag that the regex mis-parses could smuggle an attribute past the rewriter in a way sanitize-html then normalizes into something live. Today the final `sanitizeHtml` pass is the backstop and it's well-configured, so this is defense-in-depth, not a known break.

**Mitigation:**
- Prefer parsing into a DOM (the code already loads jsdom for other steps) and manipulating nodes, rather than regex over raw markup — do the rewrites on the parsed tree, then serialize, then sanitize.
- Keep `sanitize-html` as the *last* transformation with nothing mutating the string afterward (currently `stripLeadingTitleElements` runs *after* sanitize at line 487 — minor, but any post-sanitize string surgery is a smell; verify it can't re-introduce unsafe markup).
- Add a few malformed-EPUB fixtures (nested/unclosed tags, `<img src=x onerror=...>` variants, `data:text/html` in odd casings) to a test suite.

---

### F10 — Capture URL scheme not validated on the direct/import path — **INFORMATIONAL**

**Files:** `electron/main/ipc/capture.ts:10` (`capture:start`), `capture/index.ts:57`.

`capture:start` passes the URL to `new URL(url)` → `fetchPage(url)` without asserting http/https (unlike the protocol handler, which does validate). Node's `fetch` (undici) rejects `file://`, so direct file exfiltration isn't reachable this way, and the user is the one typing the URL — hence informational. Still, an explicit scheme allow-list at the IPC boundary is cheap and removes ambiguity (and protects against a future fetch backend that *does* support `file:`).

**Mitigation:** Assert `['http:','https:'].includes(new URL(url).protocol)` at the top of `capture:start` and `capture:append`, throwing early otherwise.

---

## What's Already Done Well (keep these through the refactor)

These are correct and worth explicitly preserving as the code moves:

- **Renderer lockdown:** `contextIsolation: true`, `nodeIntegration: false`, explicit `contextBridge` surface — the renderer only sees the narrow `window.api`. (`index.ts`, `preload/index.ts`)
- **Strict CSP** with no `https:`/`ws:` wildcards, `object-src 'none'`, `frame-src 'none'`, `base-uri 'self'`, `form-action 'none'`. (`index.html`)
- **Navigation hardening:** `will-navigate` → `preventDefault()` and `setWindowOpenHandler` → `deny` block PDF/injected-content redirects and popups. (`index.ts:114–122`)
- **Path-traversal defense on content reads** via `safeFullPath()` with the `+ sep` refinement that prevents `content_backup` sibling matches. (`reader.ts:22–29`) — **this is exactly the helper F1 needs applied to the delete paths.**
- **Magic-byte + size validation before rendering** PDFs (`%PDF-`) and EPUBs (`PK\x03\x04`). (`reader.ts`) — just needs extending to import time (F2/F3).
- **Custom `library://` protocol** with its own traversal guard and `X-Content-Type-Options: nosniff`. (`index.ts:138–149`)
- **Two independently-configured sanitizers** with security-aware choices (class/id omitted to prevent CSS clickjacking; `data:`-only images; SVG deliberately excluded; colspan/rowspan clamped against layout-DoS). (`sanitizer.ts`, `epub-content.ts`)
- **jsdom used safely** — no script execution, no subresource loading, anywhere.
- **Parameterized SQL everywhere.** The only string-interpolated query is `user_version = ${v}` where `v` is a loop-counter integer (pragmas can't be bound) — safe. (`db/index.ts:145`)
- **React escapes by default;** `dangerouslySetInnerHTML` is used *only* on already-sanitized content, and note/annotation text renders as escaped children.
- **Backup import validates DB integrity** and extracts to a temp dir before swapping (the boundary just needs F1/F5 hardening on top).

---

## Prioritized Recommendations for the Refactor

Ordered by security value per unit of effort — and all of them are easier to land *during* a restructure than after:

1. **F1 — Centralize a `safeContentPath()` helper and route every filesystem op through it.** This closes the only real vulnerability and eliminates a whole class of future path bugs. Highest priority.
2. **F7 — Move EPUB/PDF/HTML parsing into a `utilityProcess`.** One architectural change that contains F2, F3, and F5. The refactor is the natural moment to introduce a process boundary.
3. **F2 + F3 — Add inflate-size caps and magic-byte/size gates at *import* time**, and audit/replace the `pdf-parse` pdfjs version (or switch to modern `pdfjs-dist` with `isEvalSupported:false`).
4. **F8 — Turn on `sandbox: true`** for the main window and verify the preload.
5. **F5 — Replace `extractAllTo` with per-entry validated extraction;** validate DB row paths at import.
6. **F4 — Add an internal-IP/scheme guard** shared by capture, cover download, and the protocol handler.
7. **F6 / F9 / F10 — Explicit `webPreferences` on capture windows; move pre-sanitize HTML rewriting onto a DOM; scheme allow-list at the capture IPC boundary.**

---

## Supply-Chain & Operational Notes

- **Unsigned / un-notarized builds:** `release.yml` ships with code-signing and notarization commented out. Unsigned apps can be tampered with post-build, and macOS Gatekeeper friction pushes users toward `xattr -d` workarounds that disable protections. Before wider distribution, enable signing + notarization (the secrets scaffolding is already stubbed in the workflow).
- **Auto-update trust:** `electron-updater` pulls from GitHub Releases. Without code signing, the update artifacts aren't cryptographically bound to you — anyone who can serve a matching `latest.yml` (or a compromised release) can push code. Signing closes this. Consider also pinning the update channel and verifying signatures.
- **Dependency audit in CI:** Add `npm audit --production` (or Dependabot/Snyk) to the pipeline and specifically watch `adm-zip`, `pdf-parse`, `jsdom`, and `sanitize-html` — the four libraries that touch untrusted input. A malicious-file parser CVE in any of them is your most likely future exposure.
- **`electron` itself:** keep on a supported major and track Chromium security releases; the renderer's safety leans on Chromium's sandbox and V8 patches.

---

## Quick Reference — Finding → File

| ID | Severity | Location |
|---|---|---|
| F1 | HIGH | `ipc/library.ts:71,83`, `db/index.ts:123` |
| F2 | MEDIUM | `parsers/epub-content.ts:423,467`, `capture/index.ts:345` |
| F3 | MEDIUM | `capture/index.ts:21,419` + `pdf-parse` dep |
| F4 | MEDIUM(→LOW) | `capture/index.ts:449`, `index.ts:29` |
| F5 | MEDIUM | `ipc/backup.ts:89` |
| F6 | LOW | `capture/fetch.ts:39,111` |
| F7 | LOW/arch | `capture/*` (main-process parsing) |
| F8 | LOW | `index.ts:87` |
| F9 | LOW | `parsers/epub-content.ts` (regex rewriting) |
| F10 | INFO | `ipc/capture.ts:10` |
