# Personal Library — Roadmap

## Next Priorities

| Priority | Area | Why |
|---|---|---|
| 1 | Duplicate URL detection | Prevents silent duplicate captures; trivial to add |
| 2 | Title editing | Completes metadata editing; author flow already exists as a template |
| 3 | Word count for EPUB/PDF | Stats are blind to books; fixes words-read and avg WPM for most heavy readers |
| 4 | Per-item notes | High utility for a reading app; simple schema addition |
| 5 | Auto-refresh on open | Convenience; infrastructure already exists |
| 6 | Smart collections | Complex; low urgency |

---

## Reader Experience

**Reading progress indicator** — removed; chapter count in header is sufficient.

**Continuous scroll mode for HTML reader** ✅
Toggle in Aa settings panel (Scroll → Paged / Continuous). Renders all chapters as one long document; IntersectionObserver updates the chapter indicator as you scroll past boundaries. Scroll position restored on re-open.

**EPUB reader completeness** ✅
Spacing (line-height 1.4/1.7/2.1) and Width (narrow/normal/wide side padding) added to Aa settings panel. Page-count measurement div updated to match, so globalPage/globalTotal stay accurate after changing either setting.

**PDF reader completeness** ✅
Zoom (4 levels), page navigation (arrows + number input + keyboard), progress tracking (saves page, records sessions), and text search (Cmd+F) are all implemented in PdfReader.tsx.

**Scroll position precision** ✅
Stores `{ chapter, scrollY }` and restores to exact chapter + scroll offset. DB schema v5.

**Keyboard shortcuts** ✅
`j`/`k` scroll, `[`/`]` prev/next chapter, `f` fullscreen, `Cmd+F` search — implemented in both HtmlReader and EpubReader.

**Font & typography controls** ✅
HtmlReader: font size/family/theme/line-height/max-width/continuous mode. EpubReader: font size/family/theme.

---

## Library & Organization

**Explicit reading status** ✅
Clickable status badge on each card opens a dropdown: Unread / Reading / Finished / On Hold / Dropped / Auto. Stored in `progress.status`; `getEffectiveStatus()` falls back to scroll_position inference when NULL. DB migration v7.

**Export / backup** ✅
ZIP export (`.plbackup`) containing `library.db` + all `content/` files. Import validates the ZIP, closes the DB, overwrites files, and relaunches. Export/Import buttons in Settings → Data. WAL checkpoint before export ensures self-contained DB file.

**Collections improvements** ❌
Collections exist with CRUD and sidebar display. A dedicated cover-grid shelf view would be more compelling than a flat list.

**Smart collections / saved searches** ❌
Auto-collections defined by rules: "all fanfiction over 100k words", "articles tagged 'to-read' added this week". Stored as serialized filter expressions, evaluated at query time.

**Bulk operations** ✅
Shift+click range select, Cmd+A select all, bulk tag/collection assign, bulk delete with confirmation.

**Better sorting & filtering** ✅
Word count, last-read date, reading progress sorts. Filter by content type, tag, author. Active filter chips with clear actions.

**Author view** ✅
Clicking an author name filters to their works. Author list in sidebar with item counts (shown on hover).

**Title editing** ❌
Author editing exists (`library:setAuthor`, inline in ItemCard) but there is no equivalent for titles. A bad parse or mis-titled capture has no fix without going into the DB directly. Needs `library:setTitle` IPC + inline edit UI matching the author flow.

**Per-item notes** ❌
No notes or annotation field anywhere in the schema. A simple freeform text field per item — visible in the card detail or a dedicated panel — covers the common case of wanting to jot down why you saved something or where you left off mentally.

**Collection item ordering** ❌
Items inside a collection have no manual order; they sort by insertion. Drag-to-reorder (or up/down buttons) would make collections usable as ranked or sequenced reading lists.

---

## Capture

**Auto-refresh on open** ❌ (infrastructure done, not wired)
HEAD check when opening an item and badge it if changed. `library:refresh` IPC handler exists and does the HEAD check — needs to be auto-triggered on item open and surface a "changed" badge.

**Duplicate URL detection** ❌
Capturing a URL that already exists in the library silently creates a second copy. Should query `items.source_url` before capture and warn (or offer to refresh the existing item instead).

**More site parsers** ✅
Royal Road (`royalroad.ts`), Wattpad (`wattpad.ts`), Scribble Hub (`scribblehub.ts`), and Sufficient Velocity / Spacebattles (`forums.ts`) are all implemented. Each registered in `capture/index.ts` and `refreshContent`.

**Chapter range capture** ✅
For very long serials, let users capture a range ("chapters 1–50") and append more later. Store `chapter_start` / `chapter_end` metadata.

**Background capture + progress UX** ✅
Fire-and-forget `capture:start` IPC. Sidebar shows live progress bar, chapter count, ETA. Modal closes immediately on submit.

