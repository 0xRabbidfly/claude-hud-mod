import { expect, mock, test } from 'claude-code/testing'

import { parseKeepList } from '../hooks/compact'
import { fingerprint, parseStatus } from '../hooks/lib'
import { cacheHit, prefixOf } from '../hooks/panels'
import { ancestorsOf, buildProcs, canEnd, endScript, parsePsScan, parseWindowsScan, procState, tidyCommand } from '../hooks/procs'
import type { TreeNode } from '../hooks/procs'

// Each test here pins a bug found in the 0.8.1 review: the input that showed it, and the right answer.

const tree = (...nodes: Array<[number, number, string]>): Map<number, TreeNode> =>
  new Map(nodes.map(([pid, ppid, name]) => [pid, { pid, ppid, start: 1, name }]))

// ---------------------------------------------------------------- ending processes

test('End is never offered on a process that holds this session: ending it ends its tree', () => {
  // Claude Desktop (100) runs this session (200) as a child; taskkill /T on 100 would end it.
  const rows = [
    { pid: 100, name: 'claude.exe', start: 1, mem: 300, cpu: 5, cmd: 'claude.exe' },
    { pid: 101, name: 'claude.exe', start: 1, mem: 50, cpu: 1, cmd: 'claude.exe --type=renderer' },
    { pid: 200, name: 'claude.exe', start: 1, mem: 200, cpu: 9, cmd: 'claude.exe' },
    { pid: 500, name: 'node.exe', start: 1, mem: 40, cpu: 1, cmd: 'node npx-cli.js @anthropic-ai/claude-code' },
    { pid: 501, name: 'claude.exe', start: 1, mem: 40, cpu: 1, cmd: 'claude' },
  ]
  const stdout = [
    '@@ROWS@@' + JSON.stringify(rows),
    '@@TREE@@4:0:1:explorer.exe|100:4:1:claude.exe|101:100:1:claude.exe|200:100:1:claude.exe|300:200:1:powershell.exe|500:4:1:node.exe|501:500:1:claude.exe',
    '@@CHAIN@@300,200',
  ].join('\n')
  const procs = buildProcs(parseWindowsScan(stdout), [], 1_000, 1_000)
  const desktop = procs.find(p => p.pid === 100)!
  expect(desktop.state).toBe('protected')
  expect(canEnd(desktop)).toBe(false)
  // And when this session is the npx-launched one, the npx wrapper above it is held too.
  const viaNpx = buildProcs(parseWindowsScan(stdout), [], 1_000, 1_000, [501])
  expect(canEnd(viaNpx.find(p => p.pid === 500)!)).toBe(false)
})

test('the desktop app, the daemon and a background host hold other sessions and are never offered', () => {
  const base = { pid: 2, name: 'claude' as const, startedAt: 0, memMb: 1, cpuSec: 0, activeAt: 0, state: 'owned' as const, command: '' }
  for (const kind of ['desktop app', 'daemon', 'background host']) expect(canEnd({ ...base, kind })).toBe(false)
  expect(canEnd({ ...base, kind: 'background session' })).toBe(true)
})

test('a console window or a macOS Terminal tab is a tab, never unowned', () => {
  const t = tree(
    [1, 0, 'launchd'],
    [10, 1, 'terminal'], //         Terminal.app, started by launchd
    [11, 10, 'login'],
    [12, 11, '-zsh'],
    [13, 12, 'claude'], //          a live session in a Terminal tab
    [20, 1, 'wezterm-gui'],
    [21, 20, 'zsh'],
    [22, 21, 'claude'],
    [4, 0, 'explorer.exe'],
    [30, 4, 'powershell.exe'], //   a plain PowerShell window
    [31, 30, 'claude.exe'],
    [40, 999, 'bash'], //           an orphaned shell stays unowned
    [41, 40, 'node'],
  )
  const none = new Set<number>()
  expect(procState(13, t, none, none)).toBe('protected')
  expect(procState(22, t, none, none)).toBe('protected')
  expect(procState(31, t, none, none)).toBe('protected')
  expect(procState(41, t, none, none)).toBe('unowned')
})

