import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

// Flat config (ESLint 9). Correctness-focused: typescript-eslint recommended +
// react-hooks rules. Formatting is delegated to Prettier via eslint-config-prettier
// (must stay LAST so it disables any stylistic rules that would conflict).
export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      '**/*.tsbuildinfo',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Renderer (browser globals + React).
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // New JSX transform — React needn't be in scope.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },

  // Main process + preload + tests (node globals).
  {
    files: ['electron/**/*.ts', 'test/**/*.ts', 'e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Pragmatic relaxations for a solo project — keep the linter useful, not noisy.
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // The app deliberately uses `catch {}` for best-effort cleanup (file unlink,
      // FTS optimize, etc.) where a failure is non-fatal and nothing to handle.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Idiomatic `cond && sideEffect()` / ternary-for-effect are intentional.
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true },
      ],
    },
  },

  // eslint-config-prettier last: turns off rules that fight the formatter.
  prettier,
)
