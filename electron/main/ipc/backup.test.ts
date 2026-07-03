import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import AdmZip from 'adm-zip'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { invoke, resetIpc, dialog } from '../../../test/stubs/electron'
import { registerBackupHandlers } from './backup'

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
