import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import AdmZip from 'adm-zip'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { invoke, resetIpc, dialog, app } from '../../../test/stubs/electron'
import { openTestDb, closeTestDb, seedItem, type TestDb } from '../../../test/db/harness'
import { registerBackupHandlers } from './backup'

// The L3 quiesce guard consults these two seams before the DB swap. Mock them so the
// import handler is testable up to (and including) the guard without a real relaunch:
//   - captureWorkActive: is any capture in flight? (default false — off for the export /
//     cancel / missing-db tests, which return before the guard anyway)
//   - flushNow: durable push before the overwrite (default no-op)
//   - closeDb (partial mock — everything else in ../db stays real so the harness works):
//     a spy we can make throw to abort right after the flush, proving the swap ordering
//     without performing the real file swap / app.relaunch (kept an E2E concern).
vi.mock('../capture/activity', () => ({ captureWorkActive: vi.fn(() => false) }))
vi.mock('../cloud/sync/syncService', () => ({ flushNow: vi.fn(async () => {}) }))
vi.mock('../db', async (orig) => {
  const actual = await orig<typeof import('../db')>()
  return { ...actual, closeDb: vi.fn() }
})

import { closeDb } from '../db'
import { captureWorkActive } from '../capture/activity'
import { flushNow } from '../cloud/sync/syncService'

// backup's full export/import round-trip swaps real DB files and calls app.exit /
// app.relaunch, so it belongs in the E2E layer. These tests cover the tractable,
// security-relevant guards: the dialog-cancel early-returns and the "archive
// missing library.db" rejection that gates the F5-hardened extraction.

let tmp: string

