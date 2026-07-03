import { defineConfig } from '@playwright/test'

// E2E tests drive the built Electron app (out/main/index.js), so `npm run build`
// (and the Electron-ABI better-sqlite3) must be in place first. Serial + single
// worker: these launch a real app instance and touch an isolated userData dir.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
})
