import { app } from 'electron'
import { join, resolve, sep } from 'path'

// ── Path traversal guard (security.md F1) ───────────────────────────────────
//
// Single source of truth for "resolve this relative path but refuse to escape
// the sandbox directory". Previously duplicated as `safeFullPath` in
// ipc/reader.ts and as an inline check in the `library://` protocol handler in
// index.ts. Both are now routed through `resolveWithin`.
//
// Why this matters: `file_path` / `cover_path` come from the `items` table,
// which is fully replaced by `backup:import` after only a SQLite
// integrity_check (structure, not row values). A crafted backup can therefore
// set `file_path = ../../../../.ssh/id_rsa`; without this guard the next
// permanent-delete / empty-trash / 30-day startup purge would unlink it.

/**
 * Pure core — resolve `relative` inside `baseDir` and throw if the result
 * escapes it. Electron-independent so it can be unit-tested directly.
 *
 * The `base + sep` suffix on the prefix check is deliberate: it stops a sibling
 * directory whose name merely *starts with* the base (e.g. `.../content_backup`
 * vs `.../content`) from being treated as inside the sandbox.
 */
export function resolveWithin(baseDir: string, relative: string): string {
  const base = resolve(baseDir)
  const full = resolve(join(base, relative))
  if (!full.startsWith(base + sep)) throw new Error('Invalid content path')
  return full
}

/** Absolute path to the content directory (`<userData>/content`). */
export function contentDir(): string {
  return resolve(join(app.getPath('userData'), 'content'))
}

/**
 * Resolve a DB `file_path` (a bare filename, relative to `content/`) to an
 * absolute path, refusing traversal outside `content/`.
 */
export function safeContentPath(relative: string): string {
  return resolveWithin(contentDir(), relative)
}

/**
 * Resolve a DB `cover_path` (stored WITH the `content/` prefix, i.e. relative
 * to `userData`) to an absolute path, refusing traversal outside `userData`.
 * Also used by the `library://` protocol handler, which serves the whole
 * userData tree.
 */
export function safeUserDataPath(relative: string): string {
  return resolveWithin(app.getPath('userData'), relative)
}
