import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Real temp userData dir + a stubbed safeStorage whose "encryption" is a
// reversible identity transform, so the persist→disk→restore path is exercised
// for real without needing an OS keychain. The dir is a mutable ref set in
// beforeAll (the mock reads it at call time).
const h = vi.hoisted(() => ({
  dir: { value: '' },
  available: { value: true },
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.dir.value },
  safeStorage: {
    isEncryptionAvailable: () => h.available.value,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}))

import { sessionStore, clearSessionStore } from './sessionStore'

beforeAll(() => {
  h.dir.value = mkdtempSync(join(tmpdir(), 'pl-sessionstore-'))
})

afterAll(() => rmSync(h.dir.value, { recursive: true, force: true }))

beforeEach(() => {
  h.available.value = true
  clearSessionStore()
})

describe('sessionStore', () => {
  it('round-trips a value through get/set', () => {
    sessionStore.setItem('k', 'v')
    expect(sessionStore.getItem('k')).toBe('v')
  })

  it('returns null for an unknown key', () => {
    expect(sessionStore.getItem('missing')).toBeNull()
  })

  it('removeItem deletes the key', () => {
    sessionStore.setItem('k', 'v')
    sessionStore.removeItem('k')
    expect(sessionStore.getItem('k')).toBeNull()
  })

  it('persists an encrypted file to disk on write', () => {
    sessionStore.setItem('token', 'abc')
    expect(existsSync(join(h.dir.value, 'auth', 'session.enc'))).toBe(true)
  })

  it('clearSessionStore wipes the persisted file', () => {
    sessionStore.setItem('token', 'abc')
    clearSessionStore()
    expect(existsSync(join(h.dir.value, 'auth', 'session.enc'))).toBe(false)
    expect(sessionStore.getItem('token')).toBeNull()
  })

  it('restores from the encrypted file on a fresh load (survives restart)', async () => {
    sessionStore.setItem('token', 'abc')
    // Simulate a relaunch: drop the in-memory module state, re-import fresh.
    vi.resetModules()
    const fresh = await import('./sessionStore')
    expect(fresh.sessionStore.getItem('token')).toBe('abc')
  })

  it('degrades to in-memory when encryption is unavailable (no plaintext on disk)', () => {
    h.available.value = false
    sessionStore.setItem('token', 'abc')
    // In-memory read still works within the session…
    expect(sessionStore.getItem('token')).toBe('abc')
    // …but nothing was written to disk unencrypted.
    expect(existsSync(join(h.dir.value, 'auth', 'session.enc'))).toBe(false)
  })
})