test('ancestors stop at a reused pid and at a loop', () => {
  const t = new Map<number, TreeNode>([
    [1, { pid: 1, ppid: 2, start: 10, name: 'a' }],
    [2, { pid: 2, ppid: 3, start: 5_000, name: 'b' }], // seconds younger than its child: a reused pid
    [7, { pid: 7, ppid: 8, start: 1, name: 'c' }],
    [8, { pid: 8, ppid: 7, start: 1, name: 'd' }],
  ])
  expect([...ancestorsOf([1], t)]).toEqual([])
  expect([...ancestorsOf([7], t)].sort((a, b) => a - b)).toEqual([7, 8])
})

test('the Windows end script checks the start time in the same call, and takes numbers only', () => {
  const script = endScript(4242, 1_700_000_000_123)
  expect(script).toContain("Filter 'ProcessId=4242'")
  expect(script).toContain('[math]::Abs($ms - 1700000000123) -ge 2000')
  expect(script).toContain('taskkill /PID 4242 /T /F')
  expect(endScript(Number.NaN, 0)).toBe('exit 3')
  expect(endScript(-1, 0)).toBe('exit 3')
})

test('the macOS and Linux scan reads names with spaces and BSD elapsed times', () => {
  const stdout = [
    '@@ME@@ 900',
    '  1     0       10-01:00:00  1000  0:01.00 /sbin/launchd',
    '  50    1          02:30:00  2048  1:02.50 /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '  900   50            05:00 40960  0:30.00 node /usr/local/bin/claude',
    '@@COMM@@',
    '  1 /sbin/launchd',
    '  50 /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '  900 node',
  ].join('\n')
  const now = 1_000_000_000
  const scan = parsePsScan(stdout, now)
  expect(scan.tree.get(50)?.name).toBe('electron')
  expect(scan.tree.get(50)?.start).toBe(now - 2.5 * 3600 * 1000)
  expect(scan.tree.get(1)?.start).toBe(now - (10 * 86_400 + 3600) * 1000)
  expect(scan.rows).toHaveLength(1)
  expect(scan.rows[0]).toMatchObject({ pid: 900, name: 'node', mem: 40, cpu: 30 })
  expect(scan.chain).toEqual([900])
})

// ---------------------------------------------------------------- credentials

test('credentials in every shape found in review stay out of the shared scan', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['node a.js --pass hunter2', 'hunter2'],
    ['curl -u bob:hunter2 https://x', 'hunter2'],
    ['node a.js --credentials abcdef', 'abcdef'],
    ['node a.js MYAPP_CREDENTIALS=abcdef', 'abcdef'],
    ['node a.js DefaultEndpointsProtocol=https;AccountName=x;AccountKey=c2VjcmV0a2V5PT0=;EndpointSuffix=core', 'c2VjcmV0a2V5PT0='],
    ['node a.js --jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-x', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
    ['node a.js eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-x', 'abcDEF123_-x'],
    ["node a.js --token 'two words'", 'words'],
    ['npm config set //registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm_abcdefghij'],
    ['node a.js npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm_abcdefghij'],
    ['node a.js glpat-abcdefghijklmnopqrstu', 'glpat-abcdefghij'],
    ['node a.js sk_live_abcdefghijklmnop1234', 'sk_live_abcdef'],
    // Assembled at run time: as one literal, secret scanners (Sonar's S6334) read this fake as a leaked key.
    [`node a.js ${'AIza'}SyA-abcdefghijklmnopqrstuvwxyz12345`, 'SyA-abcdef'],
    ['node a.js "-----BEGIN RSA PRIVATE KEY-----MIIEow-----END RSA PRIVATE KEY-----"', 'MIIEow'],
    ['node notify.js https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX', 'XXXXXXXX'],
    ['node a.js https://acct.blob.core.windows.net/c/f?sv=2024&sig=abcDEF%2B123', 'abcDEF'],
    ['node a.js --clientSecret: s3cr3tvalue', 's3cr3tvalue'],
  ]
  for (const [raw, secret] of cases) expect(tidyCommand(raw)).not.toContain(secret)
})

test('a URL keeps its host and loses its path, and words that merely contain a secret name are kept', () => {
  expect(tidyCommand('node fetch.js https://api.example.com/v1/users?id=7')).toBe('node fetch.js https://api.example.com/…')
  expect(tidyCommand('node fetch.js https://api.example.com')).toBe('node fetch.js https://api.example.com')
  expect(tidyCommand('node a.js --bypass-cache --monkey banana --passes 3')).toBe('node a.js --bypass-cache --monkey banana --passes 3')
  expect(tidyCommand('node a.js --hotkey=ctrl')).toBe('node a.js --hotkey=ctrl')
})

