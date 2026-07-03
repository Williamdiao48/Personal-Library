import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Boots the built app in a throwaway userData dir. This exercises the whole main
// process end-to-end — window creation, DB init + migrations, IPC registration —
// on the Electron-ABI native module, which the Node unit tests can't reach.
//
// PREREQ: `npm run build` + Electron-ABI better-sqlite3 (`npm run rebuild:electron`).
// Needs a display (CI runs it under xvfb).

const MAIN = join(__dirname, '..', 'out', 'main', 'index.js')

let app: ElectronApplication
let userDataDir: string

test.beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'pl-e2e-'))
  app = await electron.launch({ args: [MAIN, `--user-data-dir=${userDataDir}`] })
})

test.afterEach(async () => {
  await app?.close()
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

test('app boots and mounts the React shell', async () => {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // React mounts into #root — non-empty content means the renderer booted without
  // a white-screen crash.
  const root = win.locator('#root')
  await expect(root).toBeVisible()
  await expect(root).not.toBeEmpty()
})

test('main process initialized the database without crashing', async () => {
  // If DB init / migrations threw, the main process would have exited before a
  // window appeared. Reaching an evaluated main-process value proves it is alive.
  const isReady = await app.evaluate(async ({ app: electronApp }) => electronApp.isReady())
  expect(isReady).toBe(true)
})
