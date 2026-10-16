/**
 * Stands in for 'claude-code/testing' under Vitest. A pure test (a body that takes no
 * arguments) runs as-is; a test that takes the engine's `$` and `on` needs the engine
 * itself, so it is skipped here and only `claude plugin test` runs it.
 */
import { expect, test as vitest } from 'vitest'

/** A test body as the kit takes it: no arguments for a pure test, `($, on)` for one that needs the engine. */
type Body = (...args: never[]) => unknown

// The engine's kit is Bun's: these two matchers are its own, not Vitest's.
expect.extend({
  toStartWith: (received: string, prefix: string) => ({
    pass: typeof received === 'string' && received.startsWith(prefix),
    message: () => `expected ${JSON.stringify(received)} to start with ${JSON.stringify(prefix)}`,
  }),
  toEndWith: (received: string, suffix: string) => ({
    pass: typeof received === 'string' && received.endsWith(suffix),
    message: () => `expected ${JSON.stringify(received)} to end with ${JSON.stringify(suffix)}`,
  }),
})

export { expect }

/**
 * The kit's `test(name, body)` and `test(name, { options }, body)`. Which kind a test is comes
 * from the body's declared parameter count: a body that names `$` (or `$, on`) needs the engine,
 * so it is registered as skipped, marked `[engine]` so the report shows why; the coverage it
 * would add belongs to `register.tsx`, which this run does not measure. The kit's `options`
 * (a plugin's `userConfig` values) only reach engine tests, so they are dropped here.
 */
export function test(name: string, optionsOrBody: object | Body, maybeBody?: Body): void {
  const body = (typeof optionsOrBody === 'function' ? optionsOrBody : maybeBody) as Body
  if (body.length > 0) vitest.skip(`${name} [engine]`, () => {})
  else vitest(name, body as () => unknown)
}

/**
 * The kit's `mock` (a mocked clock, store and env) answers engine nouns, so only engine tests use
 * it. Touching any of it from a pure test throws, saying where the test can run, rather than
 * passing on a mock that does nothing.
 */
export const mock = new Proxy(
  {},
  {
    get(_, key) {
      throw new Error(`mock.${String(key)} needs the engine: run this test with claude plugin test`)
    },
  },
)