test('the added credential shapes still tidy a long argument in linear time', () => {
  for (const arg of ['aB'.repeat(20_000), 'eyJ'.repeat(20_000), '-u '.repeat(10_000), 'https://'.repeat(5_000)]) {
    const started = performance.now()
    tidyCommand(`node ${arg}x=`)
    expect(performance.now() - started).toBeLessThan(150)
  }
})

// ---------------------------------------------------------------- against 0.8.0
// Each of these answered right in 0.8.0 and wrong in an early 0.8.1 draft.

test('on macOS and Linux an orphaned shell is not a window: what it left running can still be ended', () => {
  const none = new Set<number>()
  // the shell's session exited and it was re-parented to launchd: its dev server is unowned, as in 0.8.0
  expect(procState(41, tree([1, 0, 'launchd'], [40, 1, 'zsh'], [41, 40, 'node']), none, none)).toBe('unowned')
  expect(procState(41, tree([40, 1, 'bash'], [41, 40, 'node']), none, none)).toBe('unowned')
  // ...and re-parented to systemd --user, it is owned by the system, so End is offered
  expect(procState(41, tree([1, 0, 'systemd'], [900, 1, 'systemd'], [40, 900, 'bash'], [41, 40, 'node']), none, none)).toBe('owned')
  // a login shell on a tty, and a console the Windows desktop opened, are windows someone has open
  expect(procState(41, tree([1, 0, 'systemd'], [30, 1, 'login'], [40, 30, '-bash'], [41, 40, 'node']), none, none)).toBe('protected')
  expect(procState(41, tree([1, 0, 'launchd'], [40, 1, '-zsh'], [41, 40, 'node']), none, none)).toBe('protected')
  // a shell a Windows service started is not one
  expect(procState(41, tree([5, 0, 'services.exe'], [40, 5, 'cmd.exe'], [41, 40, 'node.exe']), none, none)).toBe('owned')
})

// ---------------------------------------------------------------- found by Sonar's backtracking rule
// Each of these took quadratic time on hostile input: 80,000 characters cost up to 23 s, blocking
// the tool call that produced them. Each now takes a few milliseconds.

test('hostile output and command lines are read in linear time', () => {
  const N = 80_000
  const cases: ReadonlyArray<readonly [string, () => unknown]> = [
    ['a keep-list line of spaces', () => parseKeepList('- ' + ' '.repeat(N) + 'x' + ' '.repeat(N) + 'y')],
    ['a command line of slashes', () => tidyCommand('node ' + '/'.repeat(N) + ' x')],
  ]
  // Each case takes tens of milliseconds; quadratic time costs seconds. The bound sits between the
  // two, far enough above the first that a busy machine does not fail it.
  for (const [, run] of cases) {
    const started = performance.now()
    run()
    expect(performance.now() - started).toBeLessThan(1000)
  }
})

test('a keep-list line may end in a lone carriage return or a Unicode separator', () => {
  const separator = String.fromCodePoint(0x2028)
  expect(parseKeepList(`- foo\r\n- bar \r\r\n- baz${separator}`).map(i => i.text)).toEqual(['foo', 'bar', 'baz'])
  // text after the separator means the line is not one item
  expect(parseKeepList(`- a${separator}b`)).toEqual([])
})

test('a bullet with nothing after it is not a keep-list item', () => {
  expect(parseKeepList('-   \n- keep this  \n*\t\n1.  ')).toEqual([{ text: 'keep this', keep: true }])
})

test("the tool roster's fingerprint is sorted by code units, as before, not by locale", () => {
  // `sort()`'s order: by UTF-16 code unit, so upper case before lower case, and É after both.
  const roster = ['mcp__x', 'Édit', 'Read', 'edit', 'Bash']
  expect(prefixOf('m', roster, []).tools).toBe(fingerprint(['Bash', 'Read', 'edit', 'mcp__x', 'Édit'].join('\n')))
})

// ---------------------------------------------------------------- found while documenting
// Each of these was found reading the code closely enough to document it.

