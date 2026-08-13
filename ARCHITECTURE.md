# Architecture

Personal Library is a **local-first desktop reading app** (Electron + React + TypeScript)
with an **optional, opt-in cloud layer** for cross-device backup and sync. This document
is the engineering deep-dive: the systems that were interesting to build, the tradeoffs
behind them, and why the app is shaped the way it is. For install/usage and a full
directory map, see the [README](README.md).

> **The one-line pitch for the impatient:** a fully offline SQLite/FTS5 reading app that
> *optionally* grows a custom local↔Postgres sync engine (whole-row LWW on a server-stamped
> clock), content-addressed blob backup to object storage brokered by short-lived presigned
> URLs, and a small fleet of privileged serverless janitors that garbage-collect orphaned
> storage safely across devices.

---

## 1. Design principles

Four constraints drove almost every decision:

1. **Local-first, offline-always.** The app must be fully functional without an account and
   with no network connection. Everything lives in a local SQLite database and a content
   directory. The cloud is an *enhancement*, never a dependency — sign out and nothing breaks.
2. **Privacy by default.** Reading habits and personal files are sensitive. Nothing leaves
   the device unless the user explicitly opts in, per item, behind a master switch that
   defaults off.
3. **Least privilege at every trust boundary.** The renderer can't touch the disk or DB;
   the client can't touch other users' storage; a hostile web page can't block the app.
4. **The database is the source of truth.** Features are modeled as data + migrations, not
   as ad-hoc state. This is what makes sync, dedup, and GC tractable later.

---

## 2. System at a glance

The app is two planes: an always-present **local core** and an **optional cloud layer**
bolted on top of it. The local core has no idea the cloud exists; the cloud layer treats
the local DB as the thing to mirror.

```
        ┌───────────────────────── Desktop app (Electron) ─────────────────────────┐
        │                                                                            │
        │   Renderer (React, sandboxed)                                              │
        │        │  window.api  (contextBridge — the ONLY surface)                   │
        │   ─────┼──────────────────────────────────────────────────────────────    │
        │   Main process (Node)                                                      │
        │        ├── IPC handlers ──── SQLite (better-sqlite3, WAL, FTS5) ◄── truth  │
        │        ├── capture pipeline (fetch → parse → sanitize → store)             │
        │        ├── utilityProcess workers (HTML parse, on-device embeddings)       │
        │        └── cloud/ (opt-in) ──────────┐                                     │
        └───────────────────────────────────────┼─────────────────────────────────────┘
                                                 │ (only when signed in + opted in)
                    ┌────────────────────────────┼────────────────────────────┐
                    │                            ▼                             │
                    │   Supabase                            Cloudflare R2      │
                    │   • Auth (JWT identity)               (object storage,   │
                    │   • Postgres + RLS (library mirror)    content-addressed) │
                    │   • Edge Functions (Deno):            ▲                   │
                    │       blob-url ── mints presigned ────┘ direct client↔R2  │
                    │       process-extract (off-device parsing)                │
                    │       reconcile-blobs (storage GC janitor)                │
                    └───────────────────────────────────────────────────────────┘
```

The key idea: **the server never proxies file bytes.** It signs short-lived, per-user URLs;
the client transfers directly to object storage. The server's job is identity, the metadata
mirror, and a few privileged maintenance tasks.

---

## 3. Process model & the IPC boundary

Electron's process split is used as a hard security boundary, not just a performance one.

- **Renderer** runs with `contextIsolation: true` and `nodeIntegration: false`. It has no
  filesystem, no database, no Node. Its entire capability set is the `window.api` object
  exposed via `contextBridge` in the preload script — an explicit allow-list.
- **Main** owns the database, the filesystem, and all privileged work.
- **A service abstraction layer** sits in front of IPC. Components never call `window.api`
  directly; they call `src/services/*`, which call `window.api.<namespace>.*`, which resolve
  to `ipcMain.handle` handlers. This keeps the exposed surface small and auditable — you can
  read one preload file and know exactly what the UI is allowed to do.

```
Component → service (src/services) → window.api (preload bridge) → ipcMain handler → SQLite
```

- **Untrusted / heavy work is isolated in `utilityProcess` workers.** HTML parsing (which
  runs untrusted markup through a DOM) and on-device embedding (a slow ML model) each run in
  their own process, spun up on demand and idle-shut-down. A hostile page or a slow model can
  never block the main process or the UI.

---

## 4. Local data & storage

- **SQLite via `better-sqlite3`**, opened with `foreign_keys = ON` and `journal_mode = WAL`.
  Full-text search is **FTS5** (porter + unicode61), kept in a contentless virtual table with
  a plain mirror table alongside it (contentless FTS5 can't delete by rowid, so the mirror
  records exactly what was indexed).
