import { expect, mock, test } from 'claude-code/testing'

import type { HudProc } from '../types'
import {
  addSkillTokens,
  cacheHit,
  cacheTotals,
  cacheWarmth,
  estimateTokens,
  iceCells,
  prefixChange,
  prefixOf,
  quietSkills,
  quietSpan,
  recordSkill,
  sessionEntryIn,
  skillGroups,
  skillShortName,
} from '../hooks/panels'
import { buildProcs, canEnd, fromCache, isStale, parseWindowsScan, procState, selfOf, tidyCommand, toCache } from '../hooks/procs'
import type { TreeNode } from '../hooks/procs'

const MIN = 60_000
const cellsLength = (cells: number) => Math.ceil((cells * 12) / 3) * 4

// ---------------------------------------------------------------- cache

const turnOf = (at: number, read: number, write: number, fresh: number) => ({
  at,
  ...cacheHit({ input_tokens: fresh, cache_read_input_tokens: read, cache_creation_input_tokens: write }),
})

test('cache hit and warmth', () => {
  const first = cacheHit({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 })
  expect(first.hit).toBe(0.9)
  expect([first.read, first.write, first.fresh]).toEqual([90, 0, 10])
  const turns = [turnOf(0, 380_000, 20_000, 0), turnOf(10 * MIN, 40_000, 0, 360_000)]
  expect(cacheWarmth(turns, 40 * MIN, 60 * MIN)).toBe(0.5)
  expect(cacheWarmth(turns, 200 * MIN, 60 * MIN)).toBe(0)
})

test('a session is billed a tenth for reads, double for writes and full price for the rest', () => {
  // One reply that filled the cache, then nine that read it back.
  const turns = [turnOf(0, 0, 100_000, 0), ...Array.from({ length: 9 }, (_, i) => turnOf((i + 1) * MIN, 100_000, 0, 2_000))]
  const totals = cacheTotals(turns)
  expect([totals.read, totals.write, totals.fresh]).toEqual([900_000, 100_000, 18_000])
  // 900k x 0.1 + 100k x 2 + 18k = 308k billed against 1,018k uncached.
  expect(totals.billed).toBe(308_000)
  expect(totals.uncached).toBe(1_018_000)
  expect(Number(totals.ratio.toFixed(2))).toBe(0.3)
  // The first reply alone costs more than it saves: that is the write premium, visible.
  expect(cacheTotals(turns.slice(0, 1)).ratio).toBe(2)
})

test('only the three things above the cache boundary count as a change', () => {
  const base = prefixOf('claude-opus-5', ['Read', 'Bash'], [{ id: 'intro', text: 'hello' }])
  // Tool order is not a change; the set is.
  expect(prefixChange(base, prefixOf('claude-opus-5', ['Bash', 'Read'], [{ id: 'intro', text: 'hello' }]))).toBeUndefined()
  expect(prefixChange(base, prefixOf('claude-opus-5', ['Read', 'Bash', 'Edit'], [{ id: 'intro', text: 'hello' }]))).toBe('the tool list changed')
  expect(prefixChange(base, prefixOf('claude-opus-5', ['Read', 'Bash'], [{ id: 'intro', text: 'bye' }]))).toBe('the system prompt changed')
  // A section keeping its text under a new id still changes the prompt.
  expect(prefixChange(base, prefixOf('claude-opus-5', ['Read', 'Bash'], [{ id: 'other', text: 'hello' }]))).toBe('the system prompt changed')
  expect(prefixChange(base, prefixOf('claude-sonnet-5-5', ['Read', 'Bash'], [{ id: 'intro', text: 'hello' }]))).toBe('the model changed')
  expect(prefixChange(base, prefixOf('claude-sonnet-5-5', ['Edit'], [{ id: 'intro', text: 'bye' }]))).toBe(
    'the model, the tool list and the system prompt changed',
  )
})

// ---------------------------------------------------------------- drawings

test('the ice cube packs the size its Raster declares', () => {
  for (const warmth of [1, 0.5, 0.1, 0]) expect(iceCells(warmth).length).toBe(cellsLength(10 * 5))
})

// ---------------------------------------------------------------- skills

const NO_SKILLS = { fired: [], chain: [], seen: {}, since: 0 }

test('a fire adds up per skill: count, tokens, who fired it, the chain and when it was seen', () => {
  expect(skillShortName('superpowers:brainstorming')).toBe('brainstorming')
  expect(skillShortName('commit')).toBe('commit')
  expect(estimateTokens('a'.repeat(9))).toBe(3)
  let skills = recordSkill(NO_SKILLS, 'a:plan', 100, 'claude', 1_000)
  // the record begins with its first fire
  expect(skills.since).toBe(1_000)
  skills = recordSkill(skills, 'b', 50, 'you', 2_000)
  skills = recordSkill(skills, 'a:plan', 20, 'claude', 3_000)
  expect(skills.fired).toEqual([
    { name: 'a:plan', count: 2, tokens: 120, by: 'claude', at: 3_000 },
    { name: 'b', count: 1, tokens: 50, by: 'you', at: 2_000 },
  ])
  // once both of you have fired it, it is both, and stays so
  skills = recordSkill(skills, 'b', 1, 'claude', 4_000)
  skills = recordSkill(skills, 'b', 1, 'you', 5_000)
  expect(skills.fired[1]?.by).toBe('both')
  // a repeat in a row is one link of the chain
  expect(skills.chain).toEqual(['a:plan', 'b', 'a:plan', 'b'])
  expect(skills.seen).toEqual({ 'a:plan': 3_000, b: 5_000 })
  expect(skills.since).toBe(1_000)
  // the chain keeps the last eight
  for (let i = 0; i < 10; i++) skills = recordSkill(skills, `s${i}`, 1, 'you', 6_000 + i)
  expect(skills.chain).toEqual(['s2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'])
})

