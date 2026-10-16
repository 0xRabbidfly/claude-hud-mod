import { expect, test } from 'claude-code/testing'

import type { HudCacheTurn, HudProc, HudSample } from '../types'
import { ariaCells, forecastLine, moodLine, moodOf, trendCells, turnsToCompact } from '../hooks/aria'
import { COMPACT_BRIEF, compactInstructions, keepListFile, zoneLabel, zoneOf } from '../hooks/compact'
import {
  PART_PATTERNS,
  allocate,
  bar,
  baseName,
  compareVersions,
  effortSpans,
  forkBases,
  parseLeftRight,
  fingerprint,
  formatSpan,
  formatMb,
  hex,
  legendParts,
  limitColor,
  limitName,
  parseLog,
  parseStatus,
  patternBar,
  trainCars,
  qualityLabel,
  dirParts,
  tildePath,
  trackCell,
  trackStops,
  fitRow,
} from '../hooks/lib'
import {
  cacheHit,
  cacheTotals,
  cacheWarmth,
  callLabel,
  departureStatus,
  fitStart,
  formatSeconds,
  numstatFiles,
  shortTool,
  toolColor,
  touchFiles,
  treeOf,
  dispatches,
} from '../hooks/panels'
import {
  IDLE_AFTER_MS,
  WINDOWS_SCAN,
  ancestorsOf,
  buildProcs,
  canEnd,
  encodePowerShell,
  endScript,
  isIdle,
  memoryCells,
  parsePsScan,
  parseWindowsScan,
  procHex,
  procKind,
  procState,
} from '../hooks/procs'
import type { TreeNode } from '../hooks/procs'

// The paths the other suites leave untested, one behaviour per test. hardening.test.ts holds
// the review's regressions; what it already pins is not repeated here.

const MIN = 60_000
const DEFAULT_COLOR = 0x01000000

/** A Raster's cells back as [glyph, foreground, background]: three little-endian words per cell. */
function cellsOf(packed: string): Array<[number, number, number]> {
  const binary = atob(packed)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const words = new Uint32Array(bytes.buffer)
  const out: Array<[number, number, number]> = []
  for (let i = 0; i < words.length; i += 3) out.push([words[i]!, words[i + 1]!, words[i + 2]!])
  return out
}

const glyphs = (packed: string) => cellsOf(packed).map(([glyph]) => glyph)
const paint = (packed: string) => cellsOf(packed).map(([glyph, fg]) => [glyph, fg])

const proc = (over: Partial<HudProc>): HudProc => ({
  pid: 2,
  name: 'node',
  startedAt: 0,
  memMb: 10,
  cpuSec: 1,
  activeAt: 0,
  state: 'owned',
  kind: '',
  command: '',
  ...over,
})

// ---------------------------------------------------------------- ending a process

test('the end script checks the start time before it kills, and drops a fraction of a pid', () => {
  const script = endScript(1234, 1_700_000_000_000.7)
  expect(script).toContain('[math]::Abs($ms - 1700000000000)')
  // the start check exits before taskkill, so a reused pid is never ended
  expect(script.indexOf('exit 3', script.indexOf('Abs('))).toBeLessThan(script.indexOf('taskkill'))
  expect(endScript(12.9, 5)).toContain('taskkill /PID 12 /T /F')
})

test('the end script refuses any pid or start it cannot write as a plain number', () => {
  for (const pid of [0, Number.POSITIVE_INFINITY, 2 ** 60]) expect(endScript(pid, 1)).toBe('exit 3')
  expect(endScript(1234, Number.NaN)).toBe('exit 3')
  expect(endScript(1234, Number.POSITIVE_INFINITY)).toBe('exit 3')
  // a value that would carry PowerShell of its own never reaches the script
  expect(endScript('1; Remove-Item C:\\' as never, 1)).toBe('exit 3')
  expect(endScript(1234, '1) { exit 0 }; taskkill /PID 4 #' as never)).toBe('exit 3')
})

test('PowerShell gets the script as UTF-16LE base64, which round-trips', () => {
  expect(encodePowerShell('ab')).toBe('YQBiAA==')
  expect(encodePowerShell('é')).toBe('6QA=')
  expect(encodePowerShell('€')).toBe('rCA=')
  const binary = atob(encodePowerShell(WINDOWS_SCAN))
  let decoded = ''
  for (let i = 0; i < binary.length; i += 2) decoded += String.fromCharCode(binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8))
  expect(decoded).toBe(WINDOWS_SCAN)
})

// ---------------------------------------------------------------- the scans

const NOW = 10_000_000_000

const PS_OUTPUT = [
  '@@ME@@ 500',
  '    1     0 30-00:00:00   1024 00:00:01 /sbin/launchd',
  '  400     1    01:00:00 204800 00:01:30 /Applications/Visual Studio Code.app/Contents/MacOS/Electron --x',
  '  500   400       10:00 102400    01:05 node /usr/local/bin/claude --resume',
  '  600   500       00:05  51200 00:00.50 node server.js --token abc',
  '@@COMM@@',
  '    1 /sbin/launchd',
  '  400 /Applications/Visual Studio Code.app/Contents/MacOS/Code',
  '  500 claude',
  '  600 node',
  // ps ends its output with a newline: the blank line after it names nothing
  '',
].join('\n')