- **Content files** live outside the DB in a per-user content directory, keyed by UUID
  (`<uuid>.epub`, `<uuid>.pdf`, or `<uuid>-ch0.html … -chN.html` for multi-chapter captures).
  The DB holds metadata and pointers; the bytes are files.
- **Migrations are versioned integers run in a transaction on startup.** A hard-won
  discipline here: the `CREATE TABLE` baseline schema must stay frozen at v1, and every later
  column arrives via `ALTER TABLE ADD COLUMN` in a migration — because `CREATE TABLE IF NOT
  EXISTS` silently no-ops on an existing DB, so a column that lives in *both* the baseline and
  a migration crashes a **fresh install** with `duplicate column name` while upgrades stay
  fine. This shipped as a real bug once; the migration runner now tolerates re-applied
  `ADD COLUMN`s so already-broken databases **self-heal**, and a regression test reconstructs
  the broken DB to lock it. (This kind of "the failure only happens on a clean install" bug is
  exactly why the schema/migration split is treated as sacred.)

---

## 5. The cloud layer (the interesting part)

The cloud layer was built in phases, each a self-contained increment: identity → blob backup
→ metadata sync → instant sync → storage GC hardening. It is entirely opt-in and defaults off.

### 5.1 Blob backup — content-addressed, presigned, direct-to-storage

Book bytes are backed up to Cloudflare R2, **content-addressed** by the SHA-256 of a
deterministic archive of the item's files.

- **One item = one deterministic archive.** A multi-chapter fic is N files on disk; a single
  EPUB is one. To make content-addressing uniform, every item is packed into a small
  self-describing archive format with **no timestamps and sorted entries**, so identical
  content always serializes byte-identically → hashes identically → dedupes for free. A
  single-file book is just a one-entry archive. One GET restores a whole fic atomically.
- **The isolation boundary is a serverless function, not a client credential.** R2 has no
  row-level security, and shipping a scoped storage token inside an Electron app is a
  non-starter — an `.asar` unpacks trivially, so any such token reaches the *whole* bucket.
  Instead, the client calls a Deno **Edge Function (`blob-url`)** with its Supabase JWT; the
  function *verifies the token* (so the user id is trusted, never taken from the request
  body) and mints a **short-lived presigned PUT/GET scoped to `users/<verified-uid>/…`**. The
  storage secret never leaves the server; bytes flow **directly** client↔R2. This recreates
  the RLS guarantee for files and became the reusable template for every later server-brokered
  capability.
- **Backup status reflects reality, not intent.** A card shows "✓ backed up" only when the
  outbox ledger (`blob_sync`) says the upload actually landed — not the moment intent was
  recorded. A failed upload surfaces "Backup failed — Retry," because a backup status is a
  *safety claim* and a status that lies about safety is worse than no status.

### 5.2 Metadata sync — a custom whole-row LWW engine

The library itself (items, tags, collections, annotations, sessions, goals, themes, and their
join tables) syncs through a **custom local↔Postgres engine**, deliberately chosen over CRDTs.

**Why not CRDTs?** The product's sharing model (a future social layer) is **grant-based —
copy a pointer, don't co-edit a row** — so character-level convergence is never needed.
For a single user across their own devices, genuine concurrent edits to the same row are
rare, and when they happen the user wants "the last thing I did." That's **whole-row
Last-Write-Wins** — one rule for every table, no per-field clocks, no merge state.

The engine is **layered for testability**, and the layering is the point:

| Layer | Responsibility | IO? |
|---|---|---|
| `reconcile.ts` | The pure conflict matrix (C1–C6): given two row versions, who wins? | **none** |
| `specs.ts` | Single source of truth for *what* syncs and *how* (columns, mode, keys) | none |
| `syncStore.ts` | Local SQLite primitives (apply pull, apply push-readback, FTS reindex) | SQLite |
| `cloudRepo.ts` | The only file that touches the Postgres client | network |
| `syncEngine.ts` | `runSyncRound` orchestration | wires the above |

The reconciler being **pure** — data in, decision out, no network — means the entire
conflict matrix is unit-tested as plain values. That is the load-bearing choice that makes a
sync engine testable at all.

Three details that make it correct:

- **Server-stamped clock.** LWW compares `updated_at`, but device clocks drift — so the
  *server* stamps the timestamp on push (the upsert reads the authoritative clock back). The
  winner never depends on whose laptop clock is wrong.
- **A dirty local row never loses to a pull.** An un-pushed local edit always wins the pull
  side; it only loses if the *other* device pushed a strictly newer server timestamp. Deletes
  propagate as **tombstones** (retained row + `deleted_at`); a permanent delete keeps the
  tombstone plus a local `purged_at`.
