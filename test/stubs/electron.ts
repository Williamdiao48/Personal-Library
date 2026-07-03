// Minimal Electron stub for unit tests (wired via vitest.config.ts alias).
// Only the surface the code under test actually touches is stubbed.

export const app = {
  getPath(name: string): string {
    // Deterministic, absolute fake paths so path-resolution logic is testable
    // without a real Electron runtime.
    if (name === 'userData') return '/tmp/pl-test-userdata'
    return `/tmp/pl-test-${name}`
  },
}
