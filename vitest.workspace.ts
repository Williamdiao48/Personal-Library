import { defineWorkspace } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Two test projects with different environments:
//   • main     — Electron main-process logic (node env). `electron` is aliased to
//                a stub so pure helpers that touch app.getPath/ipcMain are testable
//                without a real Electron runtime.
//   • renderer — React components/hooks/services (jsdom env) with Testing Library.
// Coverage and reporters live in the root vitest.config.ts (coverage cannot be set
// per-project).
const electronAlias = { electron: resolve(__dirname, 'test/stubs/electron.ts') }

export default defineWorkspace([
  {
    resolve: { alias: electronAlias },
    test: {
      name: 'main',
      environment: 'node',
      include: ['electron/**/*.test.ts'],
    },
  },
  {
    plugins: [react()],
    resolve: { alias: electronAlias },
    test: {
      name: 'renderer',
      environment: 'jsdom',
      globals: true,
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./test/renderer/setup.ts'],
    },
  },
])
