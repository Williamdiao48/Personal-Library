# Development

This covers building the app and finding your way around the code. For the design reasoning behind the local core and the sync layer, read [ARCHITECTURE.md](../ARCHITECTURE.md). For the test setup, read [testing.md](testing.md).

## Building from source

Requires Node.js 20 or later.

```bash
npm install          # also rebuilds better-sqlite3 for Electron
npm run fetch:model  # downloads the embedding model used by Discover → resources/models
npm run build:dict   # builds the offline dictionary → resources/dictionary
npm run dev          # runs the app with hot reload
npm run build        # production build → out/
npm run package      # build plus installers → dist/
npm run typecheck
npm run lint
npm test             # Vitest, unit and integration
```

`better-sqlite3` is a native module, compiled for Electron by default. Vitest runs under plain Node, so before running the DB and IPC tests you need `npm run rebuild:node`, and before going back to `npm run dev` you need `npm run rebuild:electron`. Renderer tests don't care. [testing.md](testing.md) has the details, including a workaround for Python 3.12+.

## How the pieces fit

The renderer (React) has no access to the filesystem or database. Everything goes through `window.api`, which the preload script exposes with `contextBridge`. Components don't call `window.api` directly either; they call a module in `src/services/`, one per API namespace:

```
LibraryView → libraryService.getAll()
            → window.api.library.getAll()           (preload)
            → ipcMain.handle('library:getAll', …)   (main process)
            → SQLite query → Item[]
```

Reading `electron/preload/index.ts` tells you everything the UI is allowed to do. The namespaces are `library`, `tags`, `capture`, `reader`, `collections`, `annotations`, `annotationThemes`, `convert`, `stats`, `goals`, `backup`, `discover`, `dictionary`, `llm`, `updater`, `log`, `auth`, `cloud`, `sync`, and `processing`.

Capture is the one streaming API: `capture:start` returns a job id right away, and the main process then sends `capture:progress`, `capture:complete`, or `capture:error` events.

HTML parsing and the embedding model run in `utilityProcess` workers that start on demand and shut down when idle, so a malicious page or a slow model can't freeze the main process.

## Project layout

```
electron/
  main/
    index.ts          app entry, window creation, IPC registration
    db/
      schema.ts       v1 baseline tables (see "Migrations" below)
      index.ts        DB init, versioned migrations, query helpers
      ftsText.ts      full-text index helpers
    ipc/              one file per API namespace (library, capture, reader, …)
                      (log.ts writes ErrorBoundary crash logs to <userData>/logs/)
    capture/
      index.ts        fetch → parse → sanitize → save → index
      fetch.ts        HTTP fetch with per-site headers
      sanitizer.ts    sanitize-html allowlist
      sites/          per-site parsers: ao3, ffnet, royalroad, scribblehub,
                      wattpad, forums, universal
    recommender/      Discover: candidate sources, embeddings, taste model, rerank
    cloud/            optional cloud layer: file backup to R2, sync/ engine
    auth/             Supabase client and encrypted session store
    security/         SSRF guard and input validation for outbound fetches
    dictionary/       offline WordNet lookup
    workers/          embed-worker and parse-worker
  preload/
    index.ts          the contextBridge surface

src/
  App.tsx             routes: / | /read/:id | /stats | /settings | /trash | /tags |
                      /collection/:id | /authors | /discover | /annotations
  types/index.ts      shared types and the window.api declaration
  services/           one module per IPC namespace
  components/         Library, Reader, Discover, Annotations, Stats, Settings, Capture, ui
  contexts/           Settings, Toast, Updater, CaptureJobs, Auth
  hooks/              useReadingSession, useAnnotations, useMarkInteractions,
                      useTextHighlight (Cmd+F), usePdfSearch, useGridColumns
  utils/themeDerive.ts  builds a full theme from two seed colors
  styles/             globals.css (design tokens, themes, layout), reader.css,
                      plus one stylesheet per larger view

server/               Supabase migrations, config, Edge Functions, and the
                      Cloud Run extraction service
```

## Database

