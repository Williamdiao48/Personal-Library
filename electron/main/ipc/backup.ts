import { ipcMain, app, dialog } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, cpSync, rmSync, renameSync } from 'fs'
import AdmZip from 'adm-zip'
import { get, closeDb } from '../db'

export function registerBackupHandlers(): void {

  // ── backup:export ────────────────────────────────────────────────────────
  ipcMain.handle('backup:export', async () => {
    const userData    = app.getPath('userData')
    const dbPath      = join(userData, 'library.db')
    const contentDir  = join(userData, 'content')

    // Ask user where to save
    const today = new Date().toISOString().slice(0, 10)
    const { filePath, canceled } = await dialog.showSaveDialog({
      title:       'Export Library',
      defaultPath: `personal-library-${today}.plbackup`,
      filters:     [{ name: 'Personal Library Backup', extensions: ['plbackup'] }],
    })
    if (canceled || !filePath) return null

    // Flush WAL into the main DB file so the copy is self-contained
    const db = (await import('../db')).getDb()
    db.pragma('wal_checkpoint(TRUNCATE)')

    // Count items for manifest
    const row = get<{ n: number }>('SELECT COUNT(*) AS n FROM items')
    const itemCount = row?.n ?? 0

    // Build content file count
    let contentFileCount = 0
    if (existsSync(contentDir)) {
      const { readdirSync } = await import('fs')
      contentFileCount = readdirSync(contentDir).length
    }

    // Build ZIP
    const zip = new AdmZip()

    const manifest = JSON.stringify({
      version:          1,
      exportedAt:       new Date().toISOString(),
      itemCount,
      contentFileCount,
    })
    zip.addFile('manifest.json', Buffer.from(manifest, 'utf8'))
    zip.addLocalFile(dbPath)
    if (existsSync(contentDir)) {
      zip.addLocalFolder(contentDir, 'content')
    }

    zip.writeZip(filePath)

    const { statSync } = await import('fs')
    const fileSizeBytes = statSync(filePath).size

    return { path: filePath, itemCount, fileSizeBytes }
  })

  // ── backup:import ────────────────────────────────────────────────────────
  ipcMain.handle('backup:import', async () => {
    const userData   = app.getPath('userData')
    const dbPath     = join(userData, 'library.db')
    const contentDir = join(userData, 'content')
    const tmpDir     = join(userData, 'import-tmp')

    // Ask user to pick a backup file
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title:      'Import Library',
      filters:    [{ name: 'Personal Library Backup', extensions: ['plbackup', 'zip'] }],
      properties: ['openFile'],
    })
    if (canceled || filePaths.length === 0) return

    const backupPath = filePaths[0]

    // Validate the ZIP contains library.db
    const zip = new AdmZip(backupPath)
    const entries = zip.getEntries().map(e => e.entryName)
    if (!entries.includes('library.db')) {
      throw new Error('Invalid backup file: library.db not found in archive.')
    }

    // Extract to import-tmp (keeps original intact while we validate)
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
    zip.extractAllTo(tmpDir, true)

    const tmpDbPath = join(tmpDir, 'library.db')

    // Validate the extracted DB
    let testDb: import('better-sqlite3').Database | undefined
    try {
      const Database = (await import('better-sqlite3')).default
      testDb = new Database(tmpDbPath, { readonly: true })
      const result = testDb.pragma('integrity_check', { simple: true })
      if (result !== 'ok') throw new Error(`Integrity check failed: ${result}`)
    } finally {
      testDb?.close()
    }

    // Close the live DB before overwriting
    closeDb()

    // Overwrite current data
    cpSync(tmpDbPath, dbPath, { force: true })

    if (existsSync(contentDir)) rmSync(contentDir, { recursive: true, force: true })

    const tmpContentDir = join(tmpDir, 'content')
    if (existsSync(tmpContentDir)) {
      renameSync(tmpContentDir, contentDir)
    } else {
      mkdirSync(contentDir, { recursive: true })
    }

    rmSync(tmpDir, { recursive: true, force: true })

    // Relaunch so the app reinitialises the DB connection and React state
    app.relaunch()
    app.exit(0)
  })
}
