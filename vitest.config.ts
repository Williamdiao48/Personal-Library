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
      // LibraryView, IPC-handler (capture/library/backup), and security/dictionary/
      // site-parser + llm-IPC batches — combined achieved: stmts/lines 87.22, funcs
      // 80.97, branches 85.44. Stmts/lines/branches are kept ~1pt back to absorb the
      // ~0.5pt run-to-run fluctuation V8 all:true shows; the functions floor stays
      // lowest because rendering the big reader engines instruments many nested
      // handlers the canvas/pdfjs paths never reach under jsdom (the all:true gotcha),
      // so the func denominator is large. Only ever raise these — never lower.
      thresholds: {
        lines: 86,
        functions: 80,
        branches: 84,
        statements: 86,
      },
    },
  },
})
