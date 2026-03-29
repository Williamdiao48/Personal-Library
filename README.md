# Personal Library

A local-first Electron desktop app for capturing, organizing, and reading web content — articles, fanfiction, web serials, EPUBs, and PDFs. No account, no backend, no sync. Everything lives on your machine.

---

## Getting Started

```bash
npm install        # Also runs electron-rebuild for better-sqlite3
npm run dev        # Dev server with hot reload
npm run build      # Production build → out/
npm run package    # Package into distributable → dist/
npm run typecheck  # Type-check without emitting
```

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
      index.ts        DB init, versioned migrations (v1–v10), query helpers
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

| Table | Purpose |
|---|---|
| `items` | Content metadata (title, author, type, file path, word count, etc.) |
| `progress` | Per-item reading state (scroll position, chapter, last read, status) |
| `tags` / `item_tags` | User-defined labels (M:N) |
| `collections` / `collection_items` | Curated lists (M:N) |
| `reading_sessions` | Individual reading sessions for stats (start/end/duration) |
| `goals` | Reading goals (type: `time` \| `count` \| `list`) |
| `goal_items` | Items assigned to reading-list goals (M:N) |
| `items_fts` | FTS5 virtual table for full-text search (porter + unicode61 tokenizer) |

**Migrations** are versioned integers in `electron/main/db/index.ts`. Bump `CURRENT_VERSION` and add a SQL string to `MIGRATIONS` to add a new migration. Runs automatically on startup inside a transaction.

**Content files** live in `{userData}/content/` as `{uuid}.html`, `{uuid}.epub`, `{uuid}.pdf`, or `{uuid}-ch0.html … {uuid}-chN.html` for multi-chapter captures.

### PDF ↔ EPUB relationship

When a PDF is converted to EPUB, the new EPUB row has `derived_from = pdf_id`. `library:updateProgress` syncs `scroll_position` bidirectionally between related items, so reading progress is always consistent regardless of which format you open.

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
| HTML (articles) | `HtmlReader` | Single file or multi-chapter; scroll tracking; keyboard nav |
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

- **Summary cards** — total time, items started/finished, estimated words read, current/longest streak
- **Activity heatmap** — GitHub-style 53-week grid, Monday-anchored, 5 intensity levels
- **Goals** — Time goals (progress rings per period), count goals (books finished per period), reading lists with per-item progress bars
- **Per-item table** — time, sessions, avg WPM, last read, progress bar

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

---

## Security Model

- `contextIsolation: true`, `nodeIntegration: false`
- `contextBridge` explicitly whitelists every callable method — renderer cannot call arbitrary Node APIs
- `will-navigate` is blocked for all external URLs (internal HashRouter navigation is exempt)
- `window.open` is blocked
- `library://` custom protocol serves only files within `{userData}/content/` — path traversal is validated
- CSP in `index.html`: `script-src 'self' blob:`, `img-src 'self' data: library:`
