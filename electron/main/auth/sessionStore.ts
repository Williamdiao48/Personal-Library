import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

// A supabase-js storage adapter backed by Electron `safeStorage` (OS keychain-
// encrypted), so the persisted session (access + refresh token) never sits on
// disk in plaintext. supabase-js owns a single storage key (`sb-<ref>-auth-token`),
// but we keep a generic key→value map so we're agnostic to that name.
//
// Load-bearing to the Phase 1 invariant: this touches disk ONLY when supabase-js
// reads/writes a session — i.e. never until the user signs in. A fresh, never
// signed-in install has no session file and this code makes no I/O on launch
// beyond one cheap existsSync during the client's first getSession.
//
// Fallback: if safeStorage encryption is unavailable (rare — e.g. a Linux box
// with no keyring), we degrade to in-memory only. The user can still sign in;
// the session just won't survive a restart. We NEVER write the tokens to disk
// unencrypted.

const AUTH_DIR = () => join(app.getPath('userData'), 'auth')
const SESSION_FILE = () => join(AUTH_DIR(), 'session.enc')

/** In-memory mirror of the persisted map; the source of truth while running. */
let cache: Record<string, string> | null = null

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** Lazily load the persisted map (decrypting) on first access. */
function load(): Record<string, string> {
  if (cache) return cache
  cache = {}
  try {
    const file = SESSION_FILE()
    if (existsSync(file) && encryptionAvailable()) {
      const decrypted = safeStorage.decryptString(readFileSync(file))
      cache = JSON.parse(decrypted) as Record<string, string>
    }
  } catch {
    // Corrupt/unreadable session → treat as signed-out. Never throw on launch.
    cache = {}
  }
  return cache
}

/** Persist the in-memory map, encrypted. No-op (memory only) if unavailable. */
function persist(): void {
  if (!cache) return
  if (!encryptionAvailable()) return
  try {
    const dir = AUTH_DIR()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(SESSION_FILE(), safeStorage.encryptString(JSON.stringify(cache)))
  } catch {
    // Best-effort; a failed persist leaves the in-memory session intact.
  }
}

/**
 * The storage adapter object handed to `createClient`. supabase-js accepts sync
 * or async get/set/remove; ours are sync (local disk) and returned as-is.
 */
export const sessionStore = {
  getItem(key: string): string | null {
    return load()[key] ?? null
  },
  setItem(key: string, value: string): void {
    const map = load()
    map[key] = value
    persist()
  },
  removeItem(key: string): void {
    const map = load()
    delete map[key]
    persist()
  },
}

/** Hard reset — wipe the encrypted session file and the in-memory cache. */
export function clearSessionStore(): void {
  cache = {}
  try {
    const file = SESSION_FILE()
    if (existsSync(file)) rmSync(file)
  } catch {
    // ignore
  }
}