test('the ps scan takes names from comm over argv, and CPU time below a second', () => {
  const scan = parsePsScan(PS_OUTPUT, NOW)
  // 500 runs `node .../claude`, and comm says claude: comm wins
  expect(scan.rows.map(r => [r.pid, r.name])).toEqual([
    [500, 'claude'],
    [600, 'node'],
  ])
  expect(scan.rows[0]).toMatchObject({ start: NOW - 600_000, mem: 100, cpu: 65 })
  expect(scan.rows[1]!.cpu).toBe(0.5)
  expect(scan.tree.get(400)?.name).toBe('code')
})

test('the ps scan counts days in etime and falls back to argv[0] without a name listing', () => {
  const scan = parsePsScan(['  7  1  1-02:03:04  2048  1-00:00:00  /usr/local/bin/node a.js', 'garbage line', ''].join('\n'), NOW)
  expect(scan.chain).toEqual([])
  expect(scan.rows).toEqual([{ pid: 7, name: 'node', start: NOW - 93_784_000, mem: 2, cpu: 86_400, cmd: '/usr/local/bin/node a.js' }])
  // a process with no arguments at all still has a name and a command
  expect(parsePsScan('  8  1  00:01  1024  00:00  ', NOW).tree.get(8)).toMatchObject({ name: '' })
  expect(parsePsScan('', NOW)).toEqual({ rows: [], tree: new Map(), chain: [] })
})

test('on macOS a session inside an editor is a tab, and its children are its own', () => {
  const { tree } = parsePsScan(PS_OUTPUT, NOW)
  expect(procState(500, tree, new Set(), new Set())).toBe('protected')
  expect(procState(600, tree, new Set([500]), new Set())).toBe('mine')
})

test('a Windows scan with sections or fields missing still parses', () => {
  expect(parseWindowsScan('')).toEqual({ rows: [], tree: new Map(), chain: [] })
  // ConvertTo-Json of one row is an object, not an array; a row missing fields gets empty ones
  expect(parseWindowsScan('@@ROWS@@{"pid":5}').rows).toEqual([{ pid: 5, name: '', start: 0, mem: 0, cpu: 0, cmd: '' }])
  const { tree } = parseWindowsScan('@@TREE@@5:4|6:5:9:odd:name.exe')
  expect(tree.get(5)).toEqual({ pid: 5, ppid: 4, start: 0, name: '' })
  // a name may hold the separator
  expect(tree.get(6)?.name).toBe('odd:name.exe')
})

// ---------------------------------------------------------------- ownership

test('what a process is comes from its command line, first match wins', () => {
  expect(procKind('claude', 'claude', true)).toBe('desktop app')
  expect(procKind('claude', 'claude daemon run', false)).toBe('daemon')
  expect(procKind('claude', 'claude --bg-pty-host', false)).toBe('background host')
  expect(procKind('claude', 'claude --session-id 1', false)).toBe('background session')
  expect(procKind('claude', 'claude', false)).toBe('session')
  expect(procKind('node', 'node node_modules/next/dist/server/lib/start-server.js', false)).toBe('next dev')
  expect(procKind('node', 'node node_modules/vitest/vitest.mjs', false)).toBe('vitest')
  expect(procKind('node', 'node tsserver.js', false)).toBe('tsserver')
  expect(procKind('node', 'node node_modules/.bin/tsc --watch', false)).toBe('tsc')
  // playwright is listed before mcp, so the Playwright MCP server is playwright
  expect(procKind('node', 'npx-cli.js -y @playwright/mcp', false)).toBe('playwright')
  expect(procKind('node', 'node mcp-server.js', false)).toBe('mcp server')
  expect(procKind('node', 'node server.js', true)).toBe('')
})

const node = (pid: number, ppid: number, start: number, name = 'node.exe'): [number, TreeNode] => [pid, { pid, ppid, start, name }]

test('ancestors stop at a missing parent and at a self-parent, shared ones counted once', () => {
  const tree = new Map([
    node(1000, 4, 1, 'explorer.exe'),
    node(1100, 1000, 2, 'herdr.exe'),
    node(1200, 1100, 3, 'powershell.exe'),
    node(1300, 1200, 4, 'claude.exe'),
    node(3000, 3000, 1),
  ])
  expect([...ancestorsOf([1300], tree)].sort((a, b) => a - b)).toEqual([1000, 1100, 1200])
  expect([...ancestorsOf([1300, 1200], tree)].sort((a, b) => a - b)).toEqual([1000, 1100, 1200])
  expect(ancestorsOf([3000], tree).size).toBe(0)
  expect(ancestorsOf([9999], tree).size).toBe(0)
})

test('a pid missing from the tree is unowned, and a chain deeper than forty is owned', () => {
  expect(procState(12345, new Map(), new Set(), new Set())).toBe('unowned')
  // 1 <- 2 <- ... <- 45, each parent older than its child, and no root in sight
  const deep = new Map(Array.from({ length: 45 }, (_, i) => node(i + 1, i + 2, 100 - i)))
  expect(procState(1, deep, new Set(), new Set())).toBe('owned')
})