test("a prompt's tokens join the fire already counted for it, by full or short name, and nothing else", () => {
  const skills = recordSkill(recordSkill(NO_SKILLS, 'superpowers:plan', 0, 'claude', 1_000), 'b', 5, 'you', 2_000)
  const added = addSkillTokens(skills, 'plan', 300)
  expect(added.fired).toEqual([
    { name: 'superpowers:plan', count: 1, tokens: 300, by: 'claude', at: 1_000 },
    { name: 'b', count: 1, tokens: 5, by: 'you', at: 2_000 },
  ])
  expect(addSkillTokens(added, 'b', 1).fired[1]?.tokens).toBe(6)
  // no fire of that name: the record comes back as it was
  expect(addSkillTokens(skills, 'missing', 9)).toBe(skills)
})

test('the listing is paid for by plugin, or by where a skill came from', () => {
  const list = [
    { name: 'a', source: 'plugin', plugin: 'superpowers', tokens: 300 },
    { name: 'b', source: 'plugin', plugin: 'superpowers', tokens: 200 },
    { name: 'c', source: 'userSettings', tokens: 500 },
    { name: 'd', source: 'built-in', tokens: 40 },
    { name: 'e', source: 'projectSettings', tokens: 40 },
  ]
  expect(skillGroups(list)).toEqual([
    { name: 'superpowers', count: 2, tokens: 500 },
    { name: 'user', count: 1, tokens: 500 },
    { name: 'built-in', count: 1, tokens: 40 },
    { name: 'project', count: 1, tokens: 40 },
  ])
  // a tie goes by name, whichever came first
  expect(skillGroups([...list].reverse()).map(g => g.name)).toEqual(['superpowers', 'user', 'built-in', 'project'])
  expect(skillGroups([])).toEqual([])
})

test('a skill is quiet when it has not fired in thirty days, or since the record began', () => {
  const DAY = 24 * 60 * MIN
  const now = Date.parse('2026-10-10T12:00:00.000Z')
  const list = ['old', 'recent', 'never'].map(name => ({ name, source: 'userSettings', tokens: 10 }))
  const skills = { ...NO_SKILLS, seen: { old: now - 31 * DAY, recent: now - 2 * DAY }, since: now - 40 * DAY }
  expect(quietSkills(list, skills, now)).toEqual(['old', 'never'])
  expect(quietSpan(now - 40 * DAY, now)).toBe('in 30 days')
  expect(quietSpan(Date.parse('2026-10-03T08:00:00.000Z'), now)).toBe('since Oct 3')
  // a record not begun yet begins now
  expect(quietSpan(0, now)).toBe('since Oct 10')
})

// ---------------------------------------------------------------- processes

const tree = (...nodes: Array<[number, number, string]>): Map<number, TreeNode> =>
  new Map(nodes.map(([pid, ppid, name]) => [pid, { pid, ppid, start: 1, name }]))

test('process ownership: this session, terminal tabs, daemon, and broken chains', () => {
  const t = tree(
    [1000, 4, 'explorer.exe'],
    [1100, 1000, 'herdr.exe'],
    [1200, 1100, 'powershell.exe'],
    [1300, 1200, 'claude.exe'], // another herdr tab
    [1400, 1300, 'node.exe'], //   its mcp server
    [2000, 999, 'claude.exe'], //  the daemon, parent gone
    [2100, 2000, 'claude.exe'], // a background session
    [3000, 998, 'bash.exe'], //    a shell whose launcher exited
    [3100, 3000, 'node.exe'], //   a dev server under it
    [5000, 1300, 'powershell.exe'], // the scanner, under "this session" (1300 here)
  )
  const self = new Set([5000, 1300])
  const hosts = new Set([2000])
  expect(procState(1400, t, self, hosts)).toBe('mine')
  expect(procState(1400, t, new Set([5000]), hosts)).toBe('protected')
  expect(procState(2100, t, self, hosts)).toBe('owned')
  expect(procState(3100, t, self, hosts)).toBe('unowned')
})

test('only unowned processes idle for 30 minutes are stale, and terminal tabs can never be ended', () => {
  const base: HudProc = {
    pid: 2,
    name: 'node',
    startedAt: 0,
    memMb: 10,
    cpuSec: 1,
    activeAt: 0,
    state: 'unowned',
    kind: '',
    command: '',
  }
  expect(isStale(base, 31 * MIN)).toBe(true)
  expect(isStale(base, 10 * MIN)).toBe(false)
  expect(isStale({ ...base, state: 'protected' }, 300 * MIN)).toBe(false)
  expect(canEnd({ ...base, state: 'protected' })).toBe(false)
  expect(canEnd({ ...base, state: 'mine' })).toBe(false)
  expect(canEnd({ ...base, state: 'owned' })).toBe(true)
})

test('the Windows scan parses, folds desktop helpers away and keeps CPU history', () => {
  const rows = [
    { pid: 10, name: 'claude.exe', start: 1, mem: 100, cpu: 5, cmd: 'claude.exe' },
    { pid: 11, name: 'claude.exe', start: 1, mem: 50, cpu: 1, cmd: 'claude.exe --type=renderer' },
    { pid: 20, name: 'node.exe', start: 1, mem: 30, cpu: 2, cmd: 'node server.js' },
  ]
  const stdout = [
    '@@ROWS@@' + JSON.stringify(rows),
    '@@TREE@@10:999:1:claude.exe|11:10:1:claude.exe|20:10:1:node.exe|77:5:1:powershell.exe',
    '@@CHAIN@@77,5',
  ].join('\n')
  const scan = parseWindowsScan(stdout)
  const first = buildProcs(scan, [], 1_000, 1_000)
  expect(first.map(p => p.pid)).toEqual([10, 20])
  expect(first.find(p => p.pid === 10)?.kind).toBe('desktop app')
  expect(first.find(p => p.pid === 20)?.state).toBe('owned')
  const later = buildProcs(scan, first, 1_000 + 40 * MIN, 1_000)
  expect(later.find(p => p.pid === 20)?.activeAt).toBe(1_000)
})

test('command lines lose their paths and anything that looks like a credential', () => {
  expect(tidyCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\x\\npx-cli.js" -y @playwright/mcp')).toBe(
    'node.exe npx-cli.js -y @playwright/mcp',
  )
  expect(tidyCommand('node app.js --token abc123 API_KEY=s3cret')).toBe('node app.js --token *** API_KEY=***')
})

