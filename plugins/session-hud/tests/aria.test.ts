import { expect, test } from 'claude-code/testing'

import type { HudSample } from '../types'
import { ARIA_COLUMNS, ARIA_ROWS, ariaCells, limitForecast, moodOf, trendCells, turnsToCompact } from '../hooks/aria'

const MIN = 60_000
const cellsLength = (cells: number) => Math.ceil((cells * 12) / 3) * 4

const turns = (...ctx: number[]): HudSample[] => ctx.map((c, i) => ({ t: i * MIN, ctx: c, isTurn: true }))

test('runway divides the distance to 90% by the recent per-turn growth', () => {
  expect(turnsToCompact(turns(10, 20, 30))).toBe(6)
  expect(turnsToCompact(turns(95))).toBe(0)
  expect(turnsToCompact(turns(40))).toBeUndefined()
})

test('a compaction (context dropping) does not count as negative growth', () => {
  expect(turnsToCompact(turns(60, 70, 15, 25))).toBe(7)
})

test('5-hour forecast extrapolates the recent pace and respects the reset', () => {
  const now = 100 * MIN
  const pace = [
    { t: now - 60 * MIN, five: 40, isTurn: true },
    { t: now, five: 70, isTurn: true },
  ]
  const hits = limitForecast(pace, now)
  expect(hits.kind).toBe('hits')
  if (hits.kind === 'hits') expect(Math.round(hits.ms / MIN)).toBe(60)
  expect(limitForecast(pace, now, now + 30 * MIN).kind).toBe('safe')
  expect(limitForecast([{ t: now, five: 70, isTurn: true }], now).kind).toBe('learning')
  expect(limitForecast([{ ...pace[0]!, five: 70 }, pace[1]!], now).kind).toBe('steady')
})

test('mood follows the worst signal', () => {
  expect(moodOf(undefined, undefined, undefined, { kind: 'learning' })).toBe('sleep')
  expect(moodOf(20, 10, 30, { kind: 'steady' })).toBe('happy')
  expect(moodOf(55, 10, 30, { kind: 'steady' })).toBe('focus')
  expect(moodOf(20, 10, 2, { kind: 'steady' })).toBe('alarm')
  expect(moodOf(20, 85, 30, { kind: 'steady' })).toBe('alarm')
  expect(moodOf(20, 10, 30, { kind: 'hits', ms: 10 * MIN })).toBe('alarm')
})

test('mascot and trend pack the sizes their Rasters declare', () => {
  for (const mood of ['sleep', 'happy', 'focus', 'alarm'] as const) {
    expect(ariaCells(mood).length).toBe(cellsLength(ARIA_COLUMNS * ARIA_ROWS))
    expect(ariaCells(mood, true).length).toBe(cellsLength(ARIA_COLUMNS * ARIA_ROWS))
  }
  expect(ariaCells('happy', true)).not.toBe(ariaCells('happy'))
  expect(trendCells(turns(10, 50, 90), 20).length).toBe(cellsLength(20 * 2))
})

test('the sidebar draws the mascot on the terminal and her words elsewhere', async $ => {
  const props = {
    title: 'Session',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  } as const
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-hud', surface, component: 'Pane', requestId: 'session-hud', props })
    expect(await ui.find({ type: 'Text', text: 'ARIA' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Napping/ })).toBeDefined()
    const mascot = await ui.find({ key: 'aria' })
    if (surface === 'terminal') expect(mascot?.type).toBe('Raster')
    else expect(mascot).toBeUndefined()
    await ui.unmount()
  }
})

test('runway aims at the session auto-compact point when known', () => {
  expect(turnsToCompact(turns(10, 20, 30), 80)).toBe(5)
})