test('the daemon owns its children, and a desktop helper the tree lost is folded away all the same', () => {
  const rows = [
    { pid: 30, name: 'claude.exe', start: 1, mem: 80, cpu: 1, cmd: 'claude daemon run' },
    { pid: 31, name: 'claude.exe', start: 2, mem: 60, cpu: 1, cmd: 'claude --session-id x' },
    { pid: 99, name: 'claude.exe', start: 1, mem: 10, cpu: 1, cmd: 'claude.exe --type=gpu-process' },
  ]
  const stdout = ['@@ROWS@@' + JSON.stringify(rows), '@@TREE@@30:7:1:claude.exe|31:30:2:claude.exe', '@@CHAIN@@'].join('\n')
  const procs = buildProcs(parseWindowsScan(stdout), [], 5, 5, [])
  expect(procs.map(p => p.pid).sort((a, b) => a - b)).toEqual([30, 31])
  expect(procs.find(p => p.pid === 30)).toMatchObject({ kind: 'daemon' })
  expect(procs.find(p => p.pid === 31)).toMatchObject({ state: 'owned', kind: 'background session' })
  expect(canEnd(procs.find(p => p.pid === 30)!)).toBe(false)
})

test('a host of other sessions is never ended even when nothing owns it', () => {
  for (const kind of ['desktop app', 'daemon', 'background host']) expect(canEnd(proc({ state: 'unowned', kind }))).toBe(false)
  expect(canEnd(proc({ state: 'unowned', kind: 'background session' }))).toBe(true)
})

// ---------------------------------------------------------------- idle and colors

test('idle starts at exactly thirty minutes without CPU', () => {
  expect(isIdle(proc({ activeAt: 0 }), IDLE_AFTER_MS)).toBe(true)
  expect(isIdle(proc({ activeAt: 0 }), IDLE_AFTER_MS - 1)).toBe(false)
})

test('each process is colored by the state that decides what the person can do', () => {
  const idle = 31 * MIN
  expect(procHex(proc({ state: 'mine' }), idle)).toBe('#58a6ff')
  expect(procHex(proc({ state: 'unowned' }), idle)).toBe('#f85149')
  expect(procHex(proc({ state: 'unowned' }), MIN)).toBe('#d29922')
  expect(procHex(proc({ state: 'owned' }), idle)).toBe('#8b949e')
  expect(procHex(proc({ state: 'owned' }), MIN)).toBe('#3fb950')
})

test('the memory row splits by share and always fills exactly its columns', () => {
  const procs = [proc({ pid: 1, memMb: 30, state: 'owned' }), proc({ pid: 2, memMb: 10, state: 'mine' })]
  expect(paint(memoryCells(procs, 8, MIN))).toEqual([
    ...Array.from({ length: 6 }, () => [0x2588, 0x3fb950]),
    [0x2588, 0x58a6ff],
    [0x2588, 0x58a6ff],
  ])
  expect(glyphs(memoryCells([], 4, MIN))).toEqual([0x2591, 0x2591, 0x2591, 0x2591])
  // many small processes each take at least one cell, never more than the row has
  const many = Array.from({ length: 10 }, (_, i) => proc({ pid: i, memMb: 1 }))
  expect(cellsOf(memoryCells(many, 4, MIN))).toHaveLength(4)
  // nothing using memory draws an empty row, not a crash
  expect(glyphs(memoryCells([proc({ memMb: 0 })], 3, MIN))).toEqual([0x2591, 0x2591, 0x2591])
})

// ---------------------------------------------------------------- the mascot

const samples = (...points: Array<Partial<HudSample>>): HudSample[] => points.map((p, i) => ({ t: i * MIN, isTurn: true, ...p }))

test('every face, open-eyed or blinking, is drawn in colors the palette knows', () => {
  for (const mood of ['sleep', 'happy', 'focus', 'alarm'] as const) {
    for (const isBlinking of [false, true]) {
      // a letter missing from the palette would paint as 0, which no color here is
      for (const [glyph, fg, bg] of cellsOf(ariaCells(mood, isBlinking))) expect([glyph, fg, bg]).not.toContain(0)
    }
  }
})

test('in alarm her left tear is on her cheek under her eye, the other still beside her face', () => {
  const TEAR = 0x58a6ff
  const BLANK = [0x20, 0x01000000, 0x01000000]
  const cells = cellsOf(ariaCells('alarm'))
  const at = (row: number, col: number) => cells[row * 12 + col]
  // under the left eye: both pixels of the cell, cheek and the row below it
  expect(at(3, 3)).toEqual([0x2580, TEAR, TEAR])
  // nothing left beside the left of her face
  expect(at(1, 0)).toEqual(BLANK)
  expect(at(2, 0)).toEqual(BLANK)
  // the right one is where it was
  expect(at(1, 11)).toEqual([0x2584, TEAR, 0x01000000])
  expect(at(2, 11)).toEqual([0x2580, TEAR, 0x01000000])
})

test('the mood reads either signal alone, and no turn yet means no runway', () => {
  expect(moodOf(undefined, 60, undefined, { kind: 'steady' })).toBe('focus')
  expect(moodOf(30, undefined, undefined, { kind: 'steady' })).toBe('happy')
  expect(turnsToCompact([])).toBeUndefined()
  expect(turnsToCompact(samples({ ctx: undefined }, { five: 20 }))).toBeUndefined()
})

