/**
 * Line and branch coverage for the plugins' pure modules. `claude plugin test` has no coverage
 * option, so the same test files run here under Vitest with V8 coverage: `testing-shim.ts`
 * stands in for the engine's test kit, runs every test that needs no engine, and skips the rest.
 *
 * `npm run coverage` writes the report to `report/` (index.html for people, coverage-summary.json
 * for tools) and fails when any measure falls below 100%. `npm run typecheck` is the other half:
 * Vitest strips types without checking them.
 */
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/** The repository root: tests and sources are found from it, so the plugins need no config of their own. */
const repo = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  root: repo,
  // A plugin's tsconfig extends the types the engine lays down at load time, absent from a
  // fresh checkout, and nothing in it changes how a type is stripped.
  oxc: { tsconfig: false },
  resolve: {
    alias: { 'claude-code/testing': fileURLToPath(new URL('./testing-shim.ts', import.meta.url)) },
  },
  test: {
    include: ['plugins/*/tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['plugins/*/hooks/**/*.{ts,tsx}'],
      // register.tsx is the hooks module itself: only the engine can load it, so
      // `claude plugin test` exercises it and no line count is possible here.
      exclude: ['plugins/*/hooks/register.tsx'],
      reporter: ['text', 'html', 'json-summary'],
      // Every line and branch of the pure modules is tested: a change that leaves one untested fails the run.
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
      reportsDirectory: fileURLToPath(new URL('./report', import.meta.url)),
    },
  },
})