beforeEach(() => {
  resetIpc()
  registerBackupHandlers()
  tmp = mkdtempSync(join(tmpdir(), 'pl-backup-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

describe('backup:export', () => {
  it('returns null when the save dialog is canceled', async () => {
    vi.spyOn(dialog, 'showSaveDialog').mockResolvedValue({ canceled: true, filePath: undefined })
    expect(await invoke('backup:export')).toBeNull()
  })
})

describe('backup:import', () => {
  it('returns without importing when the open dialog is canceled', async () => {
    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await invoke('backup:import')).toBeUndefined()
  })

  it('rejects an archive that does not contain library.db (before any extraction)', async () => {
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from('{}'))
    const badPath = join(tmp, 'bad.plbackup')
    writeFileSync(badPath, zip.toBuffer())

    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({ canceled: false, filePaths: [badPath] })
    await expect(invoke('backup:import')).rejects.toThrow(/library\.db not found/i)
  })
})

// The export happy path is tractable in a unit test (no app.exit / DB swap): it
// only reads the live DB + content dir and writes a ZIP. The full IMPORT round-trip
// (closeDb → file swap → app.relaunch/exit) stays an E2E concern by design.
describe('backup:export — archive contents', () => {
  let userData: string
  let dbHarness: TestDb

  beforeEach(() => {
    resetIpc()
    registerBackupHandlers()
    dbHarness = openTestDb()
    // A per-test userData dir (app.getPath is overridden to it) so packing the DB
    // + content never collides with other suites sharing the stub's fixed path.
    userData = mkdtempSync(join(tmpdir(), 'pl-backup-ud-'))
    vi.spyOn(app, 'getPath').mockImplementation((name: string) =>
      name === 'userData' ? userData : join('/tmp', `pl-test-${name}`),
    )
    // A real (dummy) library.db file for adm-zip to pack, plus a content dir.
    writeFileSync(join(userData, 'library.db'), 'SQLite-format-3-placeholder')
    mkdirSync(join(userData, 'content'), { recursive: true })
    writeFileSync(join(userData, 'content', 'a.html'), '<p>hi</p>')
    tmp = mkdtempSync(join(tmpdir(), 'pl-backup-out-'))
  })
  afterEach(() => {
    closeTestDb()
    vi.restoreAllMocks()
    rmSync(userData, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
  })

  it('writes a .plbackup ZIP with a manifest, the DB, and the content folder', async () => {
    seedItem(dbHarness, { id: 'i1' })
    seedItem(dbHarness, { id: 'i2' })
    const outPath = join(tmp, 'export.plbackup')
    vi.spyOn(dialog, 'showSaveDialog').mockResolvedValue({ canceled: false, filePath: outPath })

    const result = (await invoke('backup:export')) as {
      path: string
      itemCount: number
      fileSizeBytes: number
    }

    expect(result.path).toBe(outPath)
    expect(result.itemCount).toBe(2)
    expect(result.fileSizeBytes).toBeGreaterThan(0)
    expect(existsSync(outPath)).toBe(true)

    const entries = new AdmZip(outPath).getEntries().map((e) => e.entryName)
    expect(entries).toContain('manifest.json')
    expect(entries).toContain('library.db')
    expect(entries.some((e) => e.startsWith('content/'))).toBe(true)

    const manifest = JSON.parse(
      new AdmZip(outPath).getEntry('manifest.json')!.getData().toString('utf8'),
    )
    expect(manifest).toMatchObject({ version: 1, itemCount: 2, contentFileCount: 1 })
  })
})

// L3 — the quiesce guard that runs AFTER extraction + integrity check but BEFORE the
// destructive closeDb()/swap. Both cases short-circuit before the real file swap, so
// they're unit-testable (the full swap round-trip stays E2E, per the note above).
describe('backup:import — L3 quiesce guard', () => {
  let userData: string
  let backupPath: string

  beforeEach(async () => {
    resetIpc()
    registerBackupHandlers()
    vi.mocked(captureWorkActive).mockReturnValue(false)
    vi.mocked(flushNow)
      .mockClear()
      .mockResolvedValue(undefined as never)
    vi.mocked(closeDb)
      .mockReset()
      .mockImplementation(() => {})

    // A per-test userData dir so import-tmp lands in a temp location.
    userData = mkdtempSync(join(tmpdir(), 'pl-backup-import-ud-'))
    vi.spyOn(app, 'getPath').mockImplementation((name: string) =>
      name === 'userData' ? userData : join('/tmp', `pl-test-${name}`),
    )

    // A REAL, valid sqlite DB so extraction + integrity_check pass and the handler
    // reaches the guard. adm-zip packs it as library.db at the archive root.
    const Database = (await import('better-sqlite3')).default
    const dbFile = join(userData, 'valid-library.db')
    const d = new Database(dbFile)
    d.exec('CREATE TABLE t (x)')
    d.close()
    const zip = new AdmZip()
    zip.addLocalFile(dbFile, '', 'library.db')
    backupPath = join(userData, 'good.plbackup')
    writeFileSync(backupPath, zip.toBuffer())

    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({
      canceled: false,
      filePaths: [backupPath],
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userData, { recursive: true, force: true })
  })

  it('refuses (status: busy) without closing the DB while a capture is in flight', async () => {
    vi.mocked(captureWorkActive).mockReturnValue(true)

    const result = await invoke('backup:import')

    expect(result).toEqual({ status: 'busy' })
    // The destructive path was never entered, and no dirty-row flush was forced.
    expect(closeDb).not.toHaveBeenCalled()
    expect(flushNow).not.toHaveBeenCalled()
    // The extracted tmp dir is cleaned up so a refused import leaves no residue.
    expect(existsSync(join(userData, 'import-tmp'))).toBe(false)
  })

  it('flushes pending dirty rows to the cloud BEFORE closing the DB when idle', async () => {
    // Abort at closeDb so we prove the ordering without performing the real swap/relaunch.
    vi.mocked(closeDb).mockImplementation(() => {
      throw new Error('__STOP_BEFORE_SWAP__')
    })

    await expect(invoke('backup:import')).rejects.toThrow('__STOP_BEFORE_SWAP__')

    expect(flushNow).toHaveBeenCalledOnce()
    expect(closeDb).toHaveBeenCalledOnce()
    // flushNow was awaited before closeDb was reached.
    expect(vi.mocked(flushNow).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(closeDb).mock.invocationCallOrder[0],
    )
  })
})
