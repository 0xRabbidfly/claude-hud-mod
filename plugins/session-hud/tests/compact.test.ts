import { expect, test } from 'claude-code/testing'

const SUMMARY = [{ role: 'user' as const, text: 'summary of the session', toolUses: [] }]

import { COMPACT_BRIEF, adviceFor, compactInstructions, compactPoint, configuredCompactWindow, isBreakpoint, zoneOf } from '../hooks/compact'

test("the compaction point follows the session's own rules: the engine's threshold, its window, then the settings", () => {
  const on = { isAutoCompactEnabled: true, rawMaxTokens: 400_000, autocompactSource: 'settings' }
  // the engine's own threshold wins
  expect(compactPoint({ ...on, autoCompactThreshold: 387_000 }, 500_000)).toBe(387_000)
  // without one, the compaction window the breakdown measured against, when one was set
  expect(compactPoint(on, 500_000)).toBe(400_000)
  // the model's own limit is no compaction window: the settings say where
  expect(compactPoint({ ...on, rawMaxTokens: 1_000_000, autocompactSource: 'auto' }, 400_000)).toBe(400_000)
  expect(compactPoint({ ...on, rawMaxTokens: 0 }, undefined)).toBeUndefined()
  // no breakdown yet: the settings alone
  expect(compactPoint(undefined, 400_000)).toBe(400_000)
  expect(compactPoint(undefined, undefined)).toBeUndefined()
  // auto-compaction off: there is no point, whatever the settings say
  expect(compactPoint({ ...on, isAutoCompactEnabled: false, autoCompactThreshold: 387_000 }, 400_000)).toBeUndefined()
})

test('the configured compaction window: the variable, then the model, then the settings', () => {
  const settings = { autoCompactWindow: 600_000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 400_000 }, 'claude-x': 'junk' } }
  // a 1M model's suffix is not part of its settings key
  expect(configuredCompactWindow(settings, 'claude-opus-5-5[1m]', undefined)).toBe(400_000)
  expect(configuredCompactWindow(settings, 'claude-opus-5-5', ' 300000 ')).toBe(300_000)
  // a model without its own entry, or with a malformed one, takes the settings' own
  expect(configuredCompactWindow(settings, 'claude-sonnet-5-5', undefined)).toBe(600_000)
  expect(configuredCompactWindow(settings, 'claude-x', undefined)).toBe(600_000)
  // only a whole number of tokens above 0 counts
  expect(configuredCompactWindow({ autoCompactWindow: 0 }, 'm', 'lots')).toBeUndefined()
  expect(configuredCompactWindow({ autoCompactWindow: 1.5, modelSettings: null }, 'm', '')).toBeUndefined()
  expect(configuredCompactWindow({}, 'm', undefined)).toBeUndefined()
})

test('context zones go by absolute tokens on a 1M window', () => {
  expect(zoneOf(150_000, 1_000_000).zone).toBe('green')
  expect(zoneOf(250_000, 1_000_000).zone).toBe('amber')
  expect(zoneOf(420_000, 1_000_000).zone).toBe('red')
  expect(zoneOf(undefined, 1_000_000).zone).toBe('green')
})

test('a smaller window or an earlier auto-compact point pulls the lines in', () => {
  const small = zoneOf(120_000, 200_000)
  expect(small.redAt).toBe(150_000)
  expect(small.zone).toBe('amber')
  const early = zoneOf(330_000, 1_000_000, 360_000)
  expect(early.redAt).toBe(324_000)
  expect(early.zone).toBe('red')
})

test('a natural break needs an idle, clean finish and settled work', () => {
  const calm = { isRunning: false, hadErrors: false, isTreeClean: false, committedRecently: true }
  expect(isBreakpoint(calm)).toBe(true)
  expect(isBreakpoint({ ...calm, isRunning: true })).toBe(false)
  expect(isBreakpoint({ ...calm, hadErrors: true })).toBe(false)
  expect(isBreakpoint({ ...calm, committedRecently: false })).toBe(false)
})

test('advice fits on one line beside ARIA', () => {
  for (const [zone, atBreak] of [
    ['red', false],
    ['amber', true],
    ['amber', false],
  ] as const) {
    const advice = adviceFor(zone, atBreak, 999_000)
    expect(advice).toBeDefined()
    expect(advice!.text.length).toBeLessThanOrEqual(26)
  }
  expect(adviceFor('green', true, 10)).toBeUndefined()
})

test('the person’s own /compact words lead the standing keep-list', () => {
  expect(compactInstructions(undefined)).toBe(COMPACT_BRIEF)
  expect(compactInstructions('  keep the auth plan ')).toBe(`The user asked specifically: keep the auth plan\n\n${COMPACT_BRIEF}`)
})

test('a compaction gets the keep-list, with the person’s own words first', async ($, on) => {
  // The re-check note the mod appends afterwards goes straight to the engine, below anything a
  // test can stand in for; it is verified in a live headless session instead.
  let summarizerWasTold = ''
  on('session.compact', (_$, e) => {
    summarizerWasTold = e.instructions ?? ''
    return { messages: SUMMARY }
  })

  await $.session.compact({ trigger: 'manual', instructions: 'keep the auth plan', messages: SUMMARY })

  expect(summarizerWasTold.startsWith('The user asked specifically: keep the auth plan')).toBe(true)
  expect(summarizerWasTold).toContain('Decisions made and WHY')
})

test('a typed /compact carries the keep-list itself, for where an organization keeps session.compact from the plugin', async ($, on) => {
  // no session.compact reaches the plugin here: the engine's /compact is the command alone
  const told: string[] = []
  on('command.run', (_$, e) => {
    told.push(e.args)
    return { text: '' }
  })
  on('session.messages', () => ({ value: [] }))
  const typed = (args: string) => $.command.run({ command: 'compact', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

  await typed('keep the auth plan')
  await typed('')
  expect(told[0]?.startsWith('The user asked specifically: keep the auth plan')).toBe(true)
  expect(told[0]).toContain('Decisions made and WHY')
  expect(told[1]).toBe(COMPACT_BRIEF)
})

test('a precomputed summary is briefed too', async ($, on) => {
  let summarizerWasTold = ''
  const appended: string[] = []
  on('session.compact', (_$, e) => {
    summarizerWasTold = e.instructions ?? ''
    return { messages: SUMMARY }
  })
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY })

  expect(summarizerWasTold).toBe(COMPACT_BRIEF)
  expect(appended).toEqual([])
})
