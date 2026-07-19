import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { resolveDictionaryPath, getDictionaryDb, __setDictionaryDb } from './db'

// resolveDictionaryPath mirrors the model-asset resolution (packaged vs dev),
// and the injection seam lets the lookup logic run against an in-memory DB.

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