- **Natural-key convergence for unique names (conflict case C4).** LWW-by-id breaks for
  `UNIQUE(name)` rows: two devices each create a tag "cozy" offline → different ids, same
  name → pushing both violates the constraint. Name-unique tables declare a natural key, and a
  pre-pull pass merges the two rows deterministically **and rewrites the loser's foreign
  references onto the survivor** so nothing is orphaned. (A sharp edge this created:
  soft-deleting a unique-named row has to *free* the name for reuse; the tombstone's name is
  suffixed with a separator — and the obvious choice, a NUL byte, is rejected by Postgres
  `text` columns, so it uses the Unit Separator `0x1F` instead. NUL is not a safe sentinel in
  Postgres text.)

A sync round is: resolve name collisions → **push-all-then-pull-all**, parents-before-children
so foreign keys apply top-down → advance the cursor transactionally → **never throw** (a sync
failure degrades to "not synced yet," it never corrupts local state).

### 5.3 Instant sync

Naive polling made edits take up to two minutes to appear on a second device. Instant sync
closes that to seconds with three moving parts: a **durable backup push** on mutation, a
**payload-ignoring realtime "go pull" nudge** (the realtime channel carries no data — it just
tells the other device to run a sync round now), and a **post-mutation trigger**. The
non-obvious bug found here: a completed backup was recording its `blob_hash` *without*
re-marking the row dirty, so some books became permanently un-openable on a second device —
a reminder that in a sync system, *when you mark a row dirty* is as load-bearing as the merge.

### 5.4 Storage garbage collection — a multi-user hardening arc

Backed-up bytes must eventually be reclaimed when the last item referencing them is
permanently deleted. This turned out to be the subtlest area in the whole system, and it was
hardened in a deliberate sequence — a good illustration of "correct for one user, dangerous
for many."

- **The client reaper** runs after a fresh sync round: for each blob in this device's local
  ledger, if no un-purged item references its hash, delete the R2 object. Reclaiming keys on
  `purged_at` (permanent delete), never `deleted_at` (trash), keeps the trash reversible.
- **A time-of-check/time-of-use race** exists: another device could restore or re-import
  content referencing hash `H` in the ~seconds between this device's last pull and its reap.
  Fixed with **mark-and-sweep**: an orphan isn't deleted on first sight — it's stamped
  `orphaned_at` and only reaped a grace window later, after it's *still* unreferenced across
  another round. A restore that propagates within the window cancels the reap. Crucially this
  is a **correctness** fix, not a cost optimization — a false reap here did *not* self-heal,
  because restore never re-uploads.
- **The client reaper structurally can't see every orphan.** Its candidate set is *this
  device's* ledger. Two classes escape forever: a "lost uploader" whose database was wiped
  after upload (no device holds a ledger row for the hash), and legacy scratch objects
  stranded by old crashes. The fix is a privileged **`reconcile-blobs` Edge Function**: it
  lists each user's storage prefix, cross-checks every object against Postgres (the globally
  authoritative "is this wanted?" oracle — every device pushes `blob_hash`/`purged_at`,
  LWW-merged), and deletes what no live row references.
  - Because the server has **no "I just uploaded this" knowledge**, a client PUT that lands
    seconds before its metadata row syncs would look orphaned. So the janitor only ever
    deletes objects **older than a 30-day age-gate** — making an in-flight upload impossible
    to false-delete. That age-gate is the mandatory safety, chosen over a stateful server-side
    mark-and-sweep table (simpler, no new schema, airtight given how rarely the sweep runs).
  - It is **dry-run by default** (deletion must be explicitly armed), gated behind a
    constant-time secret compare, and deployed with no public JWT surface — a privileged
    janitor with cross-user blast radius gets defense in depth.

The through-line: a single-user app can be sloppy about storage GC; a multi-user one cannot,
and the safety mechanisms (grace windows, age-gates, dry-run defaults) exist precisely because
the *server* lacks the per-device knowledge the client has.

---

## 6. Off-device processing

EPUB and PDF text extraction can be offloaded from the desktop to a private serverless
container (`process-extract`) — useful for large files. It reuses the same trust template as
blob backup: JWT-verified, per-user scoped, and (a hardening detail) its outbound fetch is
**pinned to the storage host** so the extraction container can't be turned into a
server-side request forgery (SSRF) pivot. HTML capture is deliberately *not* offloaded — it's
tightly coupled to the Electron fetch/parse path, and the analysis that reached that decision
is recorded as a first-class "we considered this and declined, here's why" call.

---

## 7. Discover — an on-device recommender

Discover recommends new fanfiction and books from the user's own library, entirely on-device:

- **On-device embeddings.** Owned items are embedded by a local model running in an isolated
  worker; nothing about reading taste is sent anywhere. A **taste vector** is modeled from
  those embeddings.
