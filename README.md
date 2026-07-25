# Personal Library

A local-first desktop app for capturing, organizing, and reading web content — articles, fanfiction, web serials, EPUBs, and PDFs. No account, no backend, no sync. Everything lives on your machine.

---

## Download & Install

Go to the [**Releases page**](https://github.com/Williamdiao48/Personal-Library/releases/latest) and download the file for your platform:

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon) | `Personal Library-x.x.x-arm64.dmg` | M1/M2/M3/M4 Macs |
| macOS (Intel) | `Personal Library-x.x.x.dmg` | the one *without* `arm64` in the name |
| Windows | `Personal Library Setup x.x.x.exe` | x64 installer |
| Linux | `personal-library-x.x.x.AppImage` | x64 AppImage |

Not sure which Mac you have? Click the Apple menu → **About This Mac** — it lists the chip.

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

## Updating

**Windows & Linux** — the app checks for new releases on launch; download and install from the in-app notification.

**macOS** — because these builds are unsigned, the auto-updater can't run, so updating is manual: download the latest `.dmg` from the [Releases page](https://github.com/Williamdiao48/Personal-Library/releases/latest), then either drag the new app over the old one in Applications (**Replace** when prompted) or drag the old app to the Trash and install the new one. You'll need to repeat the [First Launch — macOS](#first-launch--macos) Gatekeeper step afterward.

**Your library is preserved either way** — all data lives in `~/Library/Application Support/Personal Library/` (see [Your Data](#your-data)), which a reinstall never touches. If you want a safety net first, use Settings → Data → Export Library.

---

## Features

- **Capture anything** — paste a URL and the app fetches, parses, and stores the content locally. Works offline after capture.
- **Dedicated parsers** for Archive of Our Own, FanFiction.net, Royal Road, Wattpad, Scribble Hub, Spacebattles, Sufficient Velocity — plus a universal parser for everything else
- **Multi-chapter serials** — fetches all chapters in one go with a live progress bar; lazy-loads in the reader
- **Three readers** — HTML (articles + serials), EPUB, PDF; all with keyboard navigation and Cmd+F search. PDF adds continuous pinch/wheel zoom (0.5–3×) with cursor anchoring
- **Typography controls** — font, size, line height, max width, theme per reader; continuous or paged scroll
- **15 built-in themes** + unlimited custom themes (pick two seed colors, the rest is derived)
- **Annotations** — highlight any text (multiple colors), attach notes, and drop bookmarks in all three readers, PDF included. Highlights and notes live in a dedicated Annotations panel; bookmarks in a separate Bookmarks panel. Right-click any mark to delete, copy, or edit inline. Manual reordering via up/down buttons. Clicking a note mark opens a popover with the note and quoted passage.
- **Annotation organization** — group highlights into color categories and named themes, browse every mark across your whole library in a cross-book Annotations hub, and export selected quotes to Markdown or plain text
- **Dictionary lookup** — select or double-click a word in any reader to see its definition in an inline popover; fully offline (bundled WordNet)
- **Discover** — on-device recommendations: a local embedding model matches your library's taste against fresh works pulled from AO3, FanFiction.net, and Open Library. No accounts, no tracking; embeddings are computed on your machine and cards you dismiss or already own don't come back
- **Library management** — tags (with rename, recolor, delete, item counts), collections (dedicated shelf with drag-to-reorder), reading status (Unread / Reading / Finished / On Hold / Dropped), bulk operations, author view, inline title editing
- **Trash & recovery** — deleted items move to Trash and can be restored within 30 days; auto-purged on next launch after that
- **Full-text search** — FTS5 with partial-word matching as you type; indexes HTML, EPUB, and PDF content
- **Reading stats** — 1-year activity heatmap, streaks, time/count/reading-list goals with progress rings, per-item breakdown with avg WPM and word count
- **Export & import** — `.plbackup` ZIP contains the full database + all content files; import relaunches cleanly
- **Auto-updater** — on Windows & Linux, checks for new releases on launch; download and install from the in-app notification (macOS updates are manual — see [Updating](#updating))

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

**Uninstalling:** removing the app never deletes this data folder — that's what lets a reinstall keep your library. How you remove the app differs per platform: **macOS** drag the app to the Trash; **Windows** uninstall via *Settings → Apps*; **Linux** delete the `.AppImage` file. In every case the data folder above is left behind, so for a fully clean removal delete it too — but export first (Settings → Data → Export Library) if there's any chance you'll want your library back, since deleting the folder is permanent.

---

## Building from Source

**Prerequisites:** Node.js 20+, npm

```bash
npm install          # postinstall runs electron-rebuild for better-sqlite3
npm run fetch:model  # Download the local embedding model (for Discover) → resources/models
npm run build:dict   # Build the offline dictionary → resources/dictionary
npm run dev          # Dev server with hot reload
npm run build        # Production build → out/
npm run package      # Full build + installer → dist/
npm run typecheck    # Type-check without emitting
npm run lint         # ESLint
npm test             # Vitest (unit + integration)
```

> **Native-module ABI toggle for tests.** `better-sqlite3` is compiled against
> Electron's ABI by default (for `dev`/`build`). Vitest runs under plain Node, so
> the DB/IPC test suites need `npm run rebuild:node` first; switch back with
> `npm run rebuild:electron` before `npm run dev` or a build. Renderer-only tests
> are ABI-agnostic and need no toggle. If you switch Node or Electron versions,
> re-run the matching rebuild script.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    Renderer Process                 │
│   React + TypeScript (HashRouter, Vite dev server)  │
│                                                     │
│   src/components/   →  src/services/                │
│   (UI components)       (IPC abstraction layer)     │
└────────────────────────┬────────────────────────────┘
                         │  contextBridge (window.api)
┌────────────────────────▼────────────────────────────┐
│                    Main Process                     │
│          Node.js + Electron + better-sqlite3        │
│                                                     │
│   electron/main/ipc/   ←→   electron/main/db/       │
│   (IPC handlers)              (SQLite + migrations) │
│                                                     │
│   electron/main/capture/     (fetch → parse → store)│
│   electron/main/recommender/ (Discover engine)      │
│   electron/main/workers/     (embed / parse procs)  │
└─────────────────────────────────────────────────────┘
```

Heavy or untrusted work (HTML parsing, on-device embedding) runs in Electron
`utilityProcess` workers spun up on demand and idle-shut-down, so a hostile page
or a slow model never blocks the main process.

The renderer never touches the filesystem or database directly. All data access goes through the `window.api` surface defined in `electron/preload/index.ts` and exposed via Electron's contextBridge.

---

## Directory Structure

```
electron/
  main/
    index.ts          App entry, window creation, IPC registration
    db/
      schema.ts       v1-baseline DDL — CREATE TABLE / FTS5 / index statements
      index.ts        DB init, versioned migrations (v1–v33), query helpers
      ftsText.ts      FTS5 mirror table + index/query helpers
    ipc/
      library.ts      Item CRUD, progress, cover, status, refresh, soft-delete, trash
      capture.ts      URL/file ingestion (fire-and-forget, streams progress)
      reader.ts       Load HTML/EPUB/PDF content to renderer
      collections.ts  Collection CRUD, item assignments, per-collection item ordering
      annotations.ts  Highlights, notes, bookmarks CRUD + reorder + themes
      convert.ts      PDF → EPUB conversion
      stats.ts        Reading sessions, summaries, streaks
      goals.ts        Time/count/reading-list goals
      backup.ts       Export/import .plbackup ZIP
      discover.ts     Discover recommendations (candidate → embed → rerank)
      dictionary.ts   Offline word definitions (WordNet)
      llm.ts          Optional local LLM rerank (Ollama, if present)
      updater.ts      Auto-update checks (electron-updater)
      log.ts          Crash log writes (error boundary → userData/logs/)
    capture/
      index.ts        Orchestrates fetch → parse → sanitize → save → FTS index
      fetch.ts        HTTP fetch with site-specific headers
      sanitizer.ts    sanitize-html rules (NOT dompurify — see Gotchas)
      sites/          Per-site chapter parsers (ao3, ffnet, royalroad, scribblehub,
                      wattpad, forums, universal)
    recommender/      Discover engine — candidate sources, on-device embeddings,
                      taste modeling, rerank, candidate cache; sources/ (ao3, ffn,
                      openLibrary) + llm/ (llmRerank, ollamaClient)
    workers/          utilityProcess workers + host/protocol wiring:
                      embed-worker (embeddings), parse-worker (HTML parsing)
  preload/
    index.ts          contextBridge — the only surface the renderer can touch

src/
  App.tsx             Routes: / | /read/:id | /stats | /settings | /trash |
                      /tags | /collection/:id | /authors | /discover | /annotations
  types/index.ts      Shared TS types + full window.api interface declaration
  services/           One module per IPC namespace; components import these only
  components/
    Library/          LibraryView, ItemCard, Sidebar, TagsModal/View, CollectionsModal,
                      CollectionView, AddToCollectionModal, TrashView, AuthorsView, ReviewModal
    Reader/           ReaderView, HtmlReader, EpubReader, PdfReader, SearchBar,
                      AnnotationsPanel, BookmarksPanel, AnnotationContextMenu, NotePopover,
                      TextSelectionPopup, DefinitionPopover, ConvertProgress
    Discover/         DiscoverView, RecommendationCard
    Annotations/      AnnotationsView (cross-book hub), AnnotationFilterBar,
                      ThemePicker, ThemeEditor
    Stats/            StatsView (heatmap, streaks, goals, per-item table)
    Settings/         SettingsView, SettingsModal (floating Aa reader panel)
    Capture/          AddItemModal, AppendModal
    Toast/            ToastContainer
    ui/               ColorInput, CustomSelect, MultiSelect, StarRating
    ErrorBoundary.tsx App-level crash boundary (logs to userData/logs/)
  contexts/
    SettingsContext   App-level settings (theme, grid density, sort, custom themes)
    ToastContext      Global toast notifications
    UpdaterContext    Auto-update state + prompts
    CaptureJobsContext  App-level capture-job state + capture:* listeners
  hooks/
    useReadingSession Track reading time per session for stats
    useAnnotations    Annotation CRUD + apply highlights to the DOM
    useTextHighlight  In-reader find/highlight (Cmd+F)
    usePdfSearch      PDF text search
    useGridColumns    Responsive library grid column count
  utils/
    themeDerive.ts    Derive full CSS-var palette from two seed colors
  styles/
    globals.css       Design tokens, themes, app-wide layout
    reader.css        HTML reader typography
    (+ epub-reader.css, stats.css, etc.)
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

**API namespaces:** `library`, `tags`, `capture`, `reader`, `collections`, `annotations`, `annotationThemes`, `convert`, `stats`, `goals`, `backup`, `discover`, `dictionary`, `llm`, `updater`, `log`

Capture is the only async-streamed namespace: `capture:start` returns a `jobId` immediately, then the main process emits `capture:progress`, `capture:complete`, or `capture:error` events as it fetches and parses content.

---

## Database

SQLite via `better-sqlite3`. File: `{userData}/library.db`.

Two pragmas are set on every open: `PRAGMA foreign_keys = ON` (enforces all FK constraints) and `PRAGMA journal_mode = WAL` (safer writes, faster concurrent reads).

| Table | Purpose |
|---|---|
| `items` | Content metadata (title, author, type, file path, word count, `deleted_at` for soft-delete, etc.) |
| `progress` | Per-item reading state (scroll position, max scroll position, chapter, last read, status) |
| `tags` / `item_tags` | User-defined labels (M:N) |
| `collections` / `collection_items` | Curated lists (M:N) |
| `reading_sessions` | Individual reading sessions for stats (start/end/duration) |
| `goals` | Reading goals (type: `time` \| `count` \| `list`) |
| `goal_items` | Items assigned to reading-list goals (M:N) |
| `annotations` | Highlights, notes, and bookmarks per item (type, range, text, note, color, sort_order) |
| `annotation_themes` / `annotation_theme_links` | Named annotation themes and their membership (M:N) |
| `tag_alias` | Canonicalization map for tag/source-tag names |
| `items_fts` | FTS5 virtual table for full-text search (porter + unicode61 tokenizer) |
| `item_fts_index` | Plain mirror of what was indexed into `items_fts` (contentless FTS5 has no delete-by-rowid — see Gotchas) |
| `item_embeddings` | On-device embedding vectors for owned items (taste modeling) |
| `item_source_meta` / `item_source_tags` / `taste_seeds` | Source metadata, source-derived tags, and taste seeds feeding Discover |
| `candidate_cache` / `candidate_embeddings` | Fetched Discover candidate works + their embeddings |
| `discover_cache` / `dismissed_recommendations` | Rendered recommendation feed + per-user dismissals |

**Migrations** are versioned integers in `electron/main/db/index.ts`. Bump `CURRENT_VERSION` and add a SQL string to `MIGRATIONS` to add a new migration. Runs automatically on startup inside a transaction (via `execMigration()`, which tolerates re-applied `ADD COLUMN`s so already-shipped DBs self-heal). Current version: **v33**.

> **`schema.ts` must stay the v1 baseline.** A column a later migration adds via
> `ALTER TABLE ADD COLUMN` must *not* also appear in `schema.ts`, or a fresh install
> crashes with `duplicate column name` (`CREATE TABLE IF NOT EXISTS` never alters an
> existing table). Guarded by `migrations.test.ts`.

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
| PDF | `PdfReader` | pdf.js; continuous zoom 0.5–3× (pinch/ctrl-wheel, cursor-anchored); page nav; Cmd+F search |

`ReaderView` is the route wrapper that dispatches to the right reader based on `item.content_type`.

All three readers support highlights (multiple colors), notes, and bookmarks, plus inline dictionary lookup on any selected word. Reading sessions are recorded via the `useReadingSession` hook — idle detection trims time away from the keyboard, and sessions shorter than 5 s are discarded.

---

## Themes

15 built-in themes + unlimited custom themes. Custom themes are defined by two seed colors (background + accent) and a light/dark flag; all derived CSS variables (`--bg-surface`, `--border`, `--text-muted`, etc.) are computed in `src/utils/themeDerive.ts` and applied as inline CSS properties on `<html>`.

---

## Stats

Reading statistics are computed entirely from the `reading_sessions` table (no separate aggregates stored):

- **Summary cards** — total time, items started/finished, estimated words read (high-water mark), current/longest streak
- **Activity heatmap** — GitHub-style 53-week grid, Monday-anchored, 5 intensity levels, local timezone
- **Goals** — Time goals (progress rings per period), count goals (books finished per period), reading lists with per-item progress bars and inline book search. PDF + derived EPUB treated as one book.
- **Per-item table** — time, sessions, avg WPM, last read, progress bar

Streaks count only days with at least one recorded reading session. Words read is estimated as `word_count × max_scroll_position` per item.

---

## Discover (Recommendations)

The Discover view (`electron/main/recommender/`) suggests new works based on what's
already in your library — entirely on-device.

1. **Taste model** — owned items are embedded with a local sentence-embedding model
   (`@huggingface/transformers` + onnxruntime, bundled under `resources/models/`),
   summarized into a taste vector plus source-derived tags/seeds.
2. **Candidates** — fresh works are fetched from public sources (`sources/`: AO3,
   FanFiction.net, Open Library), cached, and embedded (`candidate_cache` /
   `candidate_embeddings`).
3. **Rerank** — candidates are scored against your taste (cosine similarity + signal
   boosts); an optional local LLM rerank via Ollama is used only if it's running.
4. **Feed** — the ranked feed is cached (`discover_cache`); works you already own or
   have dismissed (`dismissed_recommendations`) are filtered out and don't reappear.

Embedding and HTML parsing run in `utilityProcess` workers (`electron/main/workers/`)
that idle-shut-down after a few minutes. Nothing about your library leaves the machine —
the only outbound requests are the same kind of public page fetches capture already makes.

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
