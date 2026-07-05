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
      ],
      // Floors ratcheted to just under the achieved numbers so any coverage
      // regression fails CI. Bumped after Tier-5 Batch D (HtmlReader, EpubReader,
      // PdfReader engines) landed (achieved: stmts/lines 74.74, funcs 68.13,
      // branches 81.52). Functions stays at 68 because rendering the big reader
      // engines instruments many nested handlers the canvas/pdfjs paths never
      // reach under jsdom (the V8 all:true gotcha), so the func denominator is
      // large. Only ever raise these — never lower to make a change pass.
      thresholds: {
        lines: 74,
        functions: 68,
        branches: 81,
        statements: 74,
      },
    },
  },
})