**Universal site parser** ✅
Three-strategy parser (TOC detection, numeric URL increment, bidirectional next/prev walk) handles arbitrary fiction sites without site-specific code.

---

## Performance

**Image lazy loading** ✅
`loading="lazy"` injected on all `<img>` elements via `transformTags` in the sanitizer; `loading` added to the allowedAttributes allowlist.

**Virtual list for large libraries** ✅
`@tanstack/react-virtual` `useVirtualizer` virtualises the library grid by row. Column count tracks container width via ResizeObserver; each virtual row is absolutely positioned. Handles libraries of any size without frame drops.

**Content lazy loading** ✅
Multi-chapter captures now write each chapter as a separate file (`{uuid}-ch0.html`, `{uuid}-ch1.html`, …). `reader:getChapterCount` + `reader:loadChapter` IPC handlers serve individual chapters. HtmlReader loads only the active chapter and prefetches neighbours; legacy single-file items continue to work unchanged.

**FTS prefix queries** ✅
`library:search` passes queries through `toFtsPrefix()` which appends `*` to each non-operator token, enabling partial-word matching as the user types.

**React.memo + search debounce** ✅
ItemCard wrapped with custom comparator. Search input debounced 300ms. Sidebar ETA tick isolated to `<LiveEta>` sub-component.

---

## Styling & Polish

**Cover image placeholder colors** ✅
Cards without covers show a white initial letter on a deterministic per-item color (8-color palette, hashed from item ID). Matches GitHub-style avatar coloring.

**Sidebar enhancements** ❌
Recent items section. Collapsible tag list.

**Consistent design tokens** ✅
`--radius`, `--radius-sm`, `--radius-lg`, `--success`, `--t-fast/mid/slow` tokens. Hardcoded colors converted to CSS vars.

**Animations & transitions** ✅
Card hover lift, modal spring fade-in, bulk bar spring slide-up, filter chip fade-in, card selection transition.

**Empty states** ✅
Empty library, no-results, no-collections-yet, reader load error all have dedicated messages and actions.

---

## Stats & Reading Goals

**Reading calendar heatmap** ✅
GitHub-style 53-week contribution grid, Monday-anchored, 5 intensity levels. Computed from `reading_sessions.started_at` with local timezone conversion.

**Streaks** ✅
Current streak (consecutive days back from today/yesterday) and longest all-time streak. Streak doesn't break mid-day if you haven't read yet today. Computed from distinct session days in `reading_sessions`.

**Reading goals** ✅
Three goal types: Reading Time (minutes/period), Books Finished (count/period), Reading Lists (curated item checklists). Time and count goals are always-visible period grids (Daily / Weekly / Monthly / Yearly) — click any slot to set or clear a target. Each slot shows a progress ring. Reading lists show per-item progress bars and a persistent inline search for adding books. PDF + derived EPUB treated as one book (deduplication via `derived_from`). Goals backed by `goals` + `goal_items` tables (DB migration v10).

**Per-item stats** ✅
Time spent, session count, avg WPM (words read ÷ total time), last read, and progress bar. All columns right-aligned over their content.

**StatsView core** ✅
Summary cards (total time, items finished/started, words read est.), 1-year activity heatmap, goals section, per-item breakdown table.

**Word count for EPUB and PDF** ❌
`word_count` is stored as `null` for all EPUB and PDF imports. This means words-read estimates, avg WPM, and goal progress are blind to those formats. EPUB text can be extracted from the OPF spine at import time; PDF text extraction is feasible via pdf.js or a Node library. Affects stats accuracy for anyone whose library is primarily books rather than articles.

---

## Infrastructure & Reliability

**Auto-updater** ❌
`electron-updater` with GitHub Releases backend. Non-intrusive "Update available" banner.

**Crash logging** ❌
Log error boundary catches to `userData/logs/` for debugging.

**Database migrations** ✅
Versioned migration runner (v1–v11) with transaction wrapping. Schema upgrades cleanly without a wipe. `PRAGMA foreign_keys = ON` and `journal_mode = WAL` set on every open — FK constraints (ON DELETE CASCADE/SET NULL) are enforced and writes are safe under concurrent reads.

**High-water scroll position** ✅
`progress.max_scroll_position` tracks the furthest point ever reached, independent of current scroll position. Stats (words read, avg WPM) use the high-water mark so rewinding to re-read an earlier chapter doesn't deflate counts. DB migration v11.

**Error boundary** ✅
React error boundary wraps the entire app. Unhandled render crashes show a recoverable screen instead of blanking the window.

**Settings persistence** ✅
Reader preferences persist via localStorage and survive relaunch.

**Reader defaults in Settings** ❌
Font size, font family, line height, and theme are stored in `SettingsContext` (localStorage) and work correctly, but there is no UI in the Settings view to change them outside of the in-reader Aa panel. Power users who want to set defaults before opening a book have no path to do so.