test('the trend carries a missing reading forward and leaves a row blank until its first one', () => {
  const cells = cellsOf(trendCells(samples({ ctx: 10 }, { five: 20 }), 2))
  const [ctxFirst, ctxSecond, fiveFirst, fiveSecond] = cells
  expect(ctxSecond).toEqual(ctxFirst)
  expect(fiveFirst).toEqual([0x20, DEFAULT_COLOR, DEFAULT_COLOR])
  expect(fiveSecond![0]).not.toBe(0x20)
})

// ---------------------------------------------------------------- compaction

test('the keep-list leaves out the steer line when the person typed nothing', () => {
  expect(keepListFile(['a'], 'id', 'now')).not.toContain("In the user's words")
  expect(keepListFile(['a'], 'id', 'now', '   ')).not.toContain("In the user's words")
  expect(keepListFile(['a'], 'id', 'now', ' the deploy ')).toContain("**In the user's words:** the deploy")
})

test('instructions that already carry the brief are passed through as typed', () => {
  const typed = `  keep the plan\n\n${COMPACT_BRIEF}  `
  expect(compactInstructions(typed)).toBe(typed.trim())
})

test('a window of unknown size falls back to the 400k ceiling', () => {
  expect(zoneOf(250_000, 0)).toEqual({ zone: 'amber', amberAt: 200_000, redAt: 400_000 })
})

// ---------------------------------------------------------------- lib

test('labels and colors for context use and limits change at their thresholds', () => {
  expect(hex(0x3fb950)).toBe('#3fb950')
  expect(hex(0xff)).toBe('#0000ff')
  expect([undefined, 39.9, 40, 60, 80].map(qualityLabel)).toEqual(['no reading yet', 'sharp', 'good', 'degrading', 'compact soon'])
  expect([49, 50, 79, 80].map(limitColor)).toEqual(['#3fb950', '#d29922', '#d29922', '#f85149'])
  expect(limitName('five_hour')).toBe('5h')
  expect(limitName('seven_day')).toBe('7d')
  expect(limitName('seven_day_opus')).toBe('7d opus')
  expect(limitName('monthly_spend')).toBe('monthly spend')
})

test('a bar fills its share of the width, clamped to 0 and 100', () => {
  expect(bar(50, 10)).toEqual({ full: '█████', empty: '░░░░░' })
  expect(bar(-5, 4)).toEqual({ full: '', empty: '░░░░' })
  expect(bar(150, 4)).toEqual({ full: '████', empty: '' })
})

test('git quotes a path with spaces or quotes in it, and the quotes come off', () => {
  const { files } = parseStatus(['?? "my file.txt"', 'R  old.ts -> "new name.ts"', ' M "a\\"b.ts"', ' M "odd'].join('\n'))
  expect(files.map(f => f.path)).toEqual(['my file.txt', 'new name.ts', 'a"b.ts', '"odd'])
})

test('versions with fewer parts compare as if the missing ones were 0', () => {
  expect(compareVersions('2.1', '2.1.0')).toBe(0)
  expect(compareVersions('2.1.1', '2.1')).toBeGreaterThan(0)
  expect(compareVersions('2.1', '2.1.1')).toBeLessThan(0)
})

test('spans read as minutes, hours and days', () => {
  expect(formatSpan(0)).toBe('now')
  expect(formatSpan(-5)).toBe('now')
  expect(formatSpan(59_999)).toBe('0m')
  expect(formatSpan(5 * MIN)).toBe('5m')
  expect(formatSpan(65 * MIN)).toBe('1h 05m')
  expect(formatSpan((1440 + 3 * 60 + 7) * MIN)).toBe('1d 3h')
})

test('a fingerprint is FNV-1a: stable, eight hex digits, and different for different text', () => {
  expect(fingerprint('')).toBe('811c9dc5')
  expect(fingerprint('a')).toBe('e40c292c')
  expect(fingerprint('hello')).toBe(fingerprint('hello'))
  expect(fingerprint('hello')).not.toBe(fingerprint('hellp'))
})

test('a base name is the last part of either kind of path', () => {
  expect(baseName('C:\\x\\y\\file.ts')).toBe('file.ts')
  expect(baseName('/a/b/')).toBe('b')
  expect(baseName('plain')).toBe('plain')
  expect(baseName('/')).toBe('/')
})

test('a branch is counted from the remote default it was made from, never from itself', () => {
  expect(forkBases('origin/main\n', 'feature')).toEqual(['origin/main', 'origin/master', 'main', 'master'])
  expect(forkBases('origin/develop', 'feature')).toEqual(['origin/develop', 'origin/main', 'origin/master', 'main', 'master'])
  // no remote default: the usual names; on main itself, only the names main is not
  expect(forkBases('', 'feature')).toEqual(['origin/main', 'origin/master', 'main', 'master'])
  expect(forkBases('origin/main', 'main')).toEqual(['origin/master', 'master'])
  expect(parseLeftRight('2\t5\n')).toEqual({ behind: 2, ahead: 5 })
  expect(parseLeftRight('fatal: bad revision')).toBeUndefined()
})

