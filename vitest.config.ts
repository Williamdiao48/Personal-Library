import { defineConfig } from 'vitest/config'

// Root config holds the coverage + reporter settings shared by every project.
// The projects themselves (main/node, renderer/jsdom) are defined in
// vitest.workspace.ts. Coverage options are intentionally here because Vitest
// does not allow them to be configured per workspace project.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Honest denominator: every source file counts, even ones no test imports
      // yet (v8 `all` is on by default), so the number reflects real coverage and
      // can be ratcheted upward as suites land.
      include: ['electron/**/*.ts', 'src/**/*.{ts,tsx}'],
      exclude: [
        'test/**',
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        '**/*.config.*',
        // Composition/entry roots and generated code — not meaningfully unit-testable.
        'electron/main/index.ts',
        'electron/preload/index.ts',
        'src/main.tsx',
        'src/App.tsx',
        'src/vite-env.d.ts',
        'src/polyfills/**',
        'src/workers/**',
        // Opt-in dev-only stage-timing instrumentation (DISCOVER_TIMING=1; silent by
        // default and under Vitest). A logging helper, not a unit-test target — excluded
        // so it doesn't drag the denominator.
        'electron/main/recommender/timing.ts',
      ],
      // Floors ratcheted to just under the achieved numbers so any coverage
      // regression fails CI. Raised across the recommender/services, CollectionView,
      // LibraryView, and IPC-handler (capture/library/backup) test batches — achieved:
      // stmts/lines 86.46, funcs 80.69, branches 85.24. Stmts/lines/branches are kept a
      // point back to absorb the ~0.5pt run-to-run fluctuation V8 all:true shows; the
      // functions floor sits at 80 (the IPC batch was line-heavy — few large handlers —
      // so funcs barely moved). Functions stays lowest overall because rendering the big
      // reader engines instruments many nested handlers the canvas/pdfjs paths never
      // reach under jsdom (the all:true gotcha). Only ever raise these — never lower.
      thresholds: {
        lines: 85,
        functions: 80,
        branches: 84,
        statements: 85,
      },
    },
  },
})
