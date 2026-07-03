# Testing

The test suite is split into two Vitest **projects** (`vitest.workspace.ts`):

| Project    | Env     | Globs                        | What it covers |
|------------|---------|------------------------------|----------------|
| `main`     | node    | `electron/**/*.test.ts`      | Main-process logic: security helpers, parsers, DB/IPC integration |
| `renderer` | jsdom   | `src/**/*.test.{ts,tsx}`     | Services, hooks, React components |

End-to-end tests (Playwright driving the built Electron app) live in `e2e/` and run separately via `npm run test:e2e`.

## Commands

```bash
npm test               # run all unit/integration tests (both projects)
npm run test:watch     # watch mode
npm run test:coverage  # run with V8 coverage + threshold gate
npm run test:e2e       # Playwright-Electron smoke tests (needs a built app)
npm run lint           # ESLint
npm run typecheck      # tsc --noEmit
```

## ⚠️ The better-sqlite3 ABI toggle (important)

`better-sqlite3` is a native module and must be compiled for the runtime that loads it:

- **Electron** (for `npm run dev` / `npm run build` / the packaged app) — the default;
  `postinstall` runs `electron-rebuild`.
- **Node** (for `npm test`, because Vitest runs under plain Node) — the DB/IPC
  integration tests `require('better-sqlite3')` directly.

The two ABIs are incompatible, so you flip between them:

```bash
npm run rebuild:node       # before running DB/IPC tests locally
npm run rebuild:electron   # before running the app again
```

Tests that don't touch the DB (security, parsers, renderer) run fine regardless.
Only the `electron/main/{db,ipc}/*.test.ts` suites need the Node ABI.

### Python 3.12+ note

Building `better-sqlite3` from source uses `node-gyp`, which needs Python's
`distutils` — removed in Python 3.12+. Install `setuptools` (which re-provides it):

```bash
python3 -m venv .gyp-venv && .gyp-venv/bin/pip install setuptools
PYTHON="$PWD/.gyp-venv/bin/python" npm run rebuild:node
```

CI installs `setuptools` in the `test` job for the same reason.

## DB / IPC integration tests

These exercise real IPC handlers against an **in-memory SQLite** database:

```ts
import { invoke, resetIpc } from '../../../test/stubs/electron'
import { openTestDb, closeTestDb, seedItem } from '../../../test/db/harness'
import { registerLibraryHandlers } from './library'

beforeEach(() => { resetIpc(); openTestDb(); registerLibraryHandlers() })
afterEach(() => closeTestDb())

it('excludes trashed items', async () => {
  seedItem(db, { deleted_at: Date.now() })
  expect(await invoke('library:getAll')).toEqual([])
})
```

- `test/db/harness.ts` — `openTestDb()` brings up a fresh `:memory:` DB via the
  **same** `SCHEMA` + `MIGRATIONS` as production (`bringUpSchema`), and wires it into
  the `db/index.ts` singleton so handlers' `run/get/all` helpers use it. Plus seed
  factories (`seedItem`, `seedCollection`, `seedSession`, …).
- `test/stubs/electron.ts` — the `electron` module is aliased to this stub. It
  records `ipcMain.handle(...)` registrations so `invoke(channel, ...args)` can call
  a handler directly, and provides minimal `app`/`dialog`/`BrowserWindow` stubs.

## Renderer tests

- `test/renderer/setup.ts` — jest-dom matchers + RTL cleanup (auto-loaded).
- `test/renderer/mockWindowApi.ts` — `installMockApi()` installs a Proxy-based fake
  `window.api` (every method an auto-`vi.fn()`), for asserting service delegation.
- Components use `@testing-library/react` + `@testing-library/user-event`; hooks use
  `renderHook`.

## Fixtures

- `test/fixtures/epub.ts` — `buildEpub(opts)` / `makeEpubFile(opts)` construct
  spec-shaped EPUBs (mimetype, container.xml, OPF, chapters, cover) with escape
  hatches for malformed variants.

## Regression-test convention

Bugs from `report.md` are locked with tests named `regression BUG-N: …` (or
`SEC-N`). If a fix is reverted, the corresponding test fails. Open items that are
not yet fixed are marked `it.todo(...)` (e.g. `SEC-2` rating clamp).

## Coverage

V8 coverage with a **ratcheting** floor in `vitest.config.ts` — thresholds are kept
just under the achieved numbers so a regression fails CI, and raised as new suites
land. Coverage is reported (not a hard blocker on young suites); lint + typecheck +
tests passing are the enforced gates.

## CI

`.github/workflows/ci.yml` runs on push to `main` and all PRs:

- **lint-typecheck** — `eslint` + `tsc`
- **test** — `rebuild:node` then `test:coverage`
- **build** — `electron-vite build` on ubuntu/macos/windows (compile sanity)
- **e2e** — Playwright-Electron smoke (added in the E2E phase)

`release.yml` (tag-triggered) builds and publishes; cut releases from a green `main`.