test('effort is coloured by its rank, and ultra in every colour', () => {
  const ranks = ['low', 'medium', 'high', 'xhigh', 'max'].map(level => effortSpans(level)[0]?.hex)
  expect(ranks).toEqual(['#8b949e', '#79c0ff', '#3fb950', '#d29922', '#f0883e'])
  // ultra: a letter each, every one in a colour of its own
  const ultra = effortSpans('ultra')
  expect(ultra.map(s => s.text).join('')).toBe('ultra')
  expect(new Set(ultra.map(s => s.hex)).size).toBe(5)
  // a level it does not know, or none, keeps its words and takes no colour
  expect(effortSpans('turbo')).toEqual([{ text: 'turbo', hex: undefined }])
  expect(effortSpans('')).toEqual([{ text: 'default', hex: undefined }])
})

test('the stops are in tokens, a round step apart, six at most, and never change in number', () => {
  const K = 1_000
  expect(trackStops(301 * K, 467 * K)).toEqual({ passed: [100 * K, 200 * K, 300 * K], ahead: [400 * K] })
  // a stop the context has just reached is passed; the compaction point is its own station, not a stop
  expect(trackStops(300 * K, 400 * K)).toEqual({ passed: [100 * K, 200 * K, 300 * K], ahead: [] })
  // 90% of 1M would be eight stops at 100k: they go 200k apart
  expect(trackStops(240 * K, 900 * K)).toEqual({ passed: [200 * K], ahead: [400 * K, 600 * K, 800 * K] })
  // a small window gets small steps
  expect(trackStops(undefined, 180 * K)).toEqual({ passed: [], ahead: [50 * K, 100 * K, 150 * K] })
  expect(trackStops(5 * K, 8 * K)).toEqual({ passed: [], ahead: [] })
  // past the largest step, the track keeps it however many stops that makes
  expect(trackStops(0, 10_000 * K).ahead).toHaveLength(9)
  for (const t of [undefined, 0, 240 * K, 555 * K, 999 * K]) {
    const { passed, ahead } = trackStops(t, 900 * K)
    expect(passed.length + ahead.length).toBe(4)
  }
})

test('a stop falls on the cell of its share of the track, clamped to it, and at the start with no end', () => {
  const K = 1_000
  expect(trackCell(100 * K, 400 * K, 41)).toBe(10)
  expect(trackCell(0, 400 * K, 41)).toBe(0)
  // past compaction sits on the terminus; a negative reading at the start
  expect(trackCell(900 * K, 400 * K, 41)).toBe(40)
  expect(trackCell(-5, 400 * K, 41)).toBe(0)
  // no end yet, or a track of one cell: everything at the start
  expect(trackCell(100 * K, 0, 41)).toBe(0)
  expect(trackCell(100 * K, 400 * K, 1)).toBe(0)
})

test('labels on a row keep a space apart and inside it, the first wanted first, each trying its places in turn', () => {
  const at = (key: string, start: number, text: string) => ({ key, start, text })
  // touching the label before it, the second is left out; one space apart, it stays
  expect(fitRow(10, [[at('a', 0, 'abc')], [at('b', 3, 'de')]])).toEqual([at('a', 0, 'abc')])
  expect(fitRow(10, [[at('a', 0, 'abc')], [at('b', 4, 'de')]])).toEqual([at('a', 0, 'abc'), at('b', 4, 'de')])
  // a label wanted first wins its place; the one after takes its next place, sorted by where they start
  expect(fitRow(10, [[at('a', 5, 'xy')], [at('b', 4, 'de'), at('b', 0, 'de')]])).toEqual([at('b', 0, 'de'), at('a', 5, 'xy')])
  // a label before the row or past its end is left out
  expect(fitRow(10, [[at('a', -1, 'ab')], [at('b', 9, 'cd')]])).toEqual([])
  expect(fitRow(10, [[at('a', 8, 'cd')]])).toEqual([at('a', 8, 'cd')])
})

test('a departure boards while it runs, is cancelled when it failed, delayed past ten seconds, else arrives', () => {
  const call = { id: 'a', tool: 'Bash', label: 'npm test', start: 1_000, isError: false }
  expect(departureStatus(call)).toBe('BOARDING')
  expect(departureStatus({ ...call, end: 3_000 })).toBe('ARRIVED')
  expect(departureStatus({ ...call, end: 10_999 })).toBe('ARRIVED')
  expect(departureStatus({ ...call, end: 11_000 })).toBe('DELAYED')
  expect(departureStatus({ ...call, end: 2_000, isError: true })).toBe('CANCELLED')
  expect(departureStatus({ ...call, end: 60_000, isError: true })).toBe('CANCELLED')
})

test('a path splits into the folders above and its own name, which ends it', () => {
  expect(dirParts('~\\Documents\\claude-plugins')).toEqual({ head: '~\\Documents\\', tail: 'claude-plugins' })
  expect(dirParts('/a/b/')).toEqual({ head: '/a/', tail: 'b' })
  // the name is the last one even when an earlier folder has it too
  expect(dirParts('/x/b/b')).toEqual({ head: '/x/b/', tail: 'b' })
  expect(dirParts('~')).toEqual({ head: '', tail: '~' })
  expect(dirParts('/')).toEqual({ head: '', tail: '/' })
  expect(dirParts('')).toEqual({ head: '', tail: '' })
})

