import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Unit tests for main-process logic. The security helpers keep their pure core
// (resolveWithin) Electron-independent; the thin wrappers touch `app.getPath`,
// so we alias `electron` to a minimal stub for tests that exercise them.
export default defineConfig({
  test: {
    include: ['electron/**/*.test.ts', 'src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      electron: resolve(__dirname, 'test/stubs/electron.ts'),
    },
  },
})
