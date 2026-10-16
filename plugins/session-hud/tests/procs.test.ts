import { expect, test } from 'claude-code/testing'

import type { HudProc } from '../types'
import { IDLE_AFTER_MS, ancestorsOf, buildProcs, canEnd, fromCache, isIdle, parsePsScan, procKind, procState, tidyCommand, toCache } from '../hooks/procs'
import type { RawProc, Scan, TreeNode } from '../hooks/procs'

// The 0.8.1 security review of the Procs tab: each test pins a shape a fuzzer or an adversarial
// process tree found, with the right answer. Secrets here are fakes, several assembled at run time
// so that secret scanners do not read the test as a leak.

const none = new Set<number>()

const tree = (...nodes: Array<[number, number, string, number?]>): Map<number, TreeNode> =>
  new Map(nodes.map(([pid, ppid, name, start = 1]) => [pid, { pid, ppid, start, name }]))

const row = (pid: number, name: string, cmd: string, start = 1): RawProc => ({ pid, name, start, mem: 10, cpu: 1, cmd })

const scanOf = (rows: RawProc[], nodes: Map<number, TreeNode>, chain: number[] = []): Scan => ({ rows, tree: nodes, chain })

const proc = (over: Partial<HudProc>): HudProc => ({
  pid: 4242,
  name: 'node',
  startedAt: 0,
  memMb: 10,
  cpuSec: 1,
  activeAt: 0,
  state: 'unowned',
  kind: '',
  command: '',
  ...over,
})

/** The input and its tidied form when `secret` still shows in it, so a failure names the shape. */
const shown = (raw: string, secret: string): string | undefined => (tidyCommand(raw).includes(secret) ? `${raw} -> ${tidyCommand(raw)}` : undefined)

/** Every case whose secret still shows once tidied: `[]` when all are hidden. */
const leaks = (cases: ReadonlyArray<readonly [string, string]>): string[] => cases.map(([raw, secret]) => shown(raw, secret)).filter(s => s !== undefined)

// ---------------------------------------------------------------- quotes (R1)

test('a quoted option name still hides its value, and the quote that closes an argument stays out of the value', () => {
  expect(tidyCommand('node app.js "--token" "SECRETVAL1"')).toBe('node app.js --token ***')
  expect(tidyCommand("node app.js '--password' 'hunter2'")).toBe('node app.js --password ***')
  expect(tidyCommand('node app.js "--api-key=abc123"')).toBe('node app.js --api-key=***')
  expect(tidyCommand('node app.js --token="abc123" --verbose')).toBe('node app.js --token=*** --verbose')
})

// ---------------------------------------------------------------- JSON (R2)

test('a credential inside JSON on the command line is hidden, escaped quotes and nesting too', () => {
  const v = 'Q7vX2mR9pL4sT8wZ'
  expect(
    leaks([
      [`node app.js {"apiKey":"${v}"}`, v],
      [`node app.js '{"api_key": "${v}"}'`, v],
      [`node app.js --config '{"token":"${v}","x":1}'`, v],
      [`node app.js '{"password":"${v}"}'`, v],
      [`node app.js '{"clientSecret":"${v}"}'`, v],
      [`node app.js '{"accessToken":"${v}"}'`, v],
      [`node app.js '{"type":"service_account","private_key":"${v}"}'`, v],
      [`node app.js '{"auth":{"secret":"${v}"}}'`, v],
      [`node app.js --settings "{\\"apiKey\\":\\"${v}\\"}"`, v],
    ]),
  ).toEqual([])
  // the JSON keeps its shape: only the value goes
  expect(tidyCommand(`node app.js {"apiKey":"${v}"}`)).toBe('node app.js {"apiKey":***}')
  expect(tidyCommand(`node app.js '{"auth":{"secret":"${v}"}}'`)).toBe(`node app.js '{"auth":{"secret":***}}'`)
  expect(tidyCommand(`node app.js --config '{"token":"${v}","x":1}'`)).toBe(`node app.js --config '{"token":***,"x":1}'`)
  expect(tidyCommand(`node app.js --settings "{\\"apiKey\\":\\"${v}\\"}"`)).toBe('node app.js --settings "{\\"apiKey\\":***}"')
})