test('a path under the home folder starts with a tilde, its own separators kept', () => {
  expect(tildePath('C:\\Users\\me\\Projects\\x', 'C:\\Users\\me')).toBe('~\\Projects\\x')
  expect(tildePath('/home/me/src', '/home/me')).toBe('~/src')
  expect(tildePath('/home/me', '/home/me')).toBe('~')
  // either slash matches either, and a Windows path matches in any case
  expect(tildePath('C:/Users/me/Projects/x', 'C:\\Users\\me')).toBe('~/Projects/x')
  expect(tildePath('c:\\users\\ME\\x', 'C:\\Users\\me')).toBe('~\\x')
  expect(tildePath('C:\\Users\\me\\x', 'C:\\Users\\me\\')).toBe('~\\x')
  // a POSIX path is case-sensitive, and a folder that only starts with the home's name is not under it
  expect(tildePath('/home/Me/src', '/home/me')).toBe('/home/Me/src')
  expect(tildePath('C:\\Users\\meg\\x', 'C:\\Users\\me')).toBe('C:\\Users\\meg\\x')
  expect(tildePath('D:\\work', 'C:\\Users\\me')).toBe('D:\\work')
  // no home, or a home of only slashes, changes nothing
  expect(tildePath('/home/me/src', '')).toBe('/home/me/src')
  expect(tildePath('/home/me/src', '/')).toBe('/home/me/src')
})

test('the 5-hour forecast reads in words, each short enough to sit beside ARIA', () => {
  const lines = [
    forecastLine({ kind: 'hits', ms: 80 * MIN }),
    forecastLine({ kind: 'safe' }),
    forecastLine({ kind: 'steady' }),
    forecastLine({ kind: 'learning' }),
  ]
  expect(lines).toEqual(['5h out in ~1h 20m', '5h safe till reset', '5h pace steady', '5h learning the pace'])
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(23)
})

test('every mood and zone has its line', () => {
  expect((['sleep', 'happy', 'focus', 'alarm'] as const).map(moodLine)).toEqual([
    'Napping',
    'Cruising',
    'Watch the pace',
    'Time to /compact',
  ])
  expect((['green', 'amber', 'red'] as const).map(zoneLabel)).toEqual(['sharp', 'compact at a break', 'compact now'])
})

// ---------------------------------------------------------------- cache and flight

const turn = (read: number, fresh: number): HudCacheTurn =>
  ({ at: 0, ...cacheHit({ input_tokens: fresh, cache_read_input_tokens: read, cache_creation_input_tokens: 0 }) }) as HudCacheTurn

test('no turns yet: the bill is even and the cache is cold', () => {
  expect(cacheTotals([])).toMatchObject({ billed: 0, uncached: 0, ratio: 1 })
  expect(cacheWarmth([], 0)).toBe(0)
  // a reply with no input at all served nothing, rather than a share of nothing
  expect(turn(0, 0).hit).toBe(0)
})

test('flight rows name the tool and say what each call did', () => {
  expect(['Bash', 'PowerShell', 'Edit', 'Grep', 'Skill', 'WebFetch', 'mcp__x__y', 'Other', 'BashX'].map(toolColor)).toEqual([
    0xf0883e, 0xf0883e, 0x3fb950, 0x58a6ff, 0xbc8cff, 0x39c5cf, 0xf778ba, 0x8b949e, 0x8b949e,
  ])
  expect(callLabel({ command: '  npm test\nmore' })).toBe('npm test')
  // what the call says it does reads better than the command that does it
  expect(callLabel({ description: 'Run the tests', command: 'c' })).toBe('Run the tests')
  expect(callLabel({ command: 'c', description: '  ' })).toBe('c')
  // where a command runs is not what it does: leading cds go, quoted or bare, ; or &&
  expect(callLabel({ command: 'cd /c/work/site; npm test' })).toBe('npm test')
  expect(callLabel({ command: 'cd "C:\\My Work" && cd sub; git push' })).toBe('git push')
  expect(callLabel({ command: "cd 'a b';python - <<'EOF'" })).toBe("python - <<'EOF'")
  // a cd alone, or with nothing after it, stays as it is
  expect(callLabel({ command: 'cd /c/work/site' })).toBe('cd /c/work/site')
  expect(callLabel({ command: 'cd /c/work/site;' })).toBe('cd /c/work/site;')
  expect(callLabel({ file_path: 'C:\\a\\b.ts' })).toBe('b.ts')
  expect(callLabel({ command: 5, pattern: 'foo' })).toBe('foo')
  expect(callLabel({})).toBe('')
  expect(shortTool('mcp__github__get_issue')).toBe('get_issue')
  expect(shortTool('mcp__weird')).toBe('mcp__weird')
  expect(shortTool('Bash')).toBe('Bash')
})

