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
      // regression fails CI. Bumped after the recommender/services coverage batch
      // (discover service, openLibrary + candidateCache sources, annotationsService,
      // highlightColors, useGridColumns, AnnotationFilterBar) plus excluding the two
      // throwaway Discover diagnostics from the denominator — achieved: stmts/lines
      // 83.05, funcs 76.67, branches 84.12. Functions stays lowest because rendering
      // the big reader engines instruments many nested handlers the canvas/pdfjs
      // paths never reach under jsdom (the V8 all:true gotcha), so the func
      // denominator is large. Only ever raise these — never lower to make a change pass.
      thresholds: {
        lines: 82,
        functions: 76,
        branches: 83,
        statements: 82,
      },
    },
  },
})