test('credentials are hidden in every common shape', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['node server.js https://user:hunter2@db.internal', 'hunter2'],
    ['node mcp.js sk-ant-api03-ABCDEFGHIJ', 'sk-ant-api03-ABCDEFGHIJ'],
    ['node mcp.js ghp_abcdefghijklmnopqrstu', 'ghp_abcdefghijklmnopqrstu'],
    ['node x.js --client_secret abc123', 'abc123'],
    ['node x.js --api-key "two words"', 'two words'],
    ['set github_token=s3cretvalue && node a.js', 's3cretvalue'],
    ['node fetch.js -H "Authorization: Bearer abc123secret"', 'abc123secret'],
    ['node x.js DB_CONNECTION_STRING=Server=db;Password=p4ss', 'p4ss'],
  ]
  for (const [raw, secret] of cases) expect(tidyCommand(raw)).not.toContain(secret)
  expect(tidyCommand('node server.js https://user:hunter2@db.internal')).toBe('node server.js https://***@db.internal')
  expect(tidyCommand('node x.js --client_secret abc123')).toBe('node x.js --client_secret ***')
})

test('words that merely contain a credential name are left alone', () => {
  expect(tidyCommand('node monkey.js --keyboard --author me')).toBe('node monkey.js --keyboard --author me')
  expect(tidyCommand('node next dev --port 3000')).toBe('node next dev --port 3000')
})

test('bearer tokens and passwords in URLs never reach the shared scan', () => {
  expect(tidyCommand('node s.js -H "Authorization: Bearer sk-abc123"')).toBe('node s.js -H Authorization: Bearer ***')
  expect(tidyCommand('node s.js --header=Authorization:Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz')
  expect(tidyCommand('node app.js --db postgres://admin:hunter2@db.local:5432')).toBe(
    'node app.js --db postgres://***@db.local:5432',
  )
  expect(tidyCommand('node sync.js https://bob:ghp_tok@github.com')).toBe('node sync.js https://***@github.com')
  expect(tidyCommand('node sync.js https://ghp_tok@github.com/org/repo.git')).not.toContain('ghp_tok')
  expect(tidyCommand('node sync.js https://glpat-abcdef123@gitlab.example.com')).toBe('node sync.js https://***@gitlab.example.com')
  expect(tidyCommand('node fetch.js -H "authorization: bearer abcdefgh1234"')).not.toContain('abcdefgh1234')
})

test('a very long argument is tidied in linear time', () => {
  for (const arg of ['a_'.repeat(20_000), `--${'a-'.repeat(20_000)}`, 'A_'.repeat(20_000), '/a'.repeat(20_000)]) {
    const started = performance.now()
    tidyCommand(`node ${arg}x`)
    expect(performance.now() - started).toBeLessThan(100)
  }
})

const PANE_PROPS = {
  title: 'Session',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

test('the tab buttons switch the sidebar between panels: boxes, a departures board and the line', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-hud', surface, component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
    // five tabs: Gates is gone, and Cache and Flight are one tab, Turn
    expect(await ui.find({ key: 'tab-gates' })).toBeUndefined()
    expect(await ui.find({ key: 'tab-flight' })).toBeUndefined()
    expect(await ui.find({ key: 'tab-cache' })).toBeUndefined()
    for (const [key, heading] of [
      ['tab-turn', 'CACHE'],
      ['tab-commits', 'COMMITS'],
      ['tab-procs', 'PROCS'],
      ['tab-skills', 'SKILLS'],
    ] as const) {
      await ui.press({ key })
      // the heading opens the box, a line runs down its left edge, and a corner closes it
      expect(await ui.find({ type: 'Text', text: new RegExp(`^╭─ ${heading}`) })).toBeDefined()
      expect((await ui.findAll({ type: 'Box' })).some(b => b.props.position === 'relative' && b.props.overflow === 'hidden')).toBe(true)
      expect(await ui.find({ type: 'Text', text: /^╰─$/ })).toBeDefined()
    }
    // the Turn tab opens with the departures board, the cache's boxes under it
    await ui.press({ key: 'tab-turn' })
    expect(await ui.find({ type: 'Text', text: /^DEPARTURES/ })).toBeDefined()
    await ui.press({ key: 'tab-hub' })
    expect(await ui.find({ key: 'curl-track' })).toBeDefined()
    await ui.unmount()
  }
})

