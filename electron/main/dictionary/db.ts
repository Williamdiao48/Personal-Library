import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'

// The bundled WordNet dictionary is a READ-ONLY reference asset (built by
// scripts/dictionary/build.mjs, shipped via electron-builder extraResources).
// It is opened separately from library.db and lazily on first lookup, so a user
// who never uses "Define" pays no I/O and no open cost. Being read-only with no
// migrations, it sits entirely outside the app's schema/migration machinery.

let dbSingleton: Database.Database | null | undefined

/**
 * Locate the bundled dictionary.db, mirroring resolveModelPaths():
 * - packaged: `<resourcesPath>/dictionary/dictionary.db` (extraResources)
 * - dev:      `<appPath>/resources/dictionary/dictionary.db` (repo tree)
 */
export function resolveDictionaryPath(envInfo: {
  isPackaged: boolean
  appPath: string
  resourcesPath: string | undefined
}): string {
  return envInfo.isPackaged
    ? join(envInfo.resourcesPath ?? '', 'dictionary', 'dictionary.db')
    : join(envInfo.appPath, 'resources', 'dictionary', 'dictionary.db')
}

/**
 * Open (once) and return the read-only dictionary handle, or null if the asset
 * is missing — a missing dictionary must degrade to "not found", never crash.
 * Tests inject a handle via __setDictionaryDb().
 */
export function getDictionaryDb(): Database.Database | null {
  if (dbSingleton !== undefined) return dbSingleton
  try {
    const path = resolveDictionaryPath({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    })
    dbSingleton = new Database(path, { readonly: true, fileMustExist: true })
  } catch {
    dbSingleton = null
  }
  return dbSingleton
}

/** Test seam: inject an in-memory dictionary DB (or null to force the miss path). */
export function __setDictionaryDb(db: Database.Database | null): void {
  dbSingleton = db
}
