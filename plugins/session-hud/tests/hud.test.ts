import { expect, mock, test } from 'claude-code/testing'

import { base64, compareVersions, formatTokens, gradient, legendLabels, manifestVersion, marketplaceVersion, parseNumstat, parseStatus, partName, partShort, pluginSource, zoneHex, zoneRuns } from '../hooks/lib'

const STATUS = [
  '## development...origin/development [ahead 2, behind 1]',
  ' M lib/a.ts',
  'M  lib/b.ts',
  'A  lib/new.ts',
  ' D lib/gone.ts',
  'R  old.ts -> renamed.ts',
  '?? scratch.txt',
].join('\n')

const NUMSTAT = '10\t2\tlib/a.ts\n5\t0\tlib/b.ts\n-\t-\timage.png\n'

const PANE_PROPS = {
  title: 'Session',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

test('parses branch, tracking and file codes from porcelain status', () => {
  const s = parseStatus(STATUS)
  expect(s.branch).toBe('development')
  expect(s.upstream).toBe('origin/development')
  expect(s.ahead).toBe(2)
  expect(s.behind).toBe(1)
  expect(s.files.map(f => f.code).join('')).toBe('MMADR?')
  expect(s.files[4]!.path).toBe('renamed.ts')
})

test('parses a repo with no commits and a detached head', () => {
  expect(parseStatus('## No commits yet on main\n').branch).toBe('main')
  expect(parseStatus('## HEAD (no branch)\n').branch).toBe('detached HEAD')
})

test('sums numstat lines, binary files counting zero', () => {
  expect(parseNumstat(NUMSTAT)).toEqual({ added: 15, removed: 2 })
})

test('gradient runs green to dark red', () => {
  expect(gradient(0)).toBe(0x3fb950)
  expect(gradient(1)).toBe(0xa40e26)
})

test('base64 matches the standard encoding', () => {
  const bytes = new Uint8Array([77, 97, 110, 77, 97])
  expect(base64(bytes)).toBe('TWFuTWE=')
})

test('the pane draws every station, and the context as a patterned bar on every surface', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'session-hud',
      surface,
      component: 'Pane',
      requestId: 'session-hud',
      props: PANE_PROPS,
    })
    for (const station of ['CLAUDE', 'CONTEXT', 'COMPACT']) {
      expect(await ui.find({ type: 'Text', text: station })).toBeDefined()
    }
    // the session's station is its name, a button: before it has one, SESSION
    expect((await ui.find({ key: 'session-name' }))?.props.label).toBe('SESSION')
    expect(await ui.find({ key: 'context-bar' })).toBeDefined()
    expect(await ui.find({ key: 'ring' })).toBeUndefined()
    await ui.unmount()
  }
})