test('the Turn tab shows what the last reply paid for, and what the cache took off the bill', async ($, on) => {
  const now = Date.parse('2026-10-04T12:00:00.000Z')
  mock.clock(on, { now })
  const turns = [turnOf(now - 20 * MIN, 0, 100_000, 0), turnOf(now - 5 * MIN, 300_000, 2_000, 1_000)]
  on('state.get', ($, e, next) => {
    if (e.key === 'cache') return { value: { value: turns, version: 1 } }
    if (e.key === 'now') return { value: { value: now, version: 1 } }
    if (e.key === 'prefix') {
      return { value: { value: { reason: 'the tool list changed', at: now - 2 * MIN, isPending: true }, version: 1 } }
    }
    if (e.key === 'usage') return { value: { value: { window: 1_000_000, limits: [], tokens: 640_000 }, version: 1 } }

    return next(e)
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  await ui.press({ key: 'tab-turn' })

  // three rows: how long it stays warm, what the last reply took from it, what it took off the bill
  expect(await ui.find({ type: 'Text', text: 'warm · cold in 55m' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'last reply · 99% of 303k from cache' })).toBeDefined()
  // 300k read x 0.1 + 102k write x 2 + 1k fresh = 235k billed against 403k uncached.
  expect(await ui.find({ type: 'Text', text: 'session · 42% off the input bill' })).toBeDefined()
  // and, while one is due, the re-cache a change forced
  expect(await ui.find({ type: 'Text', text: 'the tool list changed: next reply re-caches 640k at ×2' })).toBeDefined()
  // the input split, the hits strip and the break count are gone
  for (const gone of ['×0.1', 'hits ', 'breaks:', 'holding']) expect(await ui.find({ type: 'Text', text: gone })).toBeUndefined()
  await ui.unmount()
})

test('a reply running for over an hour keeps the cache warm: its requests refresh it, though none has finished', async ($, on) => {
  const now = Date.parse('2026-10-04T12:00:00.000Z')
  mock.clock(on, { now })
  const turns = [turnOf(now - 90 * MIN, 300_000, 2_000, 1_000)]
  on('state.get', ($, e, next) => {
    if (e.key === 'cache') return { value: { value: turns, version: 1 } }
    if (e.key === 'now') return { value: { value: now, version: 1 } }
    if (e.key === 'flight') return { value: { value: { turnId: 't', startedAt: now - 80 * MIN, calls: [] }, version: 1 } }
    return next(e)
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  await ui.press({ key: 'tab-turn' })
  expect(await ui.find({ type: 'Text', text: /^99% ❄ live │/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'warm · kept warm by the reply' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /cold/ })).toBeUndefined()
  await ui.unmount()
})

test('the Turn tab opens with a departures board: each call boards, arrives, is delayed or cancelled', async ($, on) => {
  const now = Date.parse('2026-10-04T12:00:00.000Z')
  mock.clock(on, { now })
  const calls = [
    { id: 'a', tool: 'Bash', label: 'plugin test', start: now - 70_000, end: now - 69_200, isError: false },
    { id: 'b', tool: 'Edit', label: 'register.tsx', start: now - 60_000, end: now - 59_000, isError: true },
    { id: 'c', tool: 'Bash', label: 'git push', start: now - 50_000, end: now - 37_600, isError: false },
    { id: 'd', tool: 'Bash', label: 'npm run coverage and then some more words', start: now - 5_000, isError: false },
  ]
  on('state.get', ($, e, next) => {
    if (e.key === 'flight') return { value: { value: { turnId: 't', startedAt: now - 72_000, calls }, version: 1 } }
    if (e.key === 'now') return { value: { value: now, version: 1 } }
    return next(e)
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  await ui.press({ key: 'tab-turn' })
  const W = PANE_PROPS.bodyColumns
  const row = (time: string, tool: string, destination: string, status: string) =>
    `${time.padEnd(7)}${tool.padEnd(6)}${destination.padEnd(W - 24)}${status.padStart(9)}`

  // the board's title, and the reply's time so far flush right, two columns short of the border
  const title = await ui.find({ type: 'Text', text: /^DEPARTURES/ })
  expect(title?.text).toMatch(/^DEPARTURES +▶ 1m 12s$/)
  expect(title?.text.length).toBe(W - 2)
  expect(await ui.find({ type: 'Text', text: '━'.repeat(W) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: row('TIME', 'TOOL', 'DESTINATION', 'STATUS') })).toBeDefined()
  // one row per call, oldest first, each status in its colour; a long destination ends in an ellipsis
  const expected: [string, string][] = [
    [row('0.8s', 'Bash', 'plugin test', 'ARRIVED'), '#3fb950'],
    [row('1.0s', 'Edit', 'register.tsx', 'CANCELLED'), '#f85149'],
    [row('12s', 'Bash', 'git push', 'DELAYED'), '#f0883e'],
    [row('5.0s', 'Bash', 'npm run covera…', 'BOARDING'), '#d29922'],
  ]
  for (const [text, color] of expected) {
    const found = await ui.find({ type: 'Text', text })
    expect(found?.text).toBe(text)
    expect((found?.children.at(-1) as { props?: { color?: string } }).props?.color).toBe(color)
  }
  // the board's summary
  expect(await ui.find({ type: 'Text', text: '4 departures · 1 cancelled' })).toBeDefined()
  await ui.unmount()
})

test('under the board, the files the reply touched: the path cut from its start, the lines flush right, or new', async ($, on) => {
  const now = Date.parse('2026-10-04T12:00:00.000Z')
  mock.clock(on, { now })
  const touched = [
    { path: 'plugins/session-hud/hooks/register.tsx', added: 32, removed: 18 },
    { path: 'README.md', added: 0, removed: 4 },
    { path: 'notes/new.md', added: 0, removed: 0, isNew: true },
    ...Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.ts`, added: 1, removed: 0 })),
  ]
  on('state.get', ($, e, next) => {
    if (e.key === 'flight') return { value: { value: { turnId: 't', startedAt: now - 72_000, endedAt: now - 1_000, calls: [], touched }, version: 1 } }
    return next(e)
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  await ui.press({ key: 'tab-turn' })
  const W = PANE_PROPS.bodyColumns
  expect(await ui.find({ type: 'Text', text: 'TOUCHED THIS REPLY' })).toBeDefined()
  // whole rows, not the pencil spans inside them
  const rows = (await ui.findAll({ type: 'Text', text: /^✎ / })).filter(r => r.text.length > 2)
  // the most lines changed first, ties in the order they were touched; a new file has none yet
  expect(rows.map(r => r.text.replace(/ {2,}/, ' '))).toEqual([
    // a path too long for the row keeps its end, where the file's name is
    '✎ …sion-hud/hooks/register.tsx +32 -18',
    '✎ README.md +0 -4',
    ...Array.from({ length: 6 }, (_, i) => `✎ f${i}.ts +1 -0`),
  ])
  for (const r of rows) expect(r.text.length).toBe(W - 2)
  expect(await ui.find({ type: 'Text', text: '… 2 more' })).toBeDefined()
  await ui.unmount()

  // a sidebar too narrow for the whole path keeps its end, where the file's name is
  const narrow = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: { ...PANE_PROPS, bodyColumns: 30 } })
  await narrow.press({ key: 'tab-turn' })
  expect((await narrow.find({ type: 'Text', text: /^✎ …/ }))?.text).toBe('✎ …ooks/register.tsx +32 -18')
  await narrow.unmount()
})

test('clicking the session name puts /rename in the prompt box, and never over a draft', async ($, on) => {
  let draft = ''
  let isRefused = false
  const fills: string[] = []
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', ($, e) => {
    if (isRefused) return { isFilled: false, refusal: 'dialog', text: '', cursor: 0 }
    fills.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  await ui.press({ key: 'session-name' })
  expect(fills).toEqual(['/rename '])
  // a draft typed is the person's: they are told to clear it, and it stays
  draft = 'fix the build'
  await ui.press({ key: 'session-name' })
  expect(fills).toEqual(['/rename '])
  expect(toasts).toEqual(['Clear the prompt to rename the session'])
  // a box that does not take the text says how to do it by hand
  draft = ''
  isRefused = true
  await ui.press({ key: 'session-name' })
  expect(toasts.at(-1)).toBe('Could not reach the prompt: type /rename to rename the session')
  await ui.unmount()
})

test('Start remote control puts /rc and the session name, -RC, in the prompt box to change before sending', async ($, on) => {
  let draft = ''
  const fills: string[] = []
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  let name = 'Rework the Cache tab'
  on('state.get', ($, e, next) => {
    if (e.key !== 'meta') return next(e)
    const meta = { cwd: 'C:/w', id: '', name, model: 'm', effort: 'high', version: '', latest: '', committedAt: 0, startedAt: 0, turns: 1, minute: 0 }
    return { value: { value: meta, version: 1 } }
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  // Remote Control off: the light is red, beside the button
  const light = await ui.find({ type: 'Text', text: '● ' })
  expect(light?.props.color).toBe('#f85149')
  await ui.press({ key: 'start-remote' })
  expect(fills).toEqual(['/rc Rework the Cache tab-RC'])
  // a draft typed is the person's: they are told to clear it, and it stays
  draft = 'fix the build'
  await ui.press({ key: 'start-remote' })
  expect(fills).toHaveLength(1)
  expect(toasts).toEqual(['Clear the prompt to start Remote Control'])
  await ui.unmount()
  // a session with no name yet leaves the name to type
  name = ''
  draft = ''
  const unnamed = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  await unnamed.press({ key: 'start-remote' })
  expect(fills.at(-1)).toBe('/rc ')
  await unnamed.unmount()
})

test('clicking the model or the effort level puts /model or /effort in the prompt box', async ($, on) => {
  const fills: string[] = []
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  await ui.press({ key: 'claude-model' })
  await ui.press({ key: 'claude-effort' })
  expect(fills).toEqual(['/model ', '/effort '])
  await ui.unmount()
})

test('an empty board says so', async $ => {
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  await ui.press({ key: 'tab-turn' })
  expect(await ui.find({ type: 'Text', text: 'No departures yet.' })).toBeDefined()
  await ui.unmount()
})

test('the transit rows fit a 40-column sidebar, so the version and the id are never cut', async ($, on) => {
  const now = Date.parse('2026-10-04T12:00:00.000Z')
  mock.clock(on, { now })
  on('state.get', ($, e, next) => {
    if (e.key === 'meta') {
      const meta = {
        cwd: 'C:/Users/me/Projects/claude-plugins',
        home: 'C:\\Users\\me',
        id: '7c1f3a9e-2b4d-4e6f-8a0b-5d3c9e1f7a2b',
        name: 'Rework the Cache tab',
        remote: 'session_01Ab3Cd5Ef7Gh9Jk2Mn4Pq6Rs8',
        model: 'claude-opus-5',
        effort: 'high',
        version: '2.1.289',
        latest: '2.1.300',
        committedAt: 0,
        startedAt: now - 134 * MIN,
        turns: 48,
        minute: Math.floor(now / 60_000),
      }
      return { value: { value: meta, version: 1 } }
    }
    if (e.key === 'usage') {
      const usage = {
        tokens: 240_000,
        window: 1_000_000,
        percent: 24,
        costUsd: 12.43,
        limits: [
          { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(now + 125 * MIN).toISOString() },
          { kind: 'seven_day', percentUsed: 7, resetsAt: new Date(now + (3 * 24 * 60 + 240) * MIN).toISOString() },
        ],
        parts: [
          { name: 'Messages', tokens: 150_000 },
          { name: 'System tools', tokens: 40_000 },
          { name: 'MCP tools', tokens: 30_000 },
          { name: 'Memory files', tokens: 12_000 },
          { name: 'Skills', tokens: 8_000 },
        ],
      }
      return { value: { value: usage, version: 1 } }
    }
    // three turns, seven points apiece: the forecast the marks ahead count turns by
    if (e.key === 'history') {
      const history = [10, 17, 24].map((ctx, i) => ({ t: now - (3 - i) * MIN, ctx, isTurn: true }))
      return { value: { value: history, version: 1 } }
    }
    return next(e)
  })
  const copies: { text: string; surface?: string }[] = []
  on('ui.copy', (_$, e) => {
    copies.push({ text: e.text, surface: e.surface })
    return { value: { isCopied: true } }
  })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })

  // the origin is the working dir's own name; the folders above it ride the track, home as a tilde
  expect(await ui.find({ type: 'Text', text: /^ ◉━ claude-plugins$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '~/Projects/' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /C:\/Users\/me/ })).toBeUndefined()
  const stats = await ui.find({ type: 'Text', text: /48 prompts/ })
  const version = await ui.find({ key: 'claude-version' })
  const newer = await ui.find({ type: 'Text', text: ' → 2.1.300 out' })
  const name = await ui.find({ key: 'session-name' })
  const id = await ui.find({ key: 'session-id' })
  const remote = await ui.find({ type: 'Text', text: /Remote Control/ })
  const five = await ui.find({ type: 'Text', text: /^5h / })
  const seven = await ui.find({ type: 'Text', text: /^7d / })
  const here = await ui.find({ key: 'curl-marker' })
  const legend = await ui.find({ key: 'legend' })
  const train = await ui.find({ key: 'context-bar' })
  expect(stats?.text).toBe('2h 14m · 48 prompts · $12.43')
  // the version rides in the CLAUDE station, a button; when a newer one is out, it follows in red
  expect(version?.props.label).toBe('2.1.289')
  expect(newer?.props.color).toBe('#f85149')
  // the session's station is its name, then the whole id on its own row, ready to copy for `claude --resume`
  expect(name?.type).toBe('Button')
  expect(name?.props).toMatchObject({ label: 'Rework the Cache tab', plain: true })
  expect(id?.type).toBe('Button')
  expect(id?.props).toMatchObject({ label: '7c1f3a9e-2b4d-4e6f-8a0b-5d3c9e1f7a2b', plain: true, dimColor: true })
  // a click puts the whole id on the clipboard of the surface it came from, and says so
  await ui.press({ key: 'session-id' })
  expect(copies).toEqual([{ text: '7c1f3a9e-2b4d-4e6f-8a0b-5d3c9e1f7a2b', surface: 'terminal' }])
  expect(toasts).toEqual(['Session id copied'])
  // each limit on a row of its own: a meter, its share, and when it resets
  expect(five?.text).toMatch(/^5h ▰+▱+  42%  ↻ 2h 05m$/)
  expect(seven?.text).toMatch(/^7d ▰*▱+   7%  ↻ 3d 4h$/)
  // the context's stretch curls off the line, ▼ with how much of the window is used over YOU ARE HERE
  expect(here?.text).toBe(` ┃${' '.repeat(9)}▼ 240k/1M · 24%`)
  // the reading stands out: bold, in the colour of the zone the marker stands in, as the marker is: at 24% green
  const track = await ui.find({ key: 'curl-track' })
  type Span = { props: { color: string; dimColor?: boolean }; children: unknown[] }
  const spans = (track?.children[0] as { children: Span[] }).children
  const marker = spans.find(c => c.children[0] === '◆')!
  expect(marker.props.color).toBe('#3fb950')
  // the track behind it green, the way ahead dotted through green, amber and red
  expect(spans.filter(c => c.props.dimColor).map(c => c.props.color)).toEqual(['#3fb950', '#d29922', '#f85149'])
  const reading = (await ui.find({ type: 'Text', text: /^▼ 240k\/1M · 24%$/ })) as { props: { bold?: boolean; color?: string; dimColor?: boolean } }
  expect(reading.props).toMatchObject({ bold: true, color: marker.props.color })
  expect(reading.props.dimColor).toBeFalsy()
  // at 240k of a line to 900k the marker has passed the 200k stop: solid behind it, dotted ahead
  expect(track?.text).toBe(` ╰${'━'.repeat(8)}┯◆${'┄'.repeat(6)}┬${'┄'.repeat(6)}┬${'┄'.repeat(7)}┬${'┄'.repeat(3)}◎`)
  expect(track?.text.length).toBe(PANE_PROPS.bodyColumns - 2)
  // each stop's tokens under its tick, the 800k one left out as it would touch the terminus's
  expect((await ui.find({ key: 'curl-tokens' }))?.text).toBe('  0     200k    400k   600k       900k')
  // and the turns to each stop ahead, the terminus too
  expect((await ui.find({ key: 'curl-turns' }))?.text).toBe(`${' '.repeat(17)}≈3     ≈6      ≈8 ≈10`)
  // the context as a train, its engine at the head on the right and its hollow wheels on the row
  // under it: 24% of 18 cells loaded from the back, a cell for each category while they last,
  // a grey floor where nothing is loaded yet
  expect(train?.text).toBe('▐█▓▒░▁▁▌━▐▁▁▁▁▁▁▌━▐▁▁▁▁▁▁▌━▐█▄▙▖' + ' ○    ○   ○    ○   ○    ○   ○ ○' + '▔'.repeat(PANE_PROPS.bodyColumns - 3))
  // compaction (90%) is in the last car, whose coupler is the engine's: its walls are red instead,
  // a loaded car's grey, an empty one's dim
  const couplers = (await ui.findAll({ type: 'Text', text: /^━$/ })).map(t => t.props.color)
  expect(couplers).toEqual(['#e3b341', '#e3b341', '#e3b341'])
  const walls = (await ui.findAll({ type: 'Text', text: /^▌$/ })).map(t => [t.props.color, t.props.dimColor])
  expect(walls).toEqual([['#8b949e', false], ['#e3b341', true], ['#f85149', false]])
  // the legend, flush right beside ARIA's head, gives each category's pattern and tokens on one
  // row, the fourth and later summed into other; at 40 columns the names do not fit beside her
  expect(legend?.text).toBe('█150k ▓40k ▒30k ░20k')
  expect(legend?.props.justifyContent).toBe('flex-end')
  // the train's cargo and the legend's swatches in the marker's colour, one scale for the
  // context; the only other is the engine's red cab
  const swatches = await ui.findAll({ type: 'Text', text: /^[█▓▒░]+$/ })
  expect(new Set(swatches.map(s => s.props.color))).toEqual(new Set([marker.props.color, '#f85149']))
  expect(swatches.filter(s => s.props.color === '#f85149').map(s => s.text)).toEqual(['█'])
  // ARIA's name and mood share a row (240k is the amber zone: focus); under it the 5-hour forecast in words, quiet while it learns the pace
  expect((await ui.find({ key: 'aria-mood' }))?.text).toBe('ARIA · Watch the pace')
  const forecast = await ui.find({ key: 'aria-forecast' })
  expect(forecast?.text).toBe('5h learning the pace')
  // Remote Control on: a green light; the name claude.ai lists it under is the station above
  expect(remote?.text).toBe('● Remote Control')
  expect((remote?.children[0] as { props?: { color?: string } }).props?.color).toBe('#3fb950')
  // content sits four columns in, past the track, so a row has four columns less than the pane
  for (const row of [stats, remote, five, seven, legend]) expect((row?.text ?? '').length).toBeLessThanOrEqual(PANE_PROPS.bodyColumns - 4)
  expect(String(id?.props.label).length).toBeLessThanOrEqual(PANE_PROPS.bodyColumns - 4)
  await ui.unmount()
})

test('the Skills tab: what the listing costs, what fell past its budget, what fired, who pays and what never fires', async ($, on) => {
  const now = Date.parse('2026-10-10T12:00:00.000Z')
  mock.clock(on, { now })
  const list = [
    { name: 'superpowers:brainstorming', source: 'plugin', plugin: 'superpowers', tokens: 1_200 },
    { name: 'superpowers:writing-plans', source: 'plugin', plugin: 'superpowers', tokens: 900 },
    { name: 'dataviz', source: 'userSettings', tokens: 620 },
    { name: 'pdf', source: 'plugin', plugin: 'anthropic-skills', tokens: 400 },
  ]
  on('state.get', ($, e, next) => {
    if (e.key === 'usage') {
      const skills = { total: 57, included: 42, tokens: 6_100, list }
      return { value: { value: { window: 1_000_000, limits: [], skills }, version: 1 } }
    }
    if (e.key === 'meta') {
      const meta = { cwd: 'C:/x', id: '', name: '', model: '', effort: '', version: '', latest: '', committedAt: 0, startedAt: 0, turns: 0 }
      return { value: { value: { ...meta, minute: Math.floor(now / MIN) }, version: 1 } }
    }
    if (e.key === 'skills') {
      const fired = [
        { name: 'superpowers:brainstorming', count: 1, tokens: 3_200, by: 'claude', at: now - 9 * MIN },
        { name: 'superpowers:writing-plans', count: 2, tokens: 5_800, by: 'you', at: now - MIN },
      ]
      const skills = { fired, chain: ['superpowers:brainstorming', 'superpowers:writing-plans'], seen: Object.fromEntries(fired.map(f => [f.name, f.at])), since: now - 2 * 24 * 60 * MIN }
      return { value: { value: skills, version: 1 } }
    }
    return next(e)
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  await ui.press({ key: 'tab-skills' })
  const W = PANE_PROPS.bodyColumns

  expect(await ui.find({ type: 'Text', text: /^╭─ SKILLS · 42 of 57 listed ─+$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'listing 6k tokens every turn' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: "⚠ 15 past the budget: Claude can't pick them unless you type /name" })).toBeDefined()
  // the fired skills by their short names, the latest marked; each row short of the border
  const latest = await ui.find({ type: 'Text', text: /^◉ writing-plans/ })
  expect(latest?.text).toMatch(/^◉ writing-plans +you +×2 +6k$/)
  expect(await ui.find({ type: 'Text', text: /^● brainstorming +claude +×1 +3k$/ })).toBeDefined()
  expect(latest?.text.length).toBeLessThanOrEqual(W - 2 - 2)
  expect(await ui.find({ type: 'Text', text: 'chain: brainstorming → writing-plans' })).toBeDefined()
  // who pays: superpowers lists two and pays the most
  expect(await ui.find({ type: 'Text', text: /^superpowers +2 █{10} +2k$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^user +1 █+ +620$/ })).toBeDefined()
  // quiet: listed and never fired since the record began two days ago
  expect(await ui.find({ type: 'Text', text: /^╭─ QUIET · not fired since Oct 8/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'dataviz · pdf' })).toBeDefined()
  await ui.unmount()
})

test('a skill you type and a skill Claude calls are both recorded, and kept for every session', async ($, on) => {
  const now = Date.parse('2026-10-10T12:00:00.000Z')
  mock.clock(on, { now })
  // the plugin's store, shared by every session
  const store: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  // the engine computes a skill's prompt as its own text
  on('skill.prompt', ($, e) => ({ text: e.text }))
  // the Skill tool expands its skill's prompt while it runs, as the engine does
  on('tool.call', async (_, e) => {
    await $.skill.prompt({ skill: String((e as unknown as { skill: string }).skill), text: 'x'.repeat(4_000) })
    return { result: {}, text: 'ok' } as never
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  await ui.press({ key: 'tab-skills' })
  expect(await ui.find({ type: 'Text', text: 'None yet.' })).toBeDefined()

  await $.skill.prompt({ skill: 'commit', text: 'y'.repeat(2_000) })
  await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming' } as never)
  expect(await ui.find({ type: 'Text', text: /^● commit +you +×1 +500$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^◉ brainstorming +claude +×1 +1k$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'chain: commit → brainstorming' })).toBeDefined()
  expect(store.skillsSeen).toEqual({ since: now, seen: { commit: now, 'superpowers:brainstorming': now } })
  await ui.unmount()
})

test('where an organization keeps skill.prompt from the plugin, the Skill call and the typed command count the fire', async ($, on) => {
  const now = Date.parse('2026-10-10T12:00:00.000Z')
  mock.clock(on, { now })
  const store: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  // no skill.prompt reaches the plugin: the calls and commands below expand nothing it sees
  on('command.list', () => ({
    value: [
      { name: 'commit', description: '', source: 'user' },
      { name: 'model', description: '', source: 'builtin' },
    ],
  }))
  on('command.run', () => ({ text: '' }))
  on('tool.call', (_, e) =>
    (String((e as unknown as { skill: string }).skill) === 'missing' ? { result: {}, text: 'no such skill', isError: true } : { result: {}, text: 'ok' }) as never,
  )
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  await ui.press({ key: 'tab-skills' })

  const typed = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await typed('commit')
  // a built-in command is not a skill, and a Skill call that failed fired nothing
  await typed('model')
  await $.tool.call({ tool: 'Skill', skill: 'missing' } as never)
  await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming' } as never)
  // the size of a prompt never seen is unknown, not 0
  expect(await ui.find({ type: 'Text', text: /^● commit +you +×1 +—$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^◉ brainstorming +claude +×1 +—$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /model|missing/ })).toBeUndefined()
  expect(store.skillsSeen).toEqual({ since: now, seen: { commit: now, 'superpowers:brainstorming': now } })
  await ui.unmount()
})

test('a fire both reports reach is counted once, the prompt bringing its size, until the reply ends', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-10T12:00:00.000Z') })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.list', () => ({ value: [{ name: 'commit', description: '', source: 'user' }] }))
  on('command.run', () => ({ text: '' }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  await ui.press({ key: 'tab-skills' })

  // typed: the command reports first, then its prompt expands and adds its size
  await $.command.run({ command: 'commit', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await $.skill.prompt({ skill: 'commit', text: 'y'.repeat(2_000) })
  expect(await ui.find({ type: 'Text', text: /^◉ commit +you +×1 +500$/ })).toBeDefined()
  // once the reply has ended, the next expansion is a fire of its own
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't1' })
  await $.skill.prompt({ skill: 'commit', text: 'y'.repeat(2_000) })
  expect(await ui.find({ type: 'Text', text: /^◉ commit +you +×2 +1k$/ })).toBeDefined()
  await ui.unmount()
})

test('a copy that does not take says why, and nothing claims it was copied', async ($, on) => {
  on('state.get', ($, e, next) =>
    e.key === 'meta' ? { value: { value: { cwd: 'C:/x', id: '7c1f3a9e-2b4d-4e6f-8a0b-5d3c9e1f7a2b', name: '', model: '', effort: '', version: '', hudVersion: '', latest: '', committedAt: 0, startedAt: 0, turns: 0, minute: 0 }, version: 1 } } : next(e),
  )
  on('ui.copy', () => ({ value: { isCopied: false, reason: 'no-clipboard' } }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  await ui.press({ key: 'session-id' })
  expect(toasts).toEqual(['Could not copy the session id (no-clipboard)'])
  await ui.unmount()
})

test('a registry entry gives up its name and Remote Control id only to the session it belongs to', () => {
  const ID = '7c1f3a9e-2b4d-4e6f-8a0b-5d3c9e1f7a2b'
  // A real ~/.claude/sessions/<pid>.json, trimmed.
  const mine = JSON.stringify({ pid: 23652, sessionId: ID, cwd: 'C:/x', name: 'ARIA-HUD', nameSource: 'user' })
  expect(sessionEntryIn(mine, ID)).toEqual({ name: 'ARIA-HUD', remote: '' })
  expect(sessionEntryIn(mine, 'another-session')).toBeUndefined()
  // With Remote Control on, the entry carries the bridge's session id.
  const bridged = JSON.stringify({ sessionId: ID, name: 'ARIA-HUD', bridgeSessionId: 'session_01Ab3Cd5Ef7Gh9Jk2Mn4Pq6Rs8' })
  expect(sessionEntryIn(bridged, ID)).toEqual({ name: 'ARIA-HUD', remote: 'session_01Ab3Cd5Ef7Gh9Jk2Mn4Pq6Rs8' })
  expect(sessionEntryIn(JSON.stringify({ sessionId: ID, bridgeSessionId: 7 }), ID)).toEqual({ name: '', remote: '' })
  // An unnamed session is a known empty name, not "keep looking".
  expect(sessionEntryIn(JSON.stringify({ sessionId: ID }), ID)).toEqual({ name: '', remote: '' })
  expect(sessionEntryIn('{ truncated', ID)).toBeUndefined()
  expect(sessionEntryIn('', ID)).toBeUndefined()
})

test('a cache break is called before the request goes out, once, and only when it is worth money', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-05T12:00:00.000Z') })
  const sections = [{ id: 'intro', text: 'hello', scope: 'shared' as const }]
  on('prompt.compose', () => ({ sections }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  let tokens = 640_000
  on('state.get', ($, e, next) =>
    e.key === 'usage' ? { value: { value: { window: 1_000_000, limits: [], tokens }, version: 1 } } : next(e),
  )
  const compose = (tools: string[], traits: string[] = []) =>
    $.prompt.compose({
      model: 'claude-opus-5',
      promptModel: 'claude-opus-5',
      surfaces: ['terminal'],
      outputStyle: null,
      tools,
      traits,
    } as never)

  // The first render is the baseline: nothing to compare against, so no warning.
  await compose(['Read', 'Bash'])
  expect(toasts).toEqual([])

  // A tool arriving mid-session rewrites the whole prefix at the write rate.
  await compose(['Read', 'Bash', 'mcp__github__get_issue'])
  expect(toasts).toEqual(['the tool list changed: the next reply re-caches 640k'])

  // Every further request of that same turn sends the same prefix: one warning, not twelve.
  await compose(['Read', 'Bash', 'mcp__github__get_issue'])
  expect(toasts).toHaveLength(1)

  // /context measures the prompt and sends nothing, so it is not a request at all.
  await compose(['Read'], ['analysis'])
  expect(toasts).toHaveLength(1)

  // A small prompt is cheap to rebuild and says nothing.
  tokens = 20_000
  await compose(['Read', 'Bash'])
  expect(toasts).toHaveLength(1)
})

test('the top bar stays out of the way while the sidebar is showing', async ($, on) => {
  on('ui.panes', () => ({ value: [{ id: 'session-hud', title: 'Session', isShown: true, isFocused: false, isPlaced: true }] }))
  let isEngineDrawing = false
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    isEngineDrawing = true
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine band') as never
  })
  const ui = await $.ui.mount({
    plugin: 'session-hud',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  })
  expect(isEngineDrawing).toBe(true)
  expect(await ui.find({ type: 'Text', text: /\/hud/ })).toBeUndefined()
  await ui.unmount()
})

test('a shared scan keeps each session own processes its own and never stores raw secrets', () => {
  const rows = [
    { pid: 30, name: 'claude.exe', start: 1, mem: 100, cpu: 5, cmd: 'claude.exe' },
    { pid: 40, name: 'node.exe', start: 1, mem: 30, cpu: 2, cmd: '"C:\\x\\node.exe" app.js --token abc' },
  ]
  const stdout = [
    '@@ROWS@@' + JSON.stringify(rows),
    '@@TREE@@1000:4:1:explorer.exe|30:1000:1:claude.exe|40:30:1:node.exe|77:30:1:powershell.exe',
    '@@CHAIN@@77,30,1000',
  ].join('\n')
  const scan = parseWindowsScan(stdout)
  expect(selfOf(scan)).toEqual([77, 30])
  const cached = toCache(scan, 5)
  expect(JSON.stringify(cached)).not.toContain('abc')
  const shared = fromCache(JSON.parse(JSON.stringify(cached)))
  // The session that scanned sees its tree as its own; another session, with other pids, does not.
  expect(buildProcs(shared, [], 5, 5, [77, 30]).find(p => p.pid === 40)?.state).toBe('mine')
  expect(buildProcs(shared, [], 5, 5, [88, 50]).find(p => p.pid === 40)?.state).toBe('owned')
})
