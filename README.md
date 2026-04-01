# Personal Library

A local-first desktop app for capturing, organizing, and reading web content — articles, fanfiction, web serials, EPUBs, and PDFs. No account, no backend, no sync. Everything lives on your machine.

---

## Download & Install

Go to the [**Releases page**](https://github.com/Williamdiao48/Personal-Library/releases/latest) and download the file for your platform:

| Platform | File | Notes |
|---|---|---|
| macOS | `Personal Library-x.x.x.dmg` | Apple Silicon |
| Windows | `Personal Library Setup x.x.x.exe` | x64 installer |
| Linux | `personal-library-x.x.x.AppImage` | x64 AppImage |

---

## First Launch — macOS

These builds are unsigned, so macOS Gatekeeper will block the first open.

**Option A — Right-click method:**
1. Open the `.dmg` and drag the app to Applications
2. In Applications, **right-click → Open** (don't double-click)
3. Click **Open** in the dialog that appears
4. After the first launch it opens normally

**Option B — Terminal one-liner:**
```bash
xattr -cr "/Applications/Personal Library.app"
```
Then double-click as normal.

---

## First Launch — Windows

The installer is unsigned, so SmartScreen may show a warning:

1. Run the `.exe` installer
2. If "Windows protected your PC" appears, click **More info**
3. Click **Run anyway**

---

## Features

- **Capture anything** — paste a URL and the app fetches, parses, and stores the content locally. Works offline after capture.
- **Dedicated parsers** for Archive of Our Own, FanFiction.net, Royal Road, Wattpad, Scribble Hub, Spacebattles, Sufficient Velocity — plus a universal parser for everything else
- **Multi-chapter serials** — fetches all chapters in one go with a live progress bar; lazy-loads in the reader
- **Three readers** — HTML (articles + serials), EPUB, PDF; all with keyboard navigation and Cmd+F search
- **Typography controls** — font, size, line height, max width, theme per reader; continuous or paged scroll
- **12 built-in themes** + unlimited custom themes (pick two seed colors, the rest is derived)
- **Library management** — tags, collections, reading status (Unread / Reading / Finished / On Hold / Dropped), bulk operations, author view
- **Full-text search** — FTS5 with partial-word matching as you type
- **Reading stats** — 1-year activity heatmap, streaks, time/count/reading-list goals with progress rings, per-item breakdown with avg WPM
- **Export & import** — `.plbackup` ZIP contains the full database + all content files; import relaunches cleanly

---

## Your Data

All data is stored locally in your system's app data folder — no cloud, no account required.

| Platform | Location |
|---|---|
| macOS | `~/Library/Application Support/Personal Library/` |
| Windows | `%APPDATA%\Personal Library\` |
| Linux | `~/.config/Personal Library/` |

Inside that folder: `library.db` (SQLite database) and `content/` (all captured files as HTML/EPUB/PDF).

**Backup:** Settings → Data → Export Library creates a `.plbackup` file you can import on any machine.

---

---

## Building from Source

**Prerequisites:** Node.js 20+, npm

```bash
npm install        # Also runs electron-rebuild for better-sqlite3
npm run dev        # Dev server with hot reload
npm run build      # Production build → out/
npm run package    # Full build + installer → dist/
npm run typecheck  # Type-check without emitting
```

> If you switch Node or Electron versions, re-run native module rebuild manually:
> `npx electron-rebuild -f -w better-sqlite3`

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    Renderer Process                  │
│   React + TypeScript (HashRouter, Vite dev server)  │
│                                                      │
│   src/components/   →  src/services/                │
│   (UI components)       (IPC abstraction layer)      │
└────────────────────────┬────────────────────────────┘
                         │  contextBridge (window.api)
┌────────────────────────▼────────────────────────────┐
│                    Main Process                      │
│          Node.js + Electron + better-sqlite3         │
│                                                      │
│   electron/main/ipc/   ←→   electron/main/db/       │
│   (IPC handlers)              (SQLite + migrations)  │
│                                                      │
│   electron/main/capture/                            │
│   (URL fetch → parse → sanitize → store)            │
└─────────────────────────────────────────────────────┘
```

The renderer never touches the filesystem or database directly. All data access goes through the `window.api` surface defined in `electron/preload/index.ts` and exposed via Electron's contextBridge.

---

## Directory Structure

```
electron/
  main/
    index.ts          App entry, window creation, IPC registration
    db/
      schema.ts       DDL — all CREATE TABLE / FTS5 / index statements
      index.ts        DB init, versioned migrations (v1–v11), query helpers
    ipc/
      library.ts      Item CRUD, progress, cover, status, refresh
      capture.ts      URL/file ingestion (fire-and-forget, streams progress)
      reader.ts       Load HTML/EPUB/PDF content to renderer
      collections.ts  Collection CRUD + item assignments
      convert.ts      PDF → EPUB conversion
      stats.ts        Reading sessions, summaries, streaks
      goals.ts        Time/count/reading-list goals
      backup.ts       Export/import .plbackup ZIP
    capture/
      index.ts        Orchestrates fetch → parse → sanitize → save → FTS index
      fetch.ts        HTTP fetch with site-specific headers
      sanitizer.ts    sanitize-html rules (NOT dompurify — see Gotchas)
      sites/          Per-site chapter parsers (AO3, FFnet, Royal Road, etc.)
  preload/
    index.ts          contextBridge — the only surface the renderer can touch

src/
  App.tsx             Routes: / | /read/:id | /stats | /settings
  types/index.ts      Shared TS types + full window.api interface declaration
  services/           One module per IPC namespace; components import these only
  components/
    Library/          LibraryView, ItemCard, Sidebar, TagsModal, CollectionsModal
    Reader/           ReaderView, HtmlReader, EpubReader, PdfReader, SearchBar
    Stats/            StatsView (heatmap, streaks, goals, per-item table)
    Settings/         SettingsView, SettingsModal (floating Aa reader panel)
    Capture/          AddItemModal, AppendModal
    Toast/            ToastContainer
  contexts/
    SettingsContext   Reader prefs (font, theme, line-height) + defaultSort
    ToastContext      Global toast notifications
  hooks/
    useReadingSession Track reading time per session for stats
  styles/
    globals.css       Design tokens, themes, app-wide layout
    reader.css        HTML reader typography
    stats.css         Stats page charts and goal cards
```

---

## IPC / Service Layer

Components never call `window.api` directly. They go through `src/services/`:

```
LibraryView → libraryService.getAll()
                    ↓
             window.api.library.getAll()    (preload contextBridge)
                    ↓
             ipcMain.handle('library:getAll', ...)   (main process)
                    ↓
             better-sqlite3 query → returns Item[]
```

This keeps the IPC surface minimal and makes it easy to see exactly what the renderer can and cannot do.

**API namespaces:** `library`, `tags`, `capture`, `reader`, `collections`, `convert`, `stats`, `goals`, `backup`

Capture is the only async-streamed namespace: `capture:start` returns a `jobId` immediately, then the main process emits `capture:progress`, `capture:complete`, or `capture:error` events as it fetches and parses content.

---

## Database

SQLite via `better-sqlite3`. File: `{userData}/library.db`.

Two pragmas are set on every open: `PRAGMA foreign_keys = ON` (enforces all FK constraints) and `PRAGMA journal_mode = WAL` (safer writes, faster concurrent reads).

| Table | Purpose |
|---|---|
| `items` | Content metadata (title, author, type, file path, word count, etc.) |
| `progress` | Per-item reading state (scroll position, max scroll position, chapter, last read, status) |
| `tags` / `item_tags` | User-defined labels (M:N) |
| `collections` / `collection_items` | Curated lists (M:N) |
| `reading_sessions` | Individual reading sessions for stats (start/end/duration) |
| `goals` | Reading goals (type: `time` \| `count` \| `list`) |
| `goal_items` | Items assigned to reading-list goals (M:N) |
| `items_fts` | FTS5 virtual table for full-text search (porter + unicode61 tokenizer) |

**Migrations** are versioned integers in `electron/main/db/index.ts`. Bump `CURRENT_VERSION` and add a SQL string to `MIGRATIONS` to add a new migration. Runs automatically on startup inside a transaction. Current version: **v11**.

**Content files** live in `{userData}/content/` as `{uuid}.html`, `{uuid}.epub`, `{uuid}.pdf`, or `{uuid}-ch0.html … {uuid}-chN.html` for multi-chapter captures.

### PDF ↔ EPUB relationship

When a PDF is converted to EPUB, the new EPUB row has `derived_from = pdf_id`. `library:updateProgress` syncs `scroll_position` and `max_scroll_position` bidirectionally between related items, so reading progress is always consistent regardless of which format you open.

### Reading progress tracking

`progress` stores two position values per item:

- `scroll_position` — current position (used to resume where you left off and display per-book progress bars)
- `max_scroll_position` — high-water mark, the furthest point ever reached (used for stats: words read and avg WPM). Rewinding to re-read an earlier chapter does not deflate this value.

---

## Content Capture Pipeline

URL → `captureUrl()` in `electron/main/capture/index.ts`:

1. **Detect** the site and pick a parser (`sites/ao3.ts`, `sites/royalroad.ts`, … `sites/universal.ts`)
2. **Fetch** pages with appropriate headers
3. **Parse** via `@mozilla/readability` + `jsdom`
4. **Sanitize** via `sanitize-html` (custom allowlist)
5. **Save** to `{userData}/content/{uuid}[-chN].html`
6. **Insert** metadata to SQLite + FTS5 index

Multi-chapter works are saved as individual chapter files and lazy-loaded in the reader (active chapter + prefetch neighbors).

**Supported sites with dedicated parsers:** Archive of Our Own, FanFiction.net, Royal Road, Wattpad, Scribble Hub, XenForo forums (Spacebattles, Sufficient Velocity). Everything else falls through to the universal parser (Readability + next-page link walking).

---

## Readers

| Format | Component | Notes |
|---|---|---|
| HTML (articles) | `HtmlReader` | Single file or multi-chapter; scroll tracking; keyboard nav; Cmd+F search |
| EPUB | `EpubReader` | epub.js; chapter nav; font/spacing controls |
| PDF | `PdfReader` | pdf.js; zoom; page nav; Cmd+F search |

`ReaderView` is the route wrapper that dispatches to the right reader based on `item.content_type`.

Reading sessions are recorded via `useReadingSession` hook — idle detection trims time away from the keyboard, and sessions shorter than 5 s are discarded.

---

## Themes

12 built-in themes + unlimited custom themes. Custom themes are defined by two seed colors (background + accent) and a light/dark flag; all derived CSS variables (`--bg-surface`, `--border`, `--text-muted`, etc.) are computed in `src/utils/themeDerive.ts` and applied as inline CSS properties on `<html>`.

---

## Stats

Reading statistics are computed entirely from the `reading_sessions` table (no separate aggregates stored):

- **Summary cards** — total time, items started/finished, estimated words read (high-water mark), current/longest streak
- **Activity heatmap** — GitHub-style 53-week grid, Monday-anchored, 5 intensity levels, local timezone
- **Goals** — Time goals (progress rings per period), count goals (books finished per period), reading lists with per-item progress bars and inline book search. PDF + derived EPUB treated as one book.
- **Per-item table** — time, sessions, avg WPM, last read, progress bar

Streaks count only days with at least one recorded reading session. Words read is estimated as `word_count × max_scroll_position` per item.

---

## Gotchas

| Issue | Fix |
|---|---|
| `dompurify` throws `ReferenceError: window is not defined` | Use `sanitize-html` instead — it runs fine in Node.js |
| `better-sqlite3` v9 incompatible with Electron 31 | Use v11+ |
| `reader:loadContent` must return `string`, not `Buffer` | `Buffer` is Node-only; unavailable in renderer |
| FTS5 contentless mode | No automatic sync — content must be inserted into `items_fts` manually on capture; no DELETE needed (rows are ghost-indexed) |
| `-webkit-app-region: drag` | Applied to sidebar + header. Every button/input inside must have `-webkit-app-region: no-drag` or clicks won't register |
| `renderer.root` in electron.vite.config | Must be `resolve('.')` (project root); relative `../../index.html` causes Rollup path traversal errors |
| Window shows before content | Use `show: false` + `ready-to-show` event to prevent white flash |
| FK constraints silently ignored | `PRAGMA foreign_keys = ON` must be set after every DB open — SQLite does not persist this setting |
| Search dropdown clipped by parent | Remove `overflow: hidden` from card containers; use `position: absolute` with `top: 100%` (not `bottom: 100%`) for downward-opening dropdowns |

---

## Security Model

- `contextIsolation: true`, `nodeIntegration: false`
- `contextBridge` explicitly whitelists every callable method — renderer cannot call arbitrary Node APIs
- `will-navigate` is blocked for all external URLs (internal HashRouter navigation is exempt)
- `window.open` is blocked
- `library://` custom protocol serves only files within `{userData}/content/` — path traversal is validated
- CSP in `index.html`: `script-src 'self' blob:`, `img-src 'self' data: library:`
- `scroll_position` input clamped to `[0, 1]` with NaN guard before being written to SQLite
- EPUB/HTML content is sanitized through a strict allowlist before storage — `<script>`, `<style>`, `<iframe>`, event handlers, and `class`/`id` attributes are all stripped
- PDF rendered canvas-only via pdf.js with `isEvalSupported: false`, `disableFontFace: true`, `enableXfa: false` — no PDF JavaScript can execute