test('/hud fills the git section from git output', async ($, on) => {
  on('process.run', ($, e) => {
    const byCommand: Record<string, string> = { status: STATUS, diff: NUMSTAT }
    const stdout = byCommand[e.argv.slice(3)[0] ?? ''] ?? 'abc1234 feat: thing'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.cwd', () => ({ value: 'C:\\work\\AI-HUB-Portal' }))
  on('session.turns', () => ({ value: 3 }))
  mock.clock(on, { now: 1_800_000_000_000 })

  await $.command.run({
    command: 'hud',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

  const ui = await $.ui.mount({
    plugin: 'session-hud',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-hud',
    props: PANE_PROPS,
  })
  expect(await ui.find({ type: 'Text', text: 'development' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+15' })).toBeDefined()
  // the last commit is the Commits tab's to show, not the Hub's
  expect(await ui.find({ type: 'Text', text: /abc1234 feat: thing/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'AI-HUB-Portal' })).toBeDefined()
  expect((await ui.find({ key: 'claude-model' }))?.props.label).toBe('claude-opus-5-5[1m]')
  // no check lights anywhere: not on the git loop, not under the digest
  expect(await ui.find({ key: 'git-lights' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /no signals yet|^● [a-z]/ })).toBeUndefined()
  await ui.unmount()
})

test('/hud commits lists the branch last commits: hash, files and lines, then the subject', async ($, on) => {
  const log = [
    '\x1eabc1234\x1fAdd the Commits tab',
    '',
    ' 3 files changed, 120 insertions(+), 14 deletions(-)',
    '\x1edef5678\x1fA subject far too long to fit on one row of a forty-column sidebar',
    '',
    ' 1 file changed, 2 deletions(-)',
  ].join('\n')
  const asked: (readonly string[])[] = []
  on('process.run', ($, e) => {
    asked.push(e.argv)
    const byCommand: Record<string, string> = { status: STATUS, diff: NUMSTAT }
    // the remote's default branch, and the branch 5 commits off it, 2 behind it
    const fork: Record<string, string> = { 'symbolic-ref': 'origin/main\n', 'rev-list': '2\t5\n' }
    const own = fork[e.argv[1] ?? '']
    const stdout = e.argv.includes('--shortstat') ? log : (own ?? byCommand[e.argv.slice(3)[0] ?? ''] ?? 'abc1234 Add the Commits tab')
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.cwd', () => ({ value: 'C:/work/site' }))
  on('session.turns', () => ({ value: 3 }))
  mock.clock(on, { now: 1_800_000_000_000 })

  await $.command.run({ command: 'hud', args: 'commits', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  expect(asked.some(argv => argv.join(' ') === 'git log -10 --shortstat --format=%x1e%h%x1f%s')).toBe(true)

  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: 'COMMITS · development' })).toBeDefined()
  // where the branch left the remote's default, counted both ways
  expect(asked.some(argv => argv.join(' ') === 'git rev-list --left-right --count origin/main...HEAD')).toBe(true)
  expect(await ui.find({ type: 'Text', text: '⑂ 5 commits since branching from origin/main' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  origin/main has 2 new since' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^abc1234/ }))?.text).toBe('abc1234  3 files  +120/-14')
  expect((await ui.find({ type: 'Text', text: /^def5678/ }))?.text).toBe('def5678  1 file  +0/-2')
  expect(await ui.find({ type: 'Text', text: '  Add the Commits tab' })).toBeDefined()
  await ui.unmount()
})

test('token counts round up into millions rather than showing 1000k', () => {
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(999_499)).toBe('999k')
  expect(formatTokens(999_600)).toBe('1M')
  expect(formatTokens(1_000_000)).toBe('1M')
  expect(formatTokens(1_500_000)).toBe('1.5M')
})

test('context categories get short labels', () => {
  expect(partName('Messages')).toBe('msgs')
  expect(partName('System prompt')).toBe('system')
  expect(partName('System tools')).toBe('tools')
  expect(partName('MCP tools')).toBe('mcp')
  expect(partName('Memory files')).toBe('memory')
  expect(partName('Skills')).toBe('skills')
  expect(partName('Something new')).toBe('something new')
  // in three letters for the legend's one row; one it does not know keeps its first three
  expect(['Messages', 'System prompt', 'System tools', 'MCP tools', 'Custom agents', 'Memory files', 'Skills', 'Plugins', 'Slash commands', 'other'].map(partShort)).toEqual([
    'msg', 'sys', 'tls', 'mcp', 'agt', 'mem', 'skl', 'plg', 'cmd', 'oth',
  ])
  expect(partShort('Something new')).toBe('som')
  // the legend's labels: with their names where all fit, a swatch before each and a space between; else the tokens alone
  const parts = [
    { name: 'Messages', tokens: 1_200_000 },
    { name: 'System tools', tokens: 40_000 },
    { name: 'Skills', tokens: 812 },
  ]
  expect(legendLabels(parts, 27)).toEqual(['msg 1.2M', 'tls 40k', 'skl 812'])
  expect(legendLabels(parts, 26)).toEqual(['1.2M', '40k', '812'])
  expect(legendLabels([], 10)).toEqual([])
})

test('the curled track is green its first 60%, amber the next 30%, red the last 10%', () => {
  const [green, amber, red] = ['#3fb950', '#d29922', '#f85149']
  expect([0, 5, 6, 8, 9, 10].map(c => zoneHex(c, 11))).toEqual([green, green, amber, amber, red, red])
  expect(zoneHex(0, 1)).toBe(green)
  expect(zoneRuns(0, 10, 11)).toEqual([
    { from: 0, to: 6, hex: green },
    { from: 6, to: 9, hex: amber },
    { from: 9, to: 10, hex: red },
  ])
  expect(zoneRuns(7, 7, 11)).toEqual([])
})

test('a newer release is told apart part by part, and a dev suffix is ignored', () => {
  expect(compareVersions('2.1.300', '2.1.289')).toBeGreaterThan(0)
  expect(compareVersions('2.1.289', '2.1.289')).toBe(0)
  expect(compareVersions('2.1.289', '2.1.289-dev.20261004')).toBe(0)
  expect(compareVersions('2.2.0', '2.10.0')).toBeLessThan(0)
})

test('a reply touches what changed in git while it ran, by any tool: a shell edit counts, edits before it do not', async ($, on) => {
  let status = '## main\n M src/old.ts\n'
  let numstat = '5\t0\tsrc/old.ts\n'
  on('process.run', ($, e) => {
    const byCommand: Record<string, string> = { status, diff: numstat, 'rev-parse': 'C:/work/site\n' }
    const stdout = byCommand[e.argv.slice(3)[0] ?? ''] ?? 'abc1234 x'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {}, text: '' }) as never)
  mock.clock(on, { now: 1_800_000_000_000 })
  // git is read fire-and-forget: give that reading a moment to land. The test's types know no timers.
  const { setTimeout: later } = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => void }
  const settle = () => new Promise<void>(resolve => later(resolve, 50))
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  await ui.press({ key: 'tab-turn' })

  // the reply starts with src/old.ts already changed: that is the base, not the reply's work
  await $.turn.start({ text: 'go', turnId: 't1' })
  await settle()
  // a script edits src/old.ts and writes a new file: a Bash call, not an edit tool
  status = '## main\n M src/old.ts\n?? src/new.ts\n'
  numstat = '9\t2\tsrc/old.ts\n'
  await $.tool.call({ tool: 'Bash', command: "python - <<'EOF'", description: 'Rework the digest' } as never)
  await settle()
  // whole rows, not the pencil spans inside them
  const rows = (await ui.findAll({ type: 'Text', text: /^✎ / })).filter(r => r.text.length > 2)
  expect(rows.map(r => r.text.replace(/ {2,}/, ' '))).toEqual(['✎ src/old.ts +4 -2', '✎ src/new.ts new'])
  // the departure is named by what the call said it does
  expect(await ui.find({ type: 'Text', text: /Rework the/ })).toBeDefined()

  // the next reply starts clean
  await $.turn.start({ text: 'again', turnId: 't2' })
  await settle()
  expect(await ui.find({ type: 'Text', text: 'TOUCHED THIS REPLY' })).toBeUndefined()
  await ui.unmount()
})

test('the digest says cache, time and the skills fired', async ($, on) => {
  on('state.get', ($, e, next) => {
    if (e.key !== 'skills') return next(e)
    const fire = { name: 'commit', by: 'you', count: 1, tokens: 500, at: 1 }
    return { value: { value: { fired: [fire, { ...fire, name: 'review' }], chain: [], seen: {}, since: 0 }, version: 1 } }
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  // on the Hub the cache is the dispatcher's band's: the digest is the reply and the skills
  expect((await ui.find({ type: 'Text', text: /│ skills \d+$/ }))?.text).toMatch(/^idle │ skills 2$/)
  await ui.press({ key: 'tab-turn' })
  const digest = await ui.find({ type: 'Text', text: /│ skills \d+$/ })
  // elsewhere the ice cube says it is the cache: the word is not needed, and processes are the Procs tab's
  expect(digest?.text).toMatch(/^❄ — │ idle │ skills 2$/)
  // no check lights in it, nor on a row of their own
  expect(digest?.text).not.toContain('●')
  expect(await ui.find({ type: 'Text', text: /^(● [a-z]|no signals yet)/ })).toBeUndefined()
  await ui.unmount()
})

test('an installed plugin knows its marketplace from where it sits, and reads its version from the marketplace list', () => {
  expect(pluginSource(String.raw`C:\Users\me\.claude\plugins\cache\claude-hud-mod\session-hud\0.19.0`)).toEqual({
    marketplace: 'claude-hud-mod',
    pluginsDir: String.raw`C:\Users\me\.claude\plugins`,
  })
  expect(pluginSource('/home/me/.claude/plugins/cache/claude-hud-mod/session-hud/0.19.0/')).toEqual({ marketplace: 'claude-hud-mod', pluginsDir: '/home/me/.claude/plugins' })
  // a --plugin-dir checkout has no marketplace
  expect(pluginSource('C:/work/claude-plugins/plugins/session-hud')).toBeUndefined()
  const list = JSON.stringify({ plugins: [{ name: 'other', version: '1.0.0' }, null, { name: 'session-hud', version: '0.20.0' }] })
  expect(marketplaceVersion(list, 'session-hud')).toBe('0.20.0')
  expect(marketplaceVersion(list, 'missing')).toBe('')
  expect(marketplaceVersion(JSON.stringify({ plugins: [{ name: 'session-hud' }] }), 'session-hud')).toBe('')
  expect(marketplaceVersion('{"name":"x"}', 'session-hud')).toBe('')
  expect(marketplaceVersion('not json', 'session-hud')).toBe('')
})

test('a newer HUD in the marketplace shows under the plate, with a button that upgrades to it', async ($, on) => {
  on('state.get', ($, e, next) => {
    if (e.key !== 'meta') return next(e)
    const meta = { cwd: 'C:/w', id: '', name: '', model: 'm', effort: 'high', version: '', latest: '', hudVersion: '0.19.0', hudLatest: '0.20.0', committedAt: 0, startedAt: 0, turns: 1, minute: 0 }
    return { value: { value: meta, version: 1 } }
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  const newer = await ui.find({ key: 'hud-newer' })
  expect(newer?.text).toBe('0.20.0 out [Upgrade]')
  expect(newer?.props.justifyContent).toBe('center')
  expect((await ui.find({ key: 'hud-upgrade' }))?.props.label).toBe('[Upgrade]')
  await ui.unmount()
})

test("the HUD's version comes from its manifest, under .claude-plugin/ or beside it", async () => {
  const files: Record<string, string> = {
    '/a/.claude-plugin/plugin.json': '{"name":"session-hud","version":"0.8.0"}',
    '/b/plugin.json': '{"version":"1.2.3"}',
    '/c/.claude-plugin/plugin.json': '{"version":7}',
    '/d/.claude-plugin/plugin.json': 'not json',
  }
  const read = async (path: string) => {
    if (path in files) return files[path] as string
    throw new Error('ENOENT')
  }
  expect(await manifestVersion('/a', read)).toBe('0.8.0')
  expect(await manifestVersion('/b', read)).toBe('1.2.3')
  expect(await manifestVersion('/c', read)).toBe('')
  expect(await manifestVersion('/d', read)).toBe('')
  expect(await manifestVersion('/none', read)).toBe('')
})

test('the hub is a transit line: a band, stations down one track, the context as how far along, a terminus and a plate', async ($, on) => {
  on('state.get', ($, e, next) => {
    if (e.key !== 'meta') return next(e)
    const meta = { cwd: 'C:/work/site', id: '', name: '', model: 'claude-opus-5-5', effort: 'high', version: '2.1.300', hudVersion: '9.9.9' }
    return { value: { value: { ...meta, latest: '', committedAt: 0, startedAt: 0, turns: 1, minute: 0 }, version: 1 } }
  })
  const manifestReads: string[] = []
  on('fs.read', ($, e) => {
    if (e.path.endsWith('plugin.json')) manifestReads.push(e.path)
    throw new Error('ENOENT')
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  type Node = { type?: string; text?: string; props: Record<string, unknown>; children: Node[] | string[] }
  const W = PANE_PROPS.bodyColumns
  const LINE = '#e3b341'
  const colors = (t: { children: unknown[] } | undefined) => t?.children.map(c => (c as { props?: { color?: string } }).props?.color)

  // the announcement band: the line's colour above and below what comes next
  const band = await ui.find({ key: 'band' })
  expect(band?.children[0]).toMatchObject({ type: 'Text', props: { color: LINE }, children: ['━'.repeat(W)] })
  expect(band?.children[2]).toMatchObject({ type: 'Text', props: { color: LINE }, children: ['━'.repeat(W)] })
  // the dispatcher: with nothing to say, all clear
  expect((await ui.find({ key: 'dispatch' }))?.text).toBe('▸ ✓ All clear')

  // the stations, in order down the track, each glyph in the line's colour
  // whole station rows, not the glyph spans inside them
  const stations = (await ui.findAll({ type: 'Text', text: /^ [◉○◇◆◎]━ / })).filter(t => t.text.length > 4)
  expect(stations.map(t => t.text.slice(4).split(/ {2,}/)[0]?.trimEnd())).toEqual([
    'site',
    'CLAUDE',
    'not a git repository',
  ])
  for (const station of stations) expect((station.children[0] as Node).props.color).toBe(LINE)
  // the origin is the working dir's name alone: the ◉ says the line starts there
  expect(stations[0]?.text).toBe(' ◉━ site')
  // under git the line curls across the pane, CONTEXT at its start and the COMPACT terminus at
  // its end; before any reading the marker waits at the corner and the track is all ahead
  const names = await ui.find({ key: 'curl-names' })
  expect(names?.text).toMatch(/^ ┃ CONTEXT +COMPACT$/)
  expect(names?.text.length).toBe(W - 2)
  expect((await ui.find({ key: 'curl-marker' }))?.text).toBe(' ┃▼ no reading')
  const track = await ui.find({ key: 'curl-track' })
  expect(track?.text).toBe(` ╰◆${'┄'.repeat(W - 6)}◎`)
  // the corner and the waiting marker in the line's colour; the track ahead in its zones, green,
  // amber and red, and the terminus red
  expect(colors(track?.children[0] as Node)).toEqual([LINE, LINE, '#3fb950', '#d29922', '#f85149', '#f85149'])
  // Claude's version in the version colour
  // Claude's version, a button that opens what is new in it
  expect((await ui.find({ key: 'claude-version' }))?.props).toMatchObject({ label: '2.1.300', plain: true })

  // between stations, the track
  const segments = (await ui.findAll({ type: 'Box' })).filter(b => b.props.position === 'relative')
  const tracks = segments.map(seg => {
    expect(seg.props).toMatchObject({ overflow: 'hidden', paddingLeft: 4, flexDirection: 'column' })
    const line = seg.children[0] as Node
    expect(line.props).toMatchObject({ position: 'absolute', top: 0, left: 1 })
    const glyphs = line.children[0] as Node
    expect(glyphs.props.color).toBe(LINE)
    return (glyphs.children as string[]).join('')[0]
  })
  expect(tracks).toEqual(['┃', '┃', '┃'])
  // before the first measurement there is no window to put stops on, so nothing under the track
  expect(await ui.find({ key: 'curl-tokens' })).toBeUndefined()
  expect(await ui.find({ key: 'curl-turns' })).toBeUndefined()

  // the origin's folders above it and the model ride the track; the context bar and ARIA sit under the curl
  expect((await ui.find({ type: 'Text', text: 'C:/work/' }))?.props.dimColor).toBe(true)
  // the model and the effort are buttons, the effort's level plain: its rank's colour shows under the pointer
  expect((await ui.find({ key: 'claude-model' }))?.props.label).toBe('claude-opus-5-5')
  const effort = await ui.find({ key: 'claude-effort' })
  expect(effort?.props.label).toBe('high')
  expect(effort?.props.dimColor).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ effort/ })).toBeUndefined()
  expect(await ui.find({ key: 'context-bar' })).toBeDefined()
  expect(await ui.find({ key: 'ring' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ARIA/ })).toBeDefined()

  // the operator's plate closes the line: a framed badge, centred, the name bold and the
  // version bold in its own colour
  const plate = await ui.find({ key: 'plate' })
  expect(plate?.props.alignItems).toBe('center')
  const badge = '│ ◆ session-hud 9.9.9 · transit │'
  expect(plate?.text).toBe(`╭${'─'.repeat(badge.length - 2)}╮${badge}╰${'─'.repeat(badge.length - 2)}╯`)
  expect((await ui.find({ type: 'Text', text: /^session-hud$/ }))?.props.bold).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^ 9.9.9$/ }))?.props).toMatchObject({ bold: true, color: '#d2a8ff' })

  // Remote Control off: a red light, and a button to start it
  expect(await ui.find({ type: 'Text', text: /^● Remote Control/ })).toBeUndefined()
  expect((await ui.find({ key: 'start-remote' }))?.props.label).toBe('Start remote control')
  // drawing the pane never reads the manifest: it was read once, at start
  expect(manifestReads).toEqual([])
  await ui.unmount()
})

test('the line ends where the session compacts: the terminus in tokens, and a track only that long', async ($, on) => {
  on('state.get', ($, e, next) => {
    if (e.key !== 'usage') return next(e)
    const usage = { tokens: 120_000, window: 1_000_000, percent: 12, limits: [], compactAt: 39, compactAtTokens: 387_000 }
    return { value: { value: usage, version: 1 } }
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  const W = PANE_PROPS.bodyColumns
  expect((await ui.find({ key: 'curl-marker' }))?.text).toBe(` ┃${' '.repeat(11)}▼ 120k/1M · 12%`)
  // at 120k of a line to 387k: 100k passed, 200k and 300k ahead, the terminus in tokens
  const track = await ui.find({ key: 'curl-track' })
  expect(track?.text).toBe(` ╰${'━'.repeat(9)}┯━◆${'┄'.repeat(6)}┬${'┄'.repeat(8)}┬${'┄'.repeat(7)}◎`)
  expect(track?.text.length).toBe(W - 2)
  const tokens = await ui.find({ key: 'curl-tokens' })
  expect(tokens?.text).toMatch(/^  0 +100k +200k +300k +387k$/)
  expect(tokens?.text.length).toBe(W - 2)
  // the stops passed are dim, those ahead and the terminus are not
  const dim = async (text: string) => (await ui.find({ type: 'Text', text: new RegExp(`^${text}$`) }))?.props.dimColor
  expect([await dim('100k'), await dim('200k'), await dim('387k')]).toEqual([true, false, false])
  // no history, no forecast: no turns
  expect(await ui.find({ key: 'curl-turns' })).toBeUndefined()
  await ui.unmount()
})

test('past the middle of the track the reading reads leftward, over the way travelled', async ($, on) => {
  on('state.get', ($, e, next) => {
    if (e.key !== 'usage') return next(e)
    const usage = { tokens: 300_000, window: 1_000_000, percent: 30, limits: [], compactAt: 39, compactAtTokens: 387_000 }
    return { value: { value: usage, version: 1 } }
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  // 300k of 387k puts the marker at cell 27 of 36: the reading ends in ▼ over it
  expect((await ui.find({ key: 'curl-marker' }))?.text).toBe(` ┃${' '.repeat(13)}300k/1M · 30% ▼`)
  await ui.unmount()
})

test('the dispatcher says the most urgent thing with its button, and +N steps to the next', async ($, on) => {
  on('state.get', ($, e, next) => {
    if (e.key === 'usage') return { value: { value: { tokens: 700_000, window: 1_000_000, percent: 70, limits: [] }, version: 1 } }
    if (e.key === 'git') {
      const files = Array.from({ length: 20 }, (_, i) => ({ code: 'M', path: `f${i}.ts` }))
      const git = { isRepo: true, branch: 'main', upstream: null, ahead: 0, behind: 0, files, linesAdded: 380, linesRemoved: 40, lastCommit: 'abc x' }
      return { value: { value: git, version: 1 } }
    }
    if (e.key === 'meta') {
      const meta = { cwd: 'C:/w', id: '', name: '', model: 'm', effort: 'high', version: '2.1.1', latest: '2.1.300', committedAt: 0, startedAt: 0, turns: 1, minute: 0 }
      return { value: { value: meta, version: 1 } }
    }
    return next(e)
  })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PANE_PROPS })
  const W = PANE_PROPS.bodyColumns
  const band = async () => (await ui.find({ key: 'dispatch' }))?.text
  // 700k is past compaction: that first, its button flush right, and two more waiting
  expect(await band()).toMatch(/^▸ Compact now · 700k +\[Prep\] \+2$/)
  expect((await band())?.length).toBe(W - 2)
  expect((await ui.find({ key: 'prep-compact' }))?.props.label).toBe('[Prep]')
  // +2 steps to the uncommitted work, which has no button
  await ui.press({ key: 'dispatch-next' })
  expect(await band()).toMatch(/^▸ 420 lines uncommitted · 20 files +\+2$/)
  // then to the newer Claude Code, then round to the start
  await ui.press({ key: 'dispatch-next' })
  expect(await band()).toMatch(/^▸ 2\.1\.300 out +\[Read\] \+2$/)
  expect(await ui.find({ key: 'dispatch-read' })).toBeDefined()
  await ui.press({ key: 'dispatch-next' })
  expect(await band()).toMatch(/^▸ Compact now/)
  await ui.unmount()
})

// ---------------------------------------------------------------- ending processes, end to end

const PROCS_PANE = { ...PANE_PROPS, bodyColumns: 60, scroll: { offset: 0, bodyRows: 60 } } as const

/** A process as the mocked `ps` reports it: started at `start`, with `cpu` seconds used so far. */
type PsProc = { pid: number; ppid: number; name: string; start: number; cpu: number; cmd: string }

/** Seconds as `ps` writes an elapsed or CPU time: `hh:mm:ss`. */
const psTime = (seconds: number): string =>
  [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, Math.floor(seconds) % 60].map(n => String(n).padStart(2, '0')).join(':')

/** `PS_SCAN`'s output at `now`: this session is pid 500, a claude process under a missing parent. */
const psScan = (now: number, procs: readonly PsProc[]): string => {
  const all = [{ pid: 500, ppid: 400, name: 'claude', start: now - 60_000, cpu: 1, cmd: 'claude' }, ...procs]
  const lines = all.map(p => `${p.pid} ${p.ppid} ${psTime((now - p.start) / 1000)} 51200 ${psTime(p.cpu)} ${p.cmd}`)
  return ['@@ME@@ 500', ...lines, '@@COMM@@', ...all.map(p => `${p.pid} ${p.name}`)].join('\n')
}

const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

/**
 * Hooks for a POSIX machine with no usable home (so no shared scan) whose `ps` lists `procs`, and
 * where every `kill` is recorded rather than run. Returns the clock and the kills.
 */
const posixWorld = (on: Parameters<typeof mock.clock>[0], now: number, procs: () => readonly PsProc[]) => {
  const clock = mock.clock(on, { now })
  const kills: string[] = []
  mock.env(on, {})
  on('process.run', ($, e) => {
    if (e.argv[0] === 'sh') return ran(psScan(clock.now(), procs()))
    if (e.argv[0] === 'kill') {
      kills.push(e.argv.join(' '))
      return ran('')
    }
    return ran('', 128)
  })
  return { clock, kills }
}

test('End all stale spares a process that woke since the confirm, and pid 1 always', async ($, on) => {
  const now = 1_800_000_000_000
  // An orphaned dev server, idle, and a node process at pid 1 (a container's init): both stale.
  const server: PsProc = { pid: 4242, ppid: 9999, name: 'node', start: now - 60 * 60_000, cpu: 1, cmd: 'node dev.js' }
  const init: PsProc = { pid: 1, ppid: 0, name: 'node', start: now - 60 * 60_000, cpu: 1, cmd: 'node init.js' }
  const { clock, kills } = posixWorld(on, now, () => [server, init])
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PROCS_PANE })
  await ui.press({ key: 'tab-procs' })
  // nothing stale yet: the Procs tab has no red count beside it
  expect(await ui.find({ type: 'Text', text: / ●\d+$/ })).toBeUndefined()
  // Half an hour on with no CPU used, a rescan finds both stale.
  await clock.advance(31 * 60_000)
  await ui.press({ key: 'rescan' })
  expect(await ui.find({ type: 'Text', text: /^2 stale/ })).toBeDefined()
  // and the Procs tab says so in red, whatever tab is on screen
  expect((await ui.find({ type: 'Text', text: ' ●2' }))?.props.color).toBe('#f85149')
  await ui.press({ key: 'end-all' })
  // Between the confirm and the press, the server gets busy: the fresh scan sees it active.
  server.cpu = 9
  await ui.press({ key: 'yes-all' })
  expect(kills).toEqual([])
  // Idle again for half an hour, it is stale again and does end; pid 1 never does.
  await clock.advance(31 * 60_000)
  await ui.press({ key: 'rescan' })
  await ui.press({ key: 'end-all' })
  await ui.press({ key: 'yes-all' })
  expect(kills).toEqual(['kill -TERM 4242'])
  await ui.unmount()
})

test('a malformed shared scan is no scan: the session scans for itself and shows no error', async ($, on) => {
  const now = 1_800_000_000_000
  const clock = mock.clock(on, { now })
  mock.env(on, { HOME: '/home/dev' })
  let procs: PsProc[] = [{ pid: 4242, ppid: 9999, name: 'node', start: now - 60_000, cpu: 1, cmd: 'node dev.js' }]
  on('process.run', ($, e) => (e.argv[0] === 'sh' ? ran(psScan(clock.now(), procs)) : ran('', 128)))
  let shared = ''
  on('fs.read', ($, e) => {
    if (e.path.replaceAll('\\', '/').endsWith('/procs-scan.json')) return { value: shared }
    throw new Error('ENOENT')
  })
  on('fs.write', () => ({ value: undefined }))
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'session-hud', props: PROCS_PANE })
  // The first scan is always the session's own: it learns which processes are its.
  await ui.press({ key: 'tab-procs' })
  const row = { pid: 7, name: 'node', start: 1, mem: 1, cpu: 1, cmd: 'node x.js' }
  const node = { pid: 7, ppid: 1, start: 1, name: 'node' }
  const malformed = [
    { rows: [null], tree: [] },
    { rows: [{ ...row, cmd: 42 }], tree: [] },
    { rows: [{ ...row, pid: '7' }], tree: [] },
    { rows: [row], tree: [null] },
    { rows: [row], tree: [{ ...node, name: 7 }] },
    { rows: 'nope', tree: [] },
  ]
  for (const [i, bad] of malformed.entries()) {
    // Another session's file, fresh, and broken; the real machine meanwhile runs a new process.
    await clock.advance(1_000)
    shared = JSON.stringify({ at: clock.now(), ...bad })
    const pid = 5000 + i
    procs = [...procs, { pid, ppid: 9999, name: 'node', start: clock.now() - 60_000, cpu: 1, cmd: 'node new.js' }]
    await ui.press({ key: 'tab-hub' })
    await ui.press({ key: 'tab-procs' })
    expect(await ui.find({ type: 'Text', text: /process scan failed/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: ` ${pid} ` })).toBeDefined()
  }
  await ui.unmount()
})

test('no git runs once the session is ending, and a new start brings refreshes back', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  const gitRuns: string[] = []
  on('process.run', ($, e) => {
    if (e.argv[0] === 'git') gitRuns.push(e.argv.join(' '))
    return ran('', 128)
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const reply = { reason: 'answer', answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't1' } as const
  // A reply's end re-reads git, so the check below is not vacuous.
  await $.turn.complete(reply)
  expect(gitRuns.length).toBeGreaterThan(0)
  gitRuns.length = 0
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await $.turn.complete(reply)
  expect(gitRuns).toEqual([])
  // A /clear ends the conversation, not the process: git goes on being read.
  await $.session.start({ cwd: 'C:/work/site', surface: null, isInteractive: false })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  gitRuns.length = 0
  await $.turn.complete(reply)
  expect(gitRuns.length).toBeGreaterThan(0)
})