/** Fragments of command lines, from the review's fuzz and the other suites, to combine. */
const FRAGMENTS = [
  'node', 'app.js', '--token', '"--token"', "'--password'", '"SECRETVAL1"', "'two words'", '"two words"', '--api-key=abc', '"--api-key=abc"',
  '{"apiKey":"V1234567"}', '\'{"auth":{"secret":"V1234567"}}\'', '"{\\"apiKey\\":\\"V1234567\\"}"', '{"token":***,"x":1}', 'token:', '***', '***}',
  'https://user:pw@db.local:5432/x?y=1', 'redis://:PW@localhost:6379', 'https://u:ab/cd@github.com/x', 'https://registry.npmjs.org/@types/node',
  'file:///etc/passwd', 'PATH=/usr/bin', 'dist/cli/index.js', 'node_modules/.bin/vite', './certs/server.key', 'C:\\Program Files\\nodejs\\node.exe',
  '"C:\\Program Files\\nodejs\\node.exe"', '"C:\\x\\npx-cli.js"', '@playwright/mcp', '-u', 'bob:hunter2', '--user', 'u:v', '-uuser:pw', 'mysql', '-proot1',
  'Authorization:', 'Bearer', 'abcdefgh1234', 'Basic', 'usage', 'Cookie:', 'a=V1;', 'b=W2', 'AccountKey=Va;b', ';EndpointSuffix=core', '-AccessToken',
  '-ClientSecret', 'API_KEY=s3cret', 'AKEYAKEY', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEow', '-----END RSA PRIVATE KEY-----', '"', "'", '=', ':', '/', '\\',
  '"x"', "'y'", '"\'"', '"a"b"', '""', "''", '"it\'s"', '(token=abc)', '[token=abc]', '--hook="https://hooks.slack.com/services/T0/B0/XXXX"', '…',
  'sk-proj-abcdefghijklmnopqrstuvwx', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF123', 'ConvertTo-SecureString', '\'pw\'', 'vault', 'login',
  'x\u202Ey', 'a\u200Bb', 'tab\tsep', 'nl\nsep', '\u001b[31m', '%2F', '$env:GITHUB_TOKEN=\'abc\'', 'key=a,mode=x', '--token2', '"token: abc"',
]
const SEPARATORS = [' ', ' ', ' ', '', '=', ':', ' && ', '\t', '"', "'", ',', ';', '/']

/** Every fragment alone and in pairs, then deterministic random runs of up to eight. */
function corpus(): string[] {
  const out = [...FRAGMENTS]
  for (const a of FRAGMENTS) for (const b of FRAGMENTS) out.push(`${a} ${b}`)
  let seed = 9
  const next = (n: number): number => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
    return seed % n
  }
  for (let i = 0; i < 6000; i++) {
    let line = FRAGMENTS[next(FRAGMENTS.length)]!
    for (let j = next(8); j > 0; j--) line += SEPARATORS[next(SEPARATORS.length)]! + FRAGMENTS[next(FRAGMENTS.length)]!
    out.push(line)
  }
  return out
}

test('tidying is a fixed point: a tidied command tidies to itself, so the shared file and the tab agree', () => {
  const unstable = corpus().filter(raw => tidyCommand(tidyCommand(raw)) !== tidyCommand(raw))
  expect(unstable.slice(0, 5)).toEqual([])
  // the shared file holds a tidied command, and the tab tidies what it reads: the same text
  const scan = scanOf([row(7, 'node', 'node app.js "--token" "SECRETVAL1" {"apiKey":"V1"}')], tree([7, 1, 'node']))
  const viaCache = buildProcs(fromCache(toCache(scan, 1)), [], 1, 1, [])
  expect(viaCache[0]!.command).toBe(buildProcs(scan, [], 1, 1, [])[0]!.command)
})