test("git's quoted paths come back as written: UTF-8 octal escapes, C escapes and astral characters", () => {
  const paths = (...lines: string[]) => parseStatus(lines.join('\n')).files.map(f => f.path)
  expect(paths('?? "caf\\303\\251.ts"', '?? "\\346\\227\\245\\346\\234\\254.md"')).toEqual(['café.ts', '日本.md'])
  expect(paths(' M "tab\\there.ts"', ' M "quote\\"and\\\\slash.ts"')).toEqual(['tab\there.ts', 'quote"and\\slash.ts'])
  // a character outside the BMP, and a backslash with nothing after it, are kept
  expect(paths(' M "rocket 🚀.ts"', ' M "end\\"')).toEqual(['rocket 🚀.ts', 'end\\'])
})

test('a command line that holds a section tag cannot cut the Windows scan short', () => {
  const rows = [{ pid: 20, name: 'node.exe', start: 1, mem: 1, cpu: 1, cmd: 'node grep.js @@TREE@@ 1:2:3:x @@CHAIN@@ 9' }]
  const scan = parseWindowsScan(['@@ROWS@@' + JSON.stringify(rows), '@@TREE@@20:4:1:node.exe', '@@CHAIN@@20'].join('\r\n'))
  expect(scan.rows.map(r => r.cmd)).toEqual([rows[0]!.cmd])
  expect([...scan.tree.keys()]).toEqual([20])
  expect(scan.chain).toEqual([20])
})

test("only the desktop app's own claude helpers are folded away; a node --type= option is the program's", () => {
  const rows = [
    { pid: 10, name: 'claude.exe', start: 1, mem: 1, cpu: 1, cmd: 'claude' },
    { pid: 11, name: 'node.exe', start: 1, mem: 1, cpu: 1, cmd: 'node tool.js --type=module' },
  ]
  const procs = buildProcs(parseWindowsScan(['@@ROWS@@' + JSON.stringify(rows), '@@TREE@@10:999:1:claude.exe|11:10:1:node.exe', '@@CHAIN@@'].join('\n')), [], 5, 5, [])
  expect(procs.map(p => [p.pid, p.kind])).toEqual([
    [10, 'session'],
    [11, ''],
  ])
  expect(canEnd(procs.find(p => p.pid === 10)!)).toBe(true)
})

const PROCS_PANE = { title: 'Session', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } as const

test('the End prompt says what ending does on this machine: the whole tree only where it is', async ($, on) => {
  const now = 1_800_000_000_000
  mock.clock(on, { now })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no scan in tests', isStdoutTruncated: false, isStderrTruncated: false } }))
  const proc = { pid: 4242, name: 'node', startedAt: now - 60 * 60_000, memMb: 50, cpuSec: 1, activeAt: now - 60 * 60_000, state: 'unowned', kind: '', command: 'node dev.js' }
  let endsTree = true
  on('state.get', ($, e, next) => {
    if (e.key === 'tab') return { value: { value: 'procs', version: 1 } }
    if (e.key === 'procs') return { value: { value: { at: now, list: [proc], endsTree }, version: 1 } }
    if (e.key === 'confirmPid') return { value: { value: 4242, version: 1 } }
    return next(e)
  })
  for (const isWindows of [true, false]) {
    endsTree = isWindows
    const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PROCS_PANE })
    const prompt = await ui.find({ type: 'Text', text: /^End 4242/ })
    expect(prompt?.text).toBe(endsTree ? 'End 4242 and its children? ' : 'End 4242? ')
    await ui.unmount()
  }
})

// ---------------------------------------------------------------- cache

test('a usage that leaves a field out never prices the session as NaN', () => {
  const hit = cacheHit({ input_tokens: 10 } as never)
  expect(hit).toEqual({ hit: 0, total: 10, read: 0, write: 0, fresh: 10 })
})

// ---------------------------------------------------------------- lifecycle

const DIALOG = { title: 'Prep compact', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

test('Prep compact recovers when the draft fork throws, and can draft again', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let calls = 0
  on('model.fork', () => {
    calls += 1
    if (calls === 1) throw new Error('network down')
    return { value: { isAnswered: true, text: '- Keep the deploy order', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-compact', props: DIALOG })
  await ui.input({ key: 'steer', text: '' })
  expect(await ui.find({ type: 'Text', text: /the draft failed/ })).toBeDefined()
  await ui.input({ key: 'steer', text: '' })
  expect(calls).toBe(2)
  expect(await ui.find({ type: 'Text', text: /Keep the deploy order/ })).toBeDefined()
  await ui.unmount()
})