- **Candidate → embed → rerank.** Candidates are fetched from source APIs, embedded, and
  reranked against the taste model, with a candidate cache and a walking-gradient refresh so
  the feed stays fresh without hammering sources.
- **A hallucination-safe optional LLM reranker.** If a local LLM is present it can refine
  ranking, but it is constrained so it can only *reorder* real candidates — it can never
  invent a book that doesn't exist.
- **Offline evaluation.** Ranking quality is measured with a pure leave-one-out MRR / hit@k
  harness, so changes to the recommender are judged against a metric instead of vibes.

---

## 8. Security model

Security is enforced structurally, at boundaries, rather than by trusting callers:

- **Renderer sandbox** — `contextIsolation`, no `nodeIntegration`, an explicit `contextBridge`
  allow-list as the only capability surface.
- **Postgres RLS** is the isolation boundary between users — not schema secrecy — which is why
  the server code is safe to open-source.
- **Storage isolation via signed URLs** — no client ever holds a credential that can reach
  another user's prefix; the presigning function derives the user id from a *verified* token,
  never from request input.
- **Input hardening** — captured HTML is sanitized before storage; archive entry names are
  validated so a tampered archive can't write outside the content directory (path traversal);
  presigned PUTs are size-capped so the storage backend itself rejects oversize bodies; the
  extraction container's egress is host-pinned against SSRF.
- **The full library** underwent a dedicated security-audit-and-remediation pass once the
  cloud surface was complete; findings were fixed and locked with regression tests. (Details
  are kept private; the *posture* is described here.)

---

## 9. Testing & CI

Testing is treated as part of "done," not an afterthought:

- **~160 test files** across a Vitest workspace split into two projects: a **main** project
  (Node env, for main-process/DB/cloud code) and a **renderer** project (jsdom + React Testing
  Library).
- **A real DB integration harness** brings up the actual schema in an in-memory SQLite and
  wires it to the singleton, so IPC handlers are exercised end-to-end against real SQL — not
  mocks.
- **Coverage is ratcheted, never lowered.** Floors only move up; a change that would drop
  coverage fails CI.
- **Cross-runtime function cores are unit-tested in Node** against fakes (the pure
  `handler.ts` of each Edge Function), while the thin Deno glue stays out of the Node suite —
  the same core/glue split used everywhere.
- **CI gates every push/PR** on lint + typecheck + the full test suite (with coverage) + a
  **build matrix across macOS, Ubuntu, and Windows**, plus a Playwright-Electron end-to-end
  smoke test under a virtual display. `main` is branch-protected behind green CI.

---

## 10. Key decisions at a glance

Each of these was a real fork with rejected alternatives (the full reasoning lives in the
project's decision records):

| Decision | Chose | Over | Because |
|---|---|---|---|
| Desktop shell | Electron | Tauri | Consistent rendering for `epub.js`/`pdf.js`; no Rust dependency |
| Core posture | Local-first, no required backend | Cloud-first | Offline-always + privacy are product requirements |
| Renderer access | Service layer → `window.api` bridge | Direct IPC / direct DB | Small, auditable capability surface |
| Local store | `better-sqlite3` + FTS5 | Document store / hosted DB | Fast, synchronous, offline, real full-text search |
| Cloud model | Opt-in layer on top of local | Rewrite as cloud app | Enhancement, never a dependency |
| Sync algorithm | Whole-row LWW, server-stamped | CRDTs / per-field LWW | Grant-based sharing needs no co-edit convergence |
| Storage auth | Presigned URLs from a JWT-verified function | Shipped storage token / proxy bytes | A client token reaches the whole bucket; a proxy is a bottleneck |
| Storage GC | Client reaper + age-gated server janitor | Blanket lifecycle expiry | Content-addressed blobs never age out; safety needs an explicit gate |
| Recommender | On-device embeddings + offline eval | Server-side / no eval | Privacy; and rank changes must be measurable |
| LLM rerank | Reorder-only, hallucination-safe | Free-form generation | A recommender must never invent nonexistent works |

---

## 11. Status & scope

Personal Library is a **single-developer project built for real personal use.** The local
app is mature; the cloud layer is opt-in and validated against real infrastructure across two
devices. Some capabilities are deliberately **parked** rather than half-built — a social /
collaborative-reading layer (which would need proof-of-possession for cross-user storage
dedup) and scheduled automation of the storage janitor are documented as future work with the
reasoning for *why now is too early* recorded, not just their absence. The guiding rule
throughout: ship a thing correctly and completely, write down the decisions and the wrong
turns, and don't build for a scale that isn't here yet — but architect so reaching it doesn't
require a rewrite.