SQLite through `better-sqlite3`, stored at `<userData>/library.db`. Every connection sets `PRAGMA foreign_keys = ON` (SQLite doesn't remember it) and `PRAGMA journal_mode = WAL`.

| Table | Holds |
|---|---|
| `items` | one row per saved work: title, author, type, file path, word count, `deleted_at` |
| `progress` | scroll position, furthest position reached, chapter, status |
| `tags`, `item_tags` | tags and which items have them |
| `collections`, `collection_items` | collections and their ordered items |
| `reading_sessions` | start, end, and duration of each reading session |
| `goals`, `goal_items` | reading goals and reading-list members |
| `annotations` | highlights, notes, and bookmarks |
| `annotation_themes`, `annotation_theme_links` | named highlight themes |
| `tag_alias` | maps tag spellings to a canonical name |
| `items_fts`, `item_fts_index` | full-text index and a record of what was indexed |
| `item_embeddings`, `item_source_meta`, `item_source_tags`, `taste_seeds` | inputs to Discover |
| `candidate_cache`, `candidate_embeddings`, `discover_cache`, `dismissed_recommendations`, `discover_interactions` | Discover's candidates, feed, and feedback |
| `blob_sync` | upload state for each backed-up file (cloud only) |
| `sync_cursors`, `sync_meta` | sync position per table and the last signed-in account (cloud only) |

Saved content lives next to the database in `<userData>/content/` as `<uuid>.html`, `<uuid>.epub`, `<uuid>.pdf`, or `<uuid>-ch0.html … <uuid>-chN.html` for multi-chapter works.

### Migrations

Migrations are numbered SQL strings in `electron/main/db/index.ts`. To add one, append to `MIGRATIONS` and bump `CURRENT_VERSION`. They run in a transaction at startup through `execMigration()`, which tolerates a re-applied `ADD COLUMN` so a database that already has the column doesn't fail. The current version is 45.

Don't add new columns to `schema.ts`. It has to stay at the v1 baseline: `CREATE TABLE IF NOT EXISTS` never changes an existing table, so a column that's in both `schema.ts` and an `ALTER TABLE` migration crashes fresh installs with `duplicate column name`. This shipped once (v0.5.1). `migrations.test.ts` now guards against it.

### Progress

`progress` has two positions. `scroll_position` is where you are now, used to resume reading. `max_scroll_position` is the furthest you've ever reached, used for stats, so going back to reread doesn't lower your words-read count. When a PDF has been converted to EPUB (the EPUB row's `derived_from` points at the PDF), progress is copied between the two.

## Capture pipeline

`captureUrl()` in `electron/main/capture/index.ts`:

1. Pick a parser based on the site (`sites/ao3.ts`, …, falling back to `sites/universal.ts`).
2. Fetch the pages.
3. Extract the content with `@mozilla/readability` and `jsdom`.
4. Clean it with `sanitize-html`.
5. Download images in the page and embed them as `data:` URIs, so they show offline. These fetches are SSRF-guarded and capped in size and count.
6. Write the files to `content/`.
7. Insert the item and index its text.

Multi-chapter works are stored one file per chapter. The reader loads the current chapter and prefetches its neighbors.

## Readers

`ReaderView` picks a reader by `item.content_type`:

| Format | Component | Built on |
|---|---|---|
| HTML | `HtmlReader` | plain DOM, single file or chapters |
| EPUB | `EpubReader` | epub.js |
| PDF | `PdfReader` | pdf.js, with continuous zoom from 0.5× to 3× |

All three support highlights, notes, bookmarks, in-book search, and dictionary lookup. `useReadingSession` records reading time, skipping idle time and dropping sessions under 5 seconds.

Custom themes are made from a background color, an accent color, and a light/dark flag. `src/utils/themeDerive.ts` computes the rest of the CSS variables and sets them on `<html>`.

## Stats

Everything on the stats page is computed from `reading_sessions` at query time. Nothing is pre-aggregated. A streak day is any day with at least one session. The activity calendar is a 53-week grid starting on Mondays, in local time, with five shading levels. Words read is `word_count × max_scroll_position`, summed over items. A PDF and the EPUB converted from it count as one book.

## Discover

Code is in `electron/main/recommender/`.

1. Your items are embedded by a local sentence-embedding model (`@huggingface/transformers` on onnxruntime, bundled in `resources/models/`) and combined into a taste profile.
2. Candidate works are fetched from AO3, FanFiction.net, and Open Library (`sources/`), cached, and embedded.
3. Candidates are scored against the taste profile. If Ollama is running locally, it can optionally rerank the results.
4. The feed is cached. Works you own or have dismissed are filtered out.

The only network requests are public page fetches like the ones capture makes. Nothing about your library is sent.

## Gotchas

| Problem | Fix |
|---|---|
| `dompurify` throws `window is not defined` in the main process | Use `sanitize-html`, which runs in Node |
| `better-sqlite3` v9 doesn't build for Electron 31 | Use v11 or later |
| `reader:loadContent` returns garbage in the renderer | Return a string, not a `Buffer` (Node-only) |
| Full-text index out of date | The FTS5 table is contentless, so text has to be inserted on capture by hand |
| Buttons in the sidebar or header don't respond to clicks | Those regions are `-webkit-app-region: drag`; give interactive children `no-drag` |
| Rollup errors about `../../index.html` | `renderer.root` in `electron.vite.config.ts` must be `resolve('.')` |
| White flash on launch | Create the window with `show: false` and show it on `ready-to-show` |
| Foreign keys not enforced | `PRAGMA foreign_keys = ON` has to be set on every connection |
| Dropdown clipped by its card | Remove `overflow: hidden` from the container and open downward with `top: 100%` |

## Security (local side)

- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`, and can only call what the preload script exposes.
- Navigation to external URLs and `window.open` are blocked. In-app routing (HashRouter) isn't affected.
- The `library://` protocol only serves files inside `<userData>/content/` and rejects path traversal.
- The CSP in `index.html` is `script-src 'self' blob:` and `img-src 'self' data: library:`.
- Saved HTML and EPUB content goes through a strict allowlist that removes scripts, styles, iframes, event handlers, and `class`/`id` attributes.
- Saved reading positions are clamped to [0, 1], and a non-numeric value (such as NaN) is stored as 0.
- PDFs are drawn to a canvas with pdf.js eval, font-face loading, and XFA turned off, so PDF JavaScript can't run.

The cloud side (per-user isolation through Postgres row-level security, short-lived presigned upload URLs) is covered in [ARCHITECTURE.md](../ARCHITECTURE.md#8-security-model).