// ---------------------------------------------------------------- URLs (R3)

test("a URL's whole userinfo is hidden: an empty user, a slash or an @ in the password", () => {
  expect(tidyCommand('node app.js redis://:PWsecret1@localhost:6379')).toBe('node app.js redis://***@localhost:6379')
  expect(tidyCommand('git clone https://user:ab/cd123@github.com/x/y.git')).toBe('git clone https://***@github.com/…')
  expect(tidyCommand('node app.js mongodb+srv://u:p@ss@word@cluster0.x.net/db')).toBe('node app.js mongodb+srv://***@cluster0.x.net/…')
  expect(tidyCommand('git clone https://x-access-token:tok/en@github.com/x')).toBe('git clone https://***@github.com/…')
  expect(tidyCommand('git clone https://user:ab!#c?d@github.com/x')).toBe('git clone https://***@github.com/…')
  // a scoped package in a path, or an address in a query, is not a userinfo: the host stays
  expect(tidyCommand('npm i https://registry.npmjs.org/@types/node')).toBe('npm i https://registry.npmjs.org/…')
  expect(tidyCommand('node a.js https://x.com/a?to=bob@x.com')).toBe('node a.js https://x.com/…')
  // ...and a secret with an @ in a path or a query never leaves its tail behind as a host
  expect(
    leaks([
      ['node app.js https://api.x.com/v1?token=ab@cdSECRET', 'cdSECRET'],
      ['node app.js https://hooks.slack.com/services/T0/B0/ab@cdSECRET', 'cdSECRET'],
      ['node app.js "Endpoint=sb://x.net/;SharedAccessKeyName=root;SharedAccessKey=ab@cdSECRET"', 'cdSECRET'],
    ]),
  ).toEqual([])
})

// ---------------------------------------------------------------- keys (R4, and the issuer list)

test("OpenAI's project, service-account and admin keys are hidden, and Anthropic's still are", () => {
  const tail = 'Ab3dEf6hIj9kLm2nOp5q-rS8tUv'
  expect(
    leaks([
      [`node app.js ${'sk-'}proj-${tail}`, tail],
      [`node app.js ${'sk-'}svcacct-${tail}`, tail],
      [`node app.js ${'sk-'}admin-${tail}`, tail],
      [`node app.js ${'sk-'}ant-api03-${tail}`, tail],
    ]),
  ).toEqual([])
})

test('each issuer key is hidden on its own, without a name before it', () => {
  // Each line holds one key and nothing else that would hide it: dropping its issuer fails the test.
  expect(tidyCommand(`node a.js ${'AKIA'}ABCDEFGHIJKLMNOP`)).toBe('node a.js ***')
  expect(tidyCommand(`node a.js ${'ASIA'}ABCDEFGHIJKLMNOP`)).toBe('node a.js ***')
  expect(tidyCommand(`node a.js ${'xoxb'}-1234-5678-abcdefghij`)).toBe('node a.js ***')
  expect(tidyCommand(`node a.js ${'xapp'}-1-A0B1-1234-abcdefghij`)).toBe('node a.js ***')
  expect(tidyCommand(`node a.js ${'github_pat_'}11ABCDEFGHIJKLMNOPQRST_abc`)).toBe('node a.js ***')
  expect(tidyCommand(`node a.js ${'ghp_'}abcdefghijklmnopqrstu`)).toBe('node a.js ***')
})

// ---------------------------------------------------------------- names (R5)