test('a reply touches the files whose lines moved between two readings, by any tool, never across a commit', () => {
  const tree = (head: string, numstat: string, files: { code: 'M' | '?'; path: string }[] = []) => treeOf(head, numstat, files)
  expect(numstatFiles('3\t1\ta.ts\n-\t-\tlogo.png\n\nbad line\n5\t0\t')).toEqual({ 'a.ts': { added: 3, removed: 1 }, 'logo.png': { added: 0, removed: 0 } })
  // an untracked file has no lines yet, and is new; one numstat already lists keeps its lines
  expect(tree('h', '2\t0\tb.ts', [{ code: '?', path: 'n.md' }, { code: '?', path: 'b.ts' }, { code: 'M', path: 'c.ts' }]).files).toEqual({
    'b.ts': { added: 2, removed: 0 },
    'n.md': { added: 0, removed: 0, isNew: true },
  })

  const start = tree('h', '3\t1\ta.ts')
  // no base yet: the first reading only sets it
  expect(touchFiles([], undefined, start)).toEqual([])
  // nothing moved: nothing touched
  expect(touchFiles([], start, start)).toEqual([])
  // a.ts grows by 4 and loses 2 more; b.ts changes for the first time; an untracked file appears
  const edited = tree('h', '7\t3\ta.ts\n1\t1\tb.ts', [{ code: '?', path: 'new.md' }])
  const touched = touchFiles([], start, edited)
  expect(touched).toEqual([
    { path: 'a.ts', added: 4, removed: 2 },
    { path: 'b.ts', added: 1, removed: 1 },
    { path: 'new.md', added: 0, removed: 0, isNew: true },
  ])
  // b.ts put back as it was, and new.md deleted: undoing an addition is a removal, and the other way round
  const reverted = tree('h', '7\t3\ta.ts')
  expect(touchFiles(touched, edited, reverted)).toEqual([
    { path: 'a.ts', added: 4, removed: 2 },
    { path: 'b.ts', added: 2, removed: 2 },
    { path: 'new.md', added: 0, removed: 0 },
  ])
  // a commit empties the diff: that is no edit, so nothing changes
  expect(touchFiles(touched, edited, tree('h2', ''))).toEqual(touched)

  // a path fits its column from its end, where its name is
  expect(fitStart('hooks/register.tsx', 30)).toBe('hooks/register.tsx')
  expect(fitStart('plugins/session-hud/hooks/register.tsx', 16)).toBe('…ks/register.tsx')
})

test('durations read in tenths under ten seconds, then seconds, then minutes', () => {
  expect(formatSeconds(0)).toBe('0.0s')
  expect(formatSeconds(9_940)).toBe('9.9s')
  expect(formatSeconds(10_000)).toBe('10s')
  expect(formatSeconds(59_400)).toBe('59s')
  expect(formatSeconds(61_000)).toBe('1m 01s')
  expect(formatSeconds(3_600_000)).toBe('60m 00s')
})

test('a duration that rounds up to the next unit is written in that unit', () => {
  // 59.6s rounds to 60s, which is a minute; 9.96s rounds to 10s, which drops the tenths
  expect(formatSeconds(59_600)).toBe('1m 00s')
  expect(formatSeconds(59_999)).toBe('1m 00s')
  expect(formatSeconds(9_960)).toBe('10s')
  expect(formatSeconds(9_949)).toBe('9.9s')
})

test('cells are shared out in proportion, and every weighted category gets one while they last', () => {
  expect(allocate([3, 1], 8)).toEqual([6, 2])
  expect(allocate([98, 1, 1], 5)).toEqual([3, 1, 1])
  // fewer cells than categories: the largest shares win, no minimum
  expect(allocate([98, 1, 1], 2)).toEqual([2, 0, 0])
  // no weight at all: the first takes everything; a zero or negative weight gets nothing
  expect(allocate([0, 0], 4)).toEqual([4, 0])
  expect(allocate([], 4)).toEqual([])
  expect(allocate([5, 0, -1], 3)).toEqual([3, 0, 0])
  expect(allocate([1, 1], 0)).toEqual([0, 0])
})

test('the legend lists every category up to four, then sums the rest into other', () => {
  const part = (name: string, tokens: number) => ({ name, tokens })
  expect(legendParts([part('a', 5), part('b', 3)])).toEqual([part('a', 5), part('b', 3)])
  expect(legendParts([part('a', 5), part('b', 3), part('c', 2), part('d', 1), part('e', 1)])).toEqual([
    part('a', 5),
    part('b', 3),
    part('c', 2),
    part('other', 2),
  ])
  expect(legendParts([part('a', 5), part('b', 3), part('c', 2)], 2)).toEqual([part('a', 5), part('other', 5)])
})

test('the bar off the terminal fills in each category pattern, and dots for the rest', () => {
  expect(patternBar(50, 8, [3, 1])).toEqual({ full: '███▓', empty: '····' })
  expect(patternBar(50, 4)).toEqual({ full: '██', empty: '··' })
  expect(patternBar(150, 2, [1, 1])).toEqual({ full: '█▓', empty: '' })
  expect(patternBar(-5, 2, [1])).toEqual({ full: '', empty: '··' })
})

