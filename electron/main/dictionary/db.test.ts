import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { resolveDictionaryPath, getDictionaryDb, __setDictionaryDb } from './db'

// resolveDictionaryPath mirrors the model-asset resolution (packaged vs dev),
// and the injection seam lets the lookup logic run against an in-memory DB.
//
// The `electron` app is mocked through a hoisted config object so the real
// getDictionaryDb() open path (resolve → new Database) can be exercised: mutate
// `envCfg`, re-import the module fresh (resetting its `undefined` singleton), and
// point the resolved path at a real (or absent) file on disk.
const envCfg = vi.hoisted(() => ({ isPackaged: false, appPath: '/app', resourcesPath: '' }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return envCfg.isPackaged
    },
    getAppPath: () => envCfg.appPath,
  },
}))

describe('resolveDictionaryPath', () => {
  it('points at resourcesPath/dictionary when packaged', () => {
    expect(
      resolveDictionaryPath({ isPackaged: true, appPath: '/app', resourcesPath: '/res' }),
    ).toBe('/res/dictionary/dictionary.db')
  })

  it('points at appPath/resources/dictionary in dev', () => {
    expect(
      resolveDictionaryPath({ isPackaged: false, appPath: '/app', resourcesPath: undefined }),
    ).toBe('/app/resources/dictionary/dictionary.db')
  })

  it('falls back to an empty resourcesPath prefix when packaged but resourcesPath is undefined', () => {
    expect(
      resolveDictionaryPath({ isPackaged: true, appPath: '/app', resourcesPath: undefined }),
    ).toBe('dictionary/dictionary.db')
  })
})

describe('getDictionaryDb injection seam', () => {
  afterEach(() => __setDictionaryDb(null))

  it('returns the injected handle', () => {
    const mem = new Database(':memory:')
    __setDictionaryDb(mem)
    expect(getDictionaryDb()).toBe(mem)
    mem.close()
  })

  it('returns null when explicitly set to null (missing asset)', () => {
    __setDictionaryDb(null)
    expect(getDictionaryDb()).toBeNull()
  })
})

describe('getDictionaryDb open path (real filesystem)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pl-dict-'))
    envCfg.isPackaged = false
  })
  afterEach(() => {
    vi.resetModules()
    rmSync(dir, { recursive: true, force: true })
  })

  it('opens and caches the resolved dictionary db when the asset exists', async () => {
    // Seed a real sqlite file at the dev-resolved location.
    const dbPath = join(dir, 'resources', 'dictionary', 'dictionary.db')
    mkdirSync(dirname(dbPath), { recursive: true })
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE t (x)')
    seed.close()
    envCfg.appPath = dir

    vi.resetModules()
    const mod = await import('./db')
    const handle = mod.getDictionaryDb()
    expect(handle).not.toBeNull()
    // Second call short-circuits on the cached singleton (same instance).
    expect(mod.getDictionaryDb()).toBe(handle)
    handle?.close()
    mod.__setDictionaryDb(null)
  })

  it('degrades to null (never throws) when the asset is missing', async () => {
    envCfg.appPath = join(dir, 'does', 'not', 'exist')

    vi.resetModules()
    const mod = await import('./db')
    expect(mod.getDictionaryDb()).toBeNull()
    // Cached: the failed open is remembered as null, not retried.
    expect(mod.getDictionaryDb()).toBeNull()
  })
})