test('credential names the review found missing are hidden', () => {
  const v = 'Zq8Wm3Xr7Kp2'
  expect(
    leaks([
      [`node app.js --pw ${v}`, v],
      [`node app.js --passphrase ${v}`, v],
      [`node app.js --jwt ${v}`, v],
      [`node app.js --creds ${v}`, v],
      [`node app.js --otp ${v}`, v],
      [`node app.js --signature ${v}`, v],
      [`node app.js --token2 ${v}`, v],
      [`pwsh -File x.ps1 -AccessToken ${v}`, v],
      [`pwsh -File x.ps1 -ClientSecret ${v}`, v],
      [`pwsh -File x.ps1 -ApiKey ${v}`, v],
      [`curl --user user:${v} https://x`, v],
      [`curl --user=user:${v} https://x`, v],
      [`mysql -u root -p${v} db`, v],
      [`curl -H "Cookie: session=${v}" https://x`, v],
      [`curl -H "Cookie: a=1; b=${v}" https://x`, v],
      [`node app.js --cookie "session=${v}"`, v],
      [`node app.js AccountKey=ab;${v}`, v],
      [`node app.js --accessToken=ab;${v}`, v],
      [`curl -H "Authorization: Bearer ab!#${v}" https://x`, v],
      [`curl -H "Authorization: Basic ab!#${v}" https://x`, v],
      [`pwsh -c "ConvertTo-SecureString '${v}' -AsPlainText -Force"`, v],
      [`sshpass -p ${v} ssh host`, v],
      [`redis-cli -a ${v}`, v],
      [`vault login ${v}`, v],
      [`node app.js -----BEGIN PGP PRIVATE KEY BLOCK-----${v}-----END PGP PRIVATE KEY BLOCK-----`, v],
    ]),
  ).toEqual([])
  // a connection string keeps the setting after the secret
  expect(tidyCommand('node a.js AccountKey=c2VjcmV0a2V5PT0=;EndpointSuffix=core')).toBe('node a.js AccountKey=***;EndpointSuffix=core')
})

test('words that only contain a credential name, and short prose after Basic or Bearer, are kept', () => {
  for (const kept of [
    'node monkey.js --keyboard --author me',
    'node a.js --bypass-cache --passes 3 --hotkey=ctrl',
    'node a.js --pass-through --password-min-length 12 --no-password',
    'node a.js --token-file secrets.txt',
    'node a.js --sig-figs 3 --signal SIGTERM --pat-file x',
    'node a.js tokenizer: bpe',
    'curl -H "Authorization: Basic usage"',
    'node a.js Bearer tokens',
    'node a.js KEYBOARD=us',
  ]) {
    expect(tidyCommand(kept)).toBe(kept.replaceAll('"', ''))
  }
})

// ---------------------------------------------------------------- linear time (R6, and every new pattern)

/** Repeated, each of these makes a 200,000-character argument aimed at one pattern's repeats. */
const HOSTILE_UNITS = [
  'AKEY', 'A_KEY', 'A_KEY_', 'aKey', 'a1Key', 'aKey=', 'Key=', 'token=', 'token ', 'x_token ', '--a_', 'a_', 'a-', '-a', '-u ', '-ua:', '--user ',
  '"', "'", '"a', '"\'"', '\\"', '{"', '{\\"', 'a:', 'a@', 'a:b@', '://', 'a://', 'a://b:c/', 'x://a', 'https://', '/', '\\', 'a/', '/a', 'C:\\a',
  '=', '=/a', ':/a', ',/a', 'a=', ':', '@', ';', ';a', 'a;', 'Key=a;', 'Bearer ', 'Basic ', 'eyJaaaaaaaa.', 'sk-', 'sk-proj-', '-----BEGIN ',
  '-----BEGIN PRIVATE KEY-----', 'cookie:', 'cookie:a;', 'mysql ', 'mysql -x ', '-p', 'sshpass ', 'vault login ', 'htpasswd -b ', 'ConvertTo-SecureString ',
  ' ', '\t', '\u202E', '\u0007', 'A', '9', '*', '***', '-AccessToken ', '--aToken ', '…',
  'a/b ', '"x" ', "'x' ", '"--token" ', 'a://b@', '/@',
]