test('the context train: as many cars as fit beside the engine, loaded from the back, compaction in the car that holds it', () => {
  // 40 columns: the engine's 5, then three cars of 9 columns, 18 cells of cargo
  expect(trainCars(38, 40, [2, 1], 40)).toEqual({ cars: ['█████▓', '▓·····', '······'], compactCar: 1 })
  // a column short of a fourth car still makes three
  expect(trainCars(0, 40, [], 90).cars).toHaveLength(3)
  expect(trainCars(0, 41, [], 90).cars).toHaveLength(4)
  // full, with compaction at or past the end, sits in the last car
  expect(trainCars(100, 23, [], 100)).toEqual({ cars: ['██████', '██████'], compactCar: 1 })
  // too narrow for one car still draws one; a negative point sits in the first
  expect(trainCars(50, 3, [], -10)).toEqual({ cars: ['███···'], compactCar: 0 })
})

test('git log is read one commit per record, a merge without a stat line counting zero', () => {
  // One record per commit, as LOG_FORMAT asks for: 0x1e, the hash, 0x1f, the subject.
  const commit = (hash: string, subject: string) => `\x1e${hash}\x1f${subject}`
  const out = [
    commit('abc1234', 'Add the Commits tab'),
    '',
    ' 3 files changed, 120 insertions(+), 14 deletions(-)',
    commit('def5678', 'Merge branch x'),
    commit('0a1b2c3', 'One file, only added'),
    '',
    ' 1 file changed, 1 insertion(+)',
    commit('9f8e7d6', 'Only removed'),
    '',
    ' 1 file changed, 2 deletions(-)',
    '',
  ].join('\n')
  expect(parseLog(out)).toEqual([
    { hash: 'abc1234', subject: 'Add the Commits tab', files: 3, added: 120, removed: 14 },
    { hash: 'def5678', subject: 'Merge branch x', files: 0, added: 0, removed: 0 },
    { hash: '0a1b2c3', subject: 'One file, only added', files: 1, added: 1, removed: 0 },
    { hash: '9f8e7d6', subject: 'Only removed', files: 1, added: 0, removed: 2 },
  ])
  expect(parseLog('')).toEqual([])
  expect(parseLog('fatal: not a git repository')).toEqual([])
})

test('the dispatcher ranks what matters most first, each short, and says all is clear with nothing to say', () => {
  const MIN = 60_000
  const calm = { uncommitted: { files: 0, lines: 0 }, stale: { count: 0, memMb: 0 }, update: '' }
  const keys = (d: Parameters<typeof dispatches>[0]) => dispatches(d).map(x => x.key)
  // everything at once: the 5-hour window within the hour, overdue compaction,
  // the cache's last quarter, then the rest
  const all = {
    limit: { ms: 38 * MIN, resetsInMs: 125 * MIN },
    cache: { leftMs: 12 * MIN, tokens: 312_000 },
    advice: { text: 'Compact now · 700k', color: '#f85149' },
    uncommitted: { files: 4, lines: 420 },
    stale: { count: 2, memMb: 1_434 },
    update: '2.1.300',
  }
  expect(dispatches(all)).toEqual([
    { key: 'limit', text: '5h limit in ~38m · resets 2h 05m', hex: '#f85149' },
    { key: 'compact', text: 'Compact now · 700k', hex: '#f85149', action: 'prep' },
    { key: 'cache', text: '❄ cold in 12m · re-cache 312k', hex: '#d29922' },
    { key: 'uncommitted', text: '420 lines uncommitted · 4 files', hex: '#d29922' },
    { key: 'stale', text: '2 stale procs · 1.4 GB', hex: '#d29922', action: 'procs' },
    { key: 'update', text: '2.1.300 out', hex: '#d2a8ff', action: 'read' },
  ])
  // advice short of overdue comes after the cache; the window running out later, amber, after it
  const later = { ...calm, limit: { ms: 3 * 60 * MIN }, cache: { leftMs: MIN, tokens: 5_000 }, advice: { text: 'Good moment to /compact', color: '#3fb950' } }
  expect(keys(later)).toEqual(['cache', 'compact', 'limit'])
  expect(dispatches(later)[2]).toEqual({ key: 'limit', text: '5h limit in ~3h 00m', hex: '#d29922' })
  // fifteen files are worth a word however few lines; one stale process in megabytes
  expect(dispatches({ ...calm, uncommitted: { files: 15, lines: 10 } })[0]?.text).toBe('10 lines uncommitted · 15 files')
  expect(dispatches({ ...calm, uncommitted: { files: 1, lines: 300 } })[0]?.text).toBe('300 lines uncommitted · 1 file')
  expect(dispatches({ ...calm, uncommitted: { files: 14, lines: 299 } })[0]?.key).toBe('clear')
  expect(dispatches({ ...calm, stale: { count: 1, memMb: 512 } })[0]?.text).toBe('1 stale proc · 512 MB')
  // a cache with more than a quarter left is quiet: all clear says how long (the 5-hour pace is ARIA's)
  expect(dispatches({ ...calm, cache: { leftMs: 40 * MIN, tokens: 1 } })).toEqual([
    { key: 'clear', text: '✓ All clear · ❄ 40m', hex: '#6e7681' },
  ])
  expect(dispatches(calm)).toEqual([{ key: 'clear', text: '✓ All clear', hex: '#6e7681' }])
  expect(formatMb(512)).toBe('512 MB')
  expect(formatMb(1_536)).toBe('1.5 GB')
})