// Each takes tens of milliseconds; quadratic time costs seconds. Four tests of a quarter each keep
// every one well inside a runner's own time limit, even with coverage counting every branch.
for (let part = 0; part < 4; part++) {
  test(`hostile command lines of 200,000 characters are tidied in linear time (part ${part + 1} of 4)`, () => {
    const slow: string[] = []
    for (const unit of HOSTILE_UNITS.filter((_, i) => i % 4 === part)) {
      const text = unit.repeat(Math.ceil(200_000 / unit.length)).slice(0, 200_000)
      for (const raw of [`node ${text}`, `node ${text}x=`, `node --token ${text}`]) {
        const started = performance.now()
        tidyCommand(raw)
        const took = performance.now() - started
        if (took > 1000) slow.push(`${JSON.stringify(unit)}: ${took.toFixed(0)} ms`)
      }
    }
    expect(slow).toEqual([])
  })
}

// ---------------------------------------------------------------- paths (R7)

test('a path, relative or not, shortens to its last part as a whole word', () => {
  expect(tidyCommand('node dist/cli/index.js')).toBe('node index.js')
  expect(tidyCommand('node node_modules/.bin/vite --port 5173')).toBe('node vite --port 5173')
  expect(tidyCommand('node app.js --key-file ./certs/server.key')).toBe('node app.js --key-file server.key')
  expect(tidyCommand('PATH=/usr/bin node app.js')).toBe('PATH=bin node app.js')
  expect(tidyCommand('node app.js file:///etc/passwd')).toBe('node app.js file:///…')
  expect(tidyCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\x\\npx-cli.js" -y @playwright/mcp')).toBe('node.exe npx-cli.js -y @playwright/mcp')
  // a quoted path keeps nothing of its folders, whatever they hold
  expect(tidyCommand('node "C:\\keys\\ab:cd;e=f\\x.js"')).toBe('node x.js')
  // one slash is a package or a folder name, not a path to shorten
  expect(tidyCommand('npx @playwright/mcp src/x')).toBe('npx @playwright/mcp src/x')
})

// ---------------------------------------------------------------- control characters (R8)

test('control and format characters cannot reorder or hide the command shown', () => {
  const rlo = String.fromCodePoint(0x202e)
  const zwsp = String.fromCodePoint(0x200b)
  expect(tidyCommand(`node evil.js ${rlo}txt.exe`)).toBe('node evil.js txt.exe')
  expect(tidyCommand(`node \u001b[2J\u001b]0;pwned\u0007x.js\r\u0008`)).toBe('node [2J ]0;pwned x.js')
  // a zero-width space cannot split a credential's name from the redaction
  expect(tidyCommand(`node a.js --to${zwsp}ken hunter2`)).toBe('node a.js --token ***')
  // nothing outside ordinary text survives
  for (const raw of corpus().slice(0, 2000)) expect(/[\p{Cc}\p{Cf}]/u.test(tidyCommand(raw))).toBe(false)
})

// ---------------------------------------------------------------- the Slack webhook, and Bearer's minimum

test("a Slack webhook's token never shows, quoted or not", () => {
  for (const raw of [
    'node notify.js --hook="https://hooks.slack.com/services/T0/B0/XXXXSECRET"',
    'node notify.js "https://hooks.slack.com/services/T0/B0/XXXXSECRET"',
    "node notify.js x:'https://hooks.slack.com/services/T0/B0/XXXXSECRET'",
  ]) {
    expect(tidyCommand(raw)).not.toContain('XXXXSECRET')
  }
  expect(tidyCommand('node notify.js --hook="https://hooks.slack.com/services/T0/B0/XXXXSECRET"')).toBe('node notify.js --hook=https://hooks.slack.com/…')
})

test('Bearer and Basic need eight characters, so prose stays and a token goes', () => {
  expect(tidyCommand('curl -H "Authorization: Basic usage"')).toBe('curl -H Authorization: Basic usage')
  expect(tidyCommand('curl -H "Authorization: Basic dXNlcjpw"')).toBe('curl -H Authorization: Basic ***')
  expect(tidyCommand('curl -H "Authorization: Bearer 1234567"')).toBe('curl -H Authorization: Bearer 1234567')
})

test('a process is idle after thirty minutes without CPU, not a minute sooner', () => {
  expect(IDLE_AFTER_MS).toBe(30 * 60_000)
  expect(isIdle(proc({ activeAt: 0 }), 30 * 60_000)).toBe(true)
  expect(isIdle(proc({ activeAt: 0 }), 30 * 60_000 - 1)).toBe(false)
})

// ---------------------------------------------------------------- ownership (O1 to O5)

const MAC_DESKTOP = [
  '@@ME@@ 900',
  '  1     0 10-00:00:00  1000 00:00:01 /sbin/launchd',
  '100     1    01:00:00 300000 00:01:00 /Applications/Claude.app/Contents/MacOS/Claude',
  '101   100    01:00:00 100000 00:00:10 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer',
  '800     1    01:00:00 100000 00:00:10 /Applications/iTerm.app/Contents/MacOS/iTerm2',
  '900   800    00:30:00 100000 00:00:10 claude',
  '@@COMM@@',
  '1 /sbin/launchd',
  '100 /Applications/Claude.app/Contents/MacOS/Claude',
  '101 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)',
  '800 /Applications/iTerm.app/Contents/MacOS/iTerm2',
  '900 claude',
].join('\n')

test('on macOS the desktop app is a host of sessions, never offered to end', () => {
  const procs = buildProcs(parsePsScan(MAC_DESKTOP, 10_000_000), [], 10_000_000, 10_000_000)
  const desktop = procs.find(p => p.pid === 100)!
  expect(desktop).toMatchObject({ state: 'owned', kind: 'desktop app' })
  expect(canEnd(desktop)).toBe(false)
  // without its helper in the scan, the app is still known by its own path
  const alone = MAC_DESKTOP.split('\n').filter(line => !line.startsWith('101'))
  const app = buildProcs(parsePsScan(alone.join('\n'), 10_000_000), [], 10_000_000, 10_000_000).find(p => p.pid === 100)!
  expect(app.kind).toBe('desktop app')
  expect(canEnd(app)).toBe(false)
})

test("under launchd or systemd, an app is the system's and a plain shell or node is an orphan", () => {
  // a LaunchAgent or GUI app started by launchd is owned, and so is what it runs
  expect(procState(51, tree([1, 0, 'launchd'], [50, 1, 'someagent'], [51, 50, 'node']), none, none)).toBe('owned')
  expect(procState(50, tree([1, 0, 'systemd'], [50, 1, 'gnome-shell']), none, none)).toBe('owned')
  // a node or claude whose parent died, and a plain shell, were re-parented there: orphans
  expect(procState(50, tree([1, 0, 'launchd'], [50, 1, 'node']), none, none)).toBe('unowned')
  expect(procState(50, tree([1, 0, 'launchd'], [50, 1, 'claude']), none, none)).toBe('unowned')
  expect(procState(41, tree([1, 0, 'launchd'], [40, 1, 'sh'], [41, 40, 'node']), none, none)).toBe('unowned')
  expect(procState(41, tree([1, 0, 'init'], [40, 1, 'dash'], [41, 40, 'node']), none, none)).toBe('unowned')
  // pid 1 that is not a system root (a container's own program) owns nothing
  expect(procState(50, tree([1, 0, 'tini'], [50, 1, 'someagent'], [51, 50, 'node']), none, none)).toBe('unowned')
})

test('a claude daemon or background host started through node is a host, never offered to end', () => {
  const cli = String.raw`node C:\npm\node_modules\@anthropic-ai\claude-code\cli.js`
  expect(procKind('node', `${cli} daemon run`, false)).toBe('daemon')
  expect(procKind('node', `${cli} --bg-pty-host`, false)).toBe('background host')
  expect(procKind('node', `${cli} --session-id abc`, false)).toBe('background session')
  expect(procKind('node', 'node /usr/local/lib/node_modules/claude-code/cli.js daemon run', false)).toBe('daemon')
  expect(procKind('node', 'node /usr/local/bin/claude --bg-pty-host', false)).toBe('background host')
  // a node program's own options are not claude's
  expect(procKind('node', 'node worker.js daemon run', false)).toBe('')
  expect(procKind('node', `${cli}`, false)).toBe('')
  const procs = buildProcs(
    scanOf([row(300, 'node.exe', `${cli} daemon run`), row(301, 'node.exe', `${cli} --bg-pty-host`)], tree([4, 0, 'explorer.exe'], [300, 4, 'node.exe'], [301, 4, 'node.exe'])),
    [],
    5,
    5,
    [],
  )
  expect(procs.map(p => [p.pid, p.kind, canEnd(p)])).toEqual([
    [300, 'daemon', false],
    [301, 'background host', false],
  ])
})

test('pid 1 and pid 0 are never offered to end, even when nothing owns them', () => {
  expect(canEnd(proc({ pid: 1, state: 'unowned' }))).toBe(false)
  expect(canEnd(proc({ pid: 0, state: 'owned' }))).toBe(false)
  expect(canEnd(proc({ pid: 2, state: 'unowned' }))).toBe(true)
  // a container whose pid 1 is node
  const ps = ['@@ME@@ 50', '  1     0 2-00:00:00  50000 00:00:01 node server.js', ' 50     0    01:00:00 100000 00:00:10 claude', '@@COMM@@', '1 node', '50 claude'].join('\n')
  const container = buildProcs(parsePsScan(ps, 1e9), [], 1e9, 1e9).find(p => p.pid === 1)!
  expect(canEnd(container)).toBe(false)
})

test('a session inside ConEmu, Visual Studio, a JetBrains IDE, Zed or a Linux terminal is a tab', () => {
  for (const host of [
    'conemu64.exe', 'conemuc64.exe', 'conemu.exe', 'devenv.exe', 'goland64.exe', 'clion64.exe', 'phpstorm64.exe', 'studio64.exe', 'zed.exe', 'zed',
    'hyper', 'tabby', 'code helper (plugin)', 'terminator', 'kgx', 'ptyxis', 'zellij', 'mate-terminal', 'lxterminal',
  ]) {
    expect([host, procState(700, tree([600, 1, host], [650, 600, 'zsh'], [700, 650, 'claude']), none, none)]).toEqual([host, 'protected'])
  }
})

test("a parent that ps shows a second younger than its child is still its parent: ps counts whole seconds", () => {
  // the npx wrapper (150) started this session (200); etime rounding put it a second later
  const t = tree([1, 0, 'systemd', 1], [80, 1, 'someide', 10], [150, 80, 'node', 2_000], [200, 150, 'claude', 1_000])
  expect([...ancestorsOf([200], t)].sort((a, b) => a - b)).toEqual([1, 80, 150])
  expect(procState(150, t, new Set([200]), none)).toBe('owned')
  const procs = buildProcs(scanOf([row(150, 'node', 'node npx-cli.js', 2_000), row(200, 'claude', 'claude', 1_000)], t), [], 5_000, 5_000, [200])
  expect(canEnd(procs.find(p => p.pid === 150)!)).toBe(false)
  // more than two seconds younger is a reused pid, in both walks
  const reused = tree([1, 0, 'systemd', 1], [150, 1, 'someapp', 3_001], [200, 150, 'node', 1_000])
  expect(ancestorsOf([200], reused).size).toBe(0)
  expect(procState(200, reused, none, none)).toBe('unowned')
})
