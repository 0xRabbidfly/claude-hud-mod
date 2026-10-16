/**
 * The Procs tab: every claude and node process on the machine, who owns each one, and which of
 * them the person may end. Everything here is pure; register.tsx runs the scripts, reads and
 * writes the shared scan file, and draws the tab.
 *
 * The flow. `scanProcs` in register.tsx runs one scan per refresh: `WINDOWS_SCAN` through
 * PowerShell's -EncodedCommand (`encodePowerShell`) on Windows, `PS_SCAN` through `sh -c`
 * elsewhere. `parseWindowsScan` or `parsePsScan` turns its output into a `Scan`: the claude and
 * node rows in full, every process on the machine as a tree node, and the scanner's own chain of
 * ancestors. `selfOf` picks this session's pids out of that chain. `buildProcs` folds the
 * desktop app's helpers away, finds the hosts of other sessions, gives each process an ownership
 * state (`procState`, then `ancestorsOf`) and a kind (`procKind`), carries CPU history over from
 * the previous scan, and tidies each command line (`tidyCommand`). The scan is also written to
 * `~/.claude/session-hud/procs-scan.json` through `toCache`, so the person's other sessions can
 * reuse it while it is fresh (`readCachedScan` and `fromCache`); a cached scan has no chain, so
 * each session keeps the self pids from the last scan it ran itself.
 *
 * The ownership states, and what each lets the person do:
 * - `mine`: this session, and everything it started. Shown, never offered to end.
 * - `protected`: inside a terminal or editor tab, a console window, or anything that holds this
 *   session or such a tab in its tree. Shown, never offered to end.
 * - `owned`: reaches the Claude daemon, the desktop app or a long-lived system root. End, after
 *   the person confirms it.
 * - `unowned`: its chain of parents breaks (an orphan). End, after confirming; once idle for
 *   `IDLE_AFTER_MS` it is stale and "End all stale" covers it too.
 *
 * Under pid 1 the two meet. On macOS and Linux every desktop app and LaunchAgent is a child of
 * launchd or systemd, and so is every process whose parent exited, re-parented there. A child of
 * pid 1 that is a shell, node or claude is taken for an orphan (`isOrphanProne`): a dev server
 * whose terminal closed is the stale process this tab exists for. Any other child of a pid 1 that
 * is a system root was started by the system and is `owned`, and so is everything below it.
 *
 * The safety guarantees. `canEnd` offers only `owned` and `unowned` processes, never pid 0 or 1,
 * and never a host of other sessions (the desktop app, the daemon, a background host, whether
 * claude runs as its own binary or through node). On Windows ending uses
 * `taskkill /T`, which ends a whole tree, so every ancestor of this session or of a protected
 * process is itself protected; elsewhere `kill -TERM` ends the one process, where the same rule
 * is stricter than needed but never wrong. A pid can be reused once its process exits, so a
 * parent that started more than `START_SLACK_MS` after its child is never treated as its parent,
 * `endProcesses` ends nothing without a fresh scan that still shows
 * the same pid with the same start time, and on Windows `endScript` checks the start time again
 * in the same call that ends it.
 *
 * Command lines are tidied (`tidyCommand`) before they reach the shared file: credentials hidden,
 * control and format characters dropped, paths and URLs shortened. Tidying a tidied command
 * changes nothing, so the shared file and every session's tab show the same text, and every
 * pattern that does it is bounded so tidying stays linear in its input.
 */
import type { HudProc, HudProcState } from '../types'
import { base64, baseName, utf16Units } from './lib'

/** The Raster's "terminal default" colour: the high byte set marks it as not an 0xRRGGBB value. */
const DEFAULT_COLOR = 0x01000000

/** Terminal and editor hosts, and remote logins: every tab under one is a live session the person has open. Never ended. */
const TERMINALS = new Set([
  // Windows: terminals (ConEmu's window and its console server), then editors and IDEs, Visual Studio among them
  'herdr.exe', 'windowsterminal.exe', 'openconsole.exe', 'mintty.exe', 'wezterm-gui.exe', 'alacritty.exe', 'tabby.exe',
  'hyper.exe', 'conemu.exe', 'conemu64.exe', 'conemuc.exe', 'conemuc64.exe',
  'code.exe', 'code - insiders.exe', 'cursor.exe', 'windsurf.exe', 'antigravity.exe', 'zed.exe', 'devenv.exe', 'idea64.exe',
  'pycharm64.exe', 'webstorm64.exe', 'rider64.exe', 'goland64.exe', 'clion64.exe', 'phpstorm64.exe', 'rubymine64.exe',
  'datagrip64.exe', 'studio64.exe', 'sshd.exe',
  // macOS and Linux (`comm`, the executable's own name): terminals, multiplexers, then editors and IDEs.
  // VS Code's terminals run under its `Code Helper (Plugin)` process on macOS.
  'herdr', 'terminal', 'iterm2', 'wezterm-gui', 'alacritty', 'kitty', 'ghostty', 'warp', 'stable', 'hyper', 'tabby', 'rio',
  'gnome-terminal-server', 'kgx', 'ptyxis', 'konsole', 'xfce4-terminal', 'mate-terminal', 'lxterminal', 'qterminal',
  'terminator', 'terminology', 'tilix', 'xterm', 'urxvt', 'st', 'foot', 'tmux', 'tmux: server', 'screen', 'zellij',
  'code', 'code helper', 'code helper (plugin)', 'cursor', 'cursor helper (plugin)', 'windsurf', 'zed', 'idea', 'pycharm',
  'webstorm', 'rider', 'goland', 'clion', 'phpstorm', 'rubymine', 'studio', 'sshd',
])

/**
 * Shells: one whose parent is a long-lived root is a window of its own (a console, or a macOS
 * Terminal login). The names are lower case, as both parsers store them; a leading `-`, as in
 * `-zsh` and `-bash`, is how `ps` names a login shell.
 */
const SHELLS = new Set([
  'powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe', 'pwsh', 'bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh',
  '-zsh', '-bash', '-fish', '-sh', '-ksh', '-tcsh', 'login',
])

/**
 * Long-lived roots: a tree that reaches one of these is owned by something alive. They are the
 * desktop shell and service hosts on Windows, and pid 1 (`launchd`, `systemd`, `init`) elsewhere.
 */
const ROOTS = new Set(['explorer.exe', 'services.exe', 'svchost.exe', 'wininit.exe', 'winlogon.exe', 'launchd', 'systemd', 'init'])

/**
 * How long a process may go without its CPU time moving before it counts as idle: 30 minutes,
 * in ms. An unowned process idle this long is stale, which "End all stale" ends.
 */
export const IDLE_AFTER_MS = 30 * 60_000

/**
 * The PowerShell that lists every process once: the claude and node ones in
 * full, every process as `pid:ppid:startMs:name` for the tree walk, and the
 * scanner's own ancestry, which is this session. It prints three sections, each
 * starting with its tag on a line of its own output: `@@ROWS@@` then JSON,
 * `@@TREE@@` then the `|`-joined nodes, `@@CHAIN@@` then `,`-joined pids;
 * `parseWindowsScan` reads them back by tag. One CIM query serves all three, so
 * the rows, the tree and the chain describe the same moment.
 */
export const WINDOWS_SCAN = [
  // Any error ends the script with a non-zero exit, which the caller reports, rather than half a scan.
  "$ErrorActionPreference = 'Stop'",
  // A progress bar written to the host would otherwise reach stdout as CLIXML noise.
  "$ProgressPreference = 'SilentlyContinue'",
  '$all = Get-CimInstance Win32_Process',
  '$byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }',
  // The chain: this PowerShell's own pid, then its parent, its parent's parent and so on, at most
  // 40 deep so a pid loop cannot spin. It is this session as seen from below.
  '$chain = @(); $cur = [int]$PID',
  'while ($byId.ContainsKey($cur) -and $chain.Count -lt 40) { $chain += $cur; $cur = [int]$byId[$cur].ParentProcessId }',
  // A creation time as Unix ms, or 0 when CIM cannot read it (another user's protected process).
  "function ms($d) { if ($d) { ([DateTimeOffset]$d).ToUnixTimeMilliseconds() } else { 0 } }",
  // The rows: memory is the working set in MB, cpu is kernel plus user time in seconds (CIM counts
  // it in 100 ns units, hence 1e7), to one decimal. CommandLine is null for a process the scanner
  // may not read, which the parser turns into ''.
  "$rows = $all | Where-Object { $_.Name -in 'node.exe','claude.exe' } | ForEach-Object {",
  '  [pscustomobject]@{ pid = [int]$_.ProcessId; name = $_.Name; start = (ms $_.CreationDate);',
  '    mem = [math]::Round($_.WorkingSetSize / 1MB); cpu = [math]::Round(($_.KernelModeTime + $_.UserModeTime) / 1e7, 1); cmd = $_.CommandLine } }',
  // @() and -InputObject keep a single row an array; one line of JSON, no deeper than the row.
  "'@@ROWS@@' + (ConvertTo-Json -InputObject @($rows) -Compress -Depth 2)",
  // The name goes last because it is the only field that could hold a colon.
  "'@@TREE@@' + (($all | ForEach-Object { '{0}:{1}:{2}:{3}' -f $_.ProcessId, $_.ParentProcessId, (ms $_.CreationDate), $_.Name }) -join '|')",
  "'@@CHAIN@@' + ($chain -join ',')",
].join('\n')

/**
 * PowerShell's -EncodedCommand: the script as UTF-16LE, base64. No quoting to get wrong. Each
 * UTF-16 code unit becomes its low byte then its high byte, so a character outside the BMP goes
 * through as its surrogate pair: `encodePowerShell('ab')` → `YQBiAA==`, `'€'` → `rCA=`.
 */
export function encodePowerShell(script: string): string {
  const units = utf16Units(script)
  const bytes = new Uint8Array(units.length * 2)
  units.forEach((code, i) => {
    bytes[i * 2] = code & 0xff
    bytes[i * 2 + 1] = code >> 8
  })
  return base64(bytes)
}

/**
 * One process of any kind, as the tree walk needs it: `start` is its start time in Unix ms (0
 * when unknown, which turns off the reused-pid checks for it), `name` its executable name in
 * lower case.
 */
export type TreeNode = { pid: number; ppid: number; start: number; name: string }

/**
 * A claude or node process as scanned: `start` in Unix ms, `mem` in MB, `cpu` its total CPU time
 * in seconds, `cmd` its command line exactly as the system reported it (tidied only on the way to
 * the shared cache and to the UI).
 */
export type RawProc = { pid: number; name: string; start: number; mem: number; cpu: number; cmd: string }

/**
 * One scan of the machine: the claude and node `rows`, every process by pid in `tree`, and the
 * scanner's `chain` of ancestors, nearest first (empty for a scan read from the shared cache).
 */
export type Scan = { rows: RawProc[]; tree: Map<number, TreeNode>; chain: number[] }

/**
 * A text field of a parsed `@@ROWS@@` row: the string itself, or '' for anything else. The script
 * writes `name` and `cmd` as strings, or `cmd` as null when the scanner may not read it.
 */
function textField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Reads `WINDOWS_SCAN`'s output back into a `Scan`. A missing section reads as empty, and a
 * single row JSON object as a one-row list. Malformed `@@ROWS@@` JSON throws, which the caller
 * reports as a failed scan. Tree names are lower-cased to match `TERMINALS`, `SHELLS` and `ROOTS`.
 */
export function parseWindowsScan(stdout: string): Scan {
  /**
   * The text after `tag`, up to the next `@@TAG@@` or the end, trimmed; '' when the tag is absent.
   * A tag counts only where it starts a line, as the script prints it: a command line that holds
   * `@@TREE@@` (a grep for this file) sits inside the one-line JSON and can never start one.
   */
  const section = (tag: string): string => {
    const at = new RegExp(`^${tag}`, 'm').exec(stdout)
    if (at === null) return ''
    const rest = stdout.slice(at.index + tag.length)
    const end = rest.search(/\n@@[A-Z]+@@/)
    return (end < 0 ? rest : rest.slice(0, end)).trim()
  }
  const parsed: unknown = JSON.parse(section('@@ROWS@@') || '[]')
  const rows = (Array.isArray(parsed) ? parsed : [parsed]).map(r => {
    const row = r as Record<string, unknown>
    return {
      pid: Number(row.pid),
      name: textField(row.name),
      start: Number(row.start ?? 0),
      mem: Number(row.mem ?? 0),
      cpu: Number(row.cpu ?? 0),
      cmd: textField(row.cmd),
    }
  })
  const tree = new Map<number, TreeNode>()
  for (const entry of section('@@TREE@@').split('|')) {
    // `pid:ppid:startMs:name`; the name is rejoined in case it held a colon of its own.
    const [pid, ppid, start, ...name] = entry.split(':')
    if (pid === undefined || ppid === undefined) continue
    tree.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), start: Number(start ?? 0), name: name.join(':').toLowerCase() })
  }
  const chain = section('@@CHAIN@@')
    .split(',')
    .map(Number)
    .filter(n => n > 0)
  return { rows, tree, chain }
}

/**
 * `[[dd-]hh:]mm:ss[.cc]`, as `ps` prints both `time` and `etime`, in seconds: `01:05` → 65,
 * `00:00.50` → 0.5, `1-02:03:04` → 93784. Missing leading fields count as zero.
 */
function cpuSeconds(time: string): number {
  const dash = time.indexOf('-')
  const days = dash < 0 ? 0 : Number(time.slice(0, dash))
  const parts = time.slice(dash + 1).split(':').map(Number)
  while (parts.length < 3) parts.unshift(0)
  return days * 86_400 + parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
}

/**
 * `PS_SCAN` on macOS and Linux. The names come from a second listing with `comm` last, since
 * on macOS it is a full path that may hold spaces ("Visual Studio Code.app"). `etime` rather
 * than `etimes`, which BSD `ps` does not have. `@@ME@@` carries `$PPID`, the parent of the `sh`
 * running this, which is the session process that ran the scan; it is the whole chain here. The
 * trailing `=` on each column suppresses the header line.
 */
export const PS_SCAN = 'echo "@@ME@@ $PPID"; ps -A -o pid=,ppid=,etime=,rss=,time=,args=; echo @@COMM@@; ps -A -o pid=,comm='

/**
 * Reads `PS_SCAN`'s output back into a `Scan`. `now` (Unix ms) turns each process's elapsed time
 * into a start time, which is therefore accurate only to about a second; the 2 s tolerances in
 * `buildProcs` and `endProcesses` absorb that. `rss` is in KB and becomes MB. A line matching
 * neither listing is skipped, and empty output gives an empty scan.
 */
export function parsePsScan(stdout: string, now: number): Scan {
  const rows: RawProc[] = []
  const tree = new Map<number, TreeNode>()
  const names = new Map<number, string>()
  const lines: RegExpMatchArray[] = []
  let chain: number[] = []
  let isNames = false
  for (const line of stdout.split(/\r?\n/)) {
    const me = /^@@ME@@ (\d+)/.exec(line)
    if (me) {
      chain = [Number(me[1])]
      continue
    }
    if (line.startsWith('@@COMM@@')) {
      isNames = true
      continue
    }
    if (isNames) {
      // `pid comm`, comm possibly a full path with spaces: keep its last part, lower case.
      // The line is trimmed, so after the spaces comes comm's first character: `(\S.*)` says so,
      // and leaves no two quantifiers able to take the same spaces.
      const n = /^(\d+)\s+(\S.*)$/.exec(line.trim())
      if (n) names.set(Number(n[1]), n[2]!.trim().split('/').pop()!.toLowerCase())
      continue
    }
    // `pid ppid etime rss time args`: etime and time as `[[dd-]hh:]mm:ss[.cc]`, args possibly empty.
    // `args` follows its own spaces and starts at a non-space (the line is trimmed); with none, the
    // group does not take part and reads as '' below.
    const m = /^(\d+)\s+(\d+)\s+([\d:-]+)\s+(\d+)\s+(\S+)(?:\s+(\S.*))?$/.exec(line.trim())
    if (m) lines.push(m)
  }
  // Every group of the line pattern takes part in a match except `args`, absent when a process has none.
  for (const [, pid, ppid, elapsed, rss, time, args = ''] of lines) {
    // Without the name listing (an older scan), argv[0] is the next best thing.
    const name = names.get(Number(pid)) ?? args.split(/\s/)[0]!.split('/').pop()!.toLowerCase()
    const start = now - cpuSeconds(elapsed!) * 1000
    tree.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), start, name })
    // comm wins over argv: `node /usr/local/bin/claude` is a claude row, not a node one.
    if (name === 'node' || name === 'claude') {
      rows.push({ pid: Number(pid), name, start, mem: Math.round(Number(rss) / 1024), cpu: cpuSeconds(time!), cmd: args })
    }
  }
  return { rows, tree, chain }
}

/**
 * Whether `node`, whose parent in the tree is `parent`, is a console window someone has open: a
 * shell the Windows desktop started, or a login shell (`login`, `-zsh`) on a tty. A plain shell
 * under pid 1, launchd or systemd is an orphan whose window is gone, re-parented there: it is
 * not one, so `procState` walks on and what it left running can be ended.
 */
function isConsoleWindow(node: TreeNode, parent: TreeNode | undefined): boolean {
  const isLoginShell = node.name === 'login' || node.name.startsWith('-')
  const isUnderRoot = node.ppid === 1 || (parent !== undefined && ROOTS.has(parent.name))
  return SHELLS.has(node.name) && (parent?.name === 'explorer.exe' || (isLoginShell && isUnderRoot))
}

/**
 * How much later than its child a parent may seem to start and still be its parent, in ms. `ps`
 * reports elapsed time in whole seconds, so `parsePsScan` can put a parent up to a second after
 * the child it started; two seconds absorbs that with room to spare, as `buildProcs` and
 * `endProcesses` do when they match a process across scans.
 */
const START_SLACK_MS = 2_000

/**
 * Whether `parent` started too long after `child` to be the process that started it: the ppid
 * was reused by a newer process. A start of 0 is unknown, and never counts as reused.
 */
function isReusedPid(parent: TreeNode, child: TreeNode): boolean {
  return parent.start > 0 && child.start > 0 && parent.start > child.start + START_SLACK_MS
}

/**
 * Whether a process named `name` is one a dead parent leaves behind: a shell, or the node and
 * claude processes this tab lists. Under pid 1 such a process was re-parented there, an orphan;
 * anything else under pid 1 (a desktop app, a LaunchAgent, a user's systemd) was started there.
 */
function isOrphanProne(name: string): boolean {
  return SHELLS.has(name) || /^(?:node|claude)(?:\.exe)?$/.test(name)
}

/**
 * Whether `node`'s chain breaks at its parent `parent`: the parent is gone, the ppid was reused
 * (`isReusedPid`), or the parent is pid 0 or 1 and either is not a system root (a container's own
 * program, Windows' idle process) or `node` is a process that ends up there when its own parent
 * exits (`isOrphanProne`). `procState` calls such a process an orphan. Without the age check a
 * reused pid could lend an orphan the ownership of some unrelated tree.
 */
function isParentGone(node: TreeNode, parent: TreeNode | undefined): boolean {
  if (parent === undefined || isReusedPid(parent, node)) return true
  if (node.ppid > 1) return false
  return !ROOTS.has(parent.name) || isOrphanProne(node.name)
}

/**
 * Walks up from `pid`. In order: this session's tree is `mine`; a tree under
 * a terminal host (a herdr or Windows Terminal tab), or under a console window
 * (a shell Explorer started, or a login shell on a tty), is `protected`; one that
 * reaches the Claude daemon, the desktop app or a system root is `owned`;
 * one whose chain breaks first (`isParentGone`: a parent gone, its pid reused by a
 * newer process, or a shell, node or claude re-parented to pid 1) is `unowned`.
 * `self` holds this session's pids and `hosts` the
 * daemon's and desktop app's. A pid missing from the tree is `unowned`. A chain
 * deeper than 40 is `owned`, the cautious answer: still endable after a confirm,
 * but never stale, so "End all stale" never reaches it.
 */
export function procState(
  pid: number,
  tree: Map<number, TreeNode>,
  self: ReadonlySet<number>,
  hosts: ReadonlySet<number>,
): HudProcState {
  let cur = pid
  for (let depth = 0; depth < 40; depth++) {
    // Checked first, at every level: this session wins over any terminal it sits in.
    if (self.has(cur)) return 'mine'
    const node = tree.get(cur)
    if (node === undefined) return 'unowned'
    if (TERMINALS.has(node.name)) return 'protected'
    // A host of sessions owns what it started; the host itself is kept from ending by `canEnd`.
    if (hosts.has(cur) || ROOTS.has(node.name)) return 'owned'
    const parent = tree.get(node.ppid)
    if (isConsoleWindow(node, parent)) return 'protected'
    if (isParentGone(node, parent)) return 'unowned'
    cur = node.ppid
  }
  return 'owned'
}

/**
 * What a node process is, by its command line: the first pattern that matches names it, so the
 * more specific ones come first (`next dev` before anything it runs, `tsserver` before `tsc`).
 */
const KINDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/next(\.js)?\s+dev|next-server|next[\\/]dist[\\/]server/i, 'next dev'],
  [/vitest/i, 'vitest'],
  [/playwright/i, 'playwright'],
  [/tsserver|typescript[\\/]lib/i, 'tsserver'],
  [/eslint/i, 'eslint'],
  [/\btsc\b/i, 'tsc'],
  [/mcp/i, 'mcp server'],
  [/npx-cli\.js|[\\/]_npx[\\/]/i, 'npx'],
  [/agent-gateway/i, 'gateway'],
  [/drizzle/i, 'drizzle'],
]

/**
 * A command line that runs Claude Code through some other executable, as an npm install does
 * (`node …\@anthropic-ai\claude-code\cli.js`) or a launcher script (`node /usr/local/bin/claude`):
 * the package by name, its `cli.js`, or a `claude` program as a whole word after a slash, a space
 * or a quote.
 */
const RUNS_CLAUDE_CODE = /@anthropic-ai[\\/]claude-code|claude-code[\\/]cli\.[cm]?js|(?:^|[\s"\\/])claude(?:\.exe)?(?=[\s"]|$)/i

/**
 * What a claude process is by its arguments: `daemon` (`daemon run`), `background host`
 * (`--bg-pty-host`) or `background session` (`--session-id`), or undefined for none of them.
 */
function sessionKind(command: string): string | undefined {
  if (/\bdaemon run\b/.test(command)) return 'daemon'
  if (/--bg-pty-host/.test(command)) return 'background host'
  if (/--session-id/.test(command)) return 'background session'
  return undefined
}

/**
 * The kind shown beside a process, and the one `canEnd` reads to keep hosts alive. For `claude`
 * (already normalized by `buildProcs`): `desktop app` when `isDesktop` (it has helpers), else
 * `sessionKind`, else `session`. For `node`, `sessionKind` when it runs Claude Code
 * (`RUNS_CLAUDE_CODE`), so a daemon installed through npm is still a host; otherwise the first
 * matching `KINDS` entry, or '' when none does:
 * `procKind('node', 'node mcp-server.js', false)` → `mcp server`.
 */
export function procKind(name: string, command: string, isDesktop: boolean): string {
  if (name === 'claude') return isDesktop ? 'desktop app' : (sessionKind(command) ?? 'session')
  const asClaude = RUNS_CLAUDE_CODE.test(command) ? sessionKind(command) : undefined
  return asClaude ?? KINDS.find(([pattern]) => pattern.test(command))?.[1] ?? ''
}

/**
 * Keys that stand alone, each known by its issuer's prefix, or a JWT by its shape: Anthropic,
 * OpenAI (its project, service-account and admin keys carry a tag and a dash after `sk-`), Stripe,
 * GitHub (classic and fine-grained), GitLab, npm, Slack (bot, user and app tokens), AWS access key
 * ids (long-lived `AKIA` and temporary `ASIA`), Google API keys, Hugging Face, and three base64url
 * parts with the header starting `eyJ` (`{"`). `SECRET_SHAPES` joins them, in this order, into one
 * alternation behind a `\b`, so where two could match at the same place the earlier one wins and
 * the scan resumes after it, just as one pattern written out whole would; replacing them one after
 * another instead could find a key inside another's match.
 */
const ISSUER_KEYS: readonly RegExp[] = [
  /sk-ant-[\w-]{8,}/,
  /sk-(?:proj|svcacct|admin)-[\w-]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_\w{20,}/,
  /glpat-[\w-]{20,}/,
  /npm_[A-Za-z0-9]{30,}/,
  /xox[abeprs]-[\w-]{10,}/,
  /xapp-[\w-]{10,}/,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /AIza[\w-]{35}/,
  /hf_[A-Za-z0-9]{30,}/,
  /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/,
]

/**
 * The words that name a credential in an option or a setting (`--token`, `client_secret`,
 * `--passphrase`), matched in any case. Only the alternation's source is used, joined with
 * `MORE_CREDENTIAL_WORDS` inside a pattern in `SECRET_SHAPES` that makes it end the word. A word
 * comes before any shorter one it starts with (`password` before `pass`), so the alternation
 * reads in the order the pattern tries it.
 */
const CREDENTIAL_WORDS = /token|key|secret|password|passwd|passphrase|pass|pwd|pw|pat/i

/**
 * More words that name a credential, as `CREDENTIAL_WORDS`, kept apart only so that neither
 * alternation grows too long to read: `--apikey`, `--credentials`, `--creds`, `--signature`,
 * `sig=`, `--jwt`, `--otp`, `--cookie`, `--auth`.
 */
const MORE_CREDENTIAL_WORDS = /apikey|credentials?|creds?|signature|sig|jwt|otp|cookie|auth/i

/**
 * The capitalized words that end a camelCase credential name (`AccountKey`, `clientSecret`),
 * case-sensitive. Only the alternation's source is used, inside the patterns in `SECRET_SHAPES`.
 */
const CAMEL_CREDENTIAL_WORDS = /Token|Key|Secret|Password|Passwd|Passphrase|Pwd|Credentials?|Signature/

/**
 * A quoted value, taken whole with its quotes, so a secret with a space in it goes at once:
 * `"two words"`, `'two words'`, or `\"two words\"` as JSON inside a quoted argument writes it.
 * Anything glued to the closing quote goes with it (`"abc"def` is one shell word), up to the
 * punctuation that ends a JSON value or an argument, which stays: `{"apiKey":"abc"}` →
 * `{"apiKey":***}`. The first choice for a value in `SECRET_SHAPES`.
 */
const QUOTED = /(?:"[^"]*"|'[^']*'|\\"[^"]*\\")[^\s"'}\]),;\\]*/

/**
 * `***`, a value already hidden, where what follows it ends a value: kept as it is, so that
 * tidying again does not take the `}` after `{"apiKey":***}` for more of the value. A value that
 * merely starts with `***` is not this, and `BARE` takes it whole.
 */
const HIDDEN = /\*{3}(?=[\s"'}\]),;\\]|$)/

/**
 * A value without quotes around it, up to the next space or quote, so the quote that closes the
 * argument it sits in stays out of it: `"--api-key=abc"` → `"--api-key=***"`. It may open with a
 * quote that never closes. It never starts at a JSON object or array (`{"` or `{\"`), whose keys
 * are matched one by one instead: `{"auth":{"secret":"x"}}` → `{"auth":{"secret":***}}`.
 */
const BARE = /["']?(?![{[]\\?")[^\s"']+/

/** A credential's value after an option-like name: the first of `QUOTED`, `HIDDEN` and `BARE` that matches. */
const VALUE = `${QUOTED.source}|${HIDDEN.source}|${BARE.source}`

/**
 * A value after a camelCase name in a connection string or a settings file: as `VALUE`, but a bare
 * value stops at a `;` that starts the next `Name=` setting, or ends the text, so the rest keeps
 * its shape, and runs on through any other `;`, which is then part of the secret:
 * `AccountKey=ab;cd;Endpoint=x` → `AccountKey=***;Endpoint=x`. The setting's name is capped at forty characters, which keeps the
 * look ahead from each `;` short.
 */
const SETTING_VALUE = String.raw`${QUOTED.source}|${HIDDEN.source}|(?![{[]\\?")[^\s;"']+(?:;(?![A-Za-z]\w{0,40}=)[^\s;"']+)*`

/**
 * One character of a URL's password: anything but a space, a quote or an `@`, so a password may
 * hold the `?`, `#` and `!` people type unencoded, and a `/` unless a second `/` (the next URL's
 * `://`) or an `@` (a path such as `/@types`) follows it. Stopping at `//` keeps each scan inside
 * its own URL.
 */
const PASSWORD_PART = String.raw`(?:[^\s@"'/]|\/(?![/@]))`

/**
 * Credentials as they appear in a command line, each with what replaces it. `tidyCommand` runs
 * them before quotes come off and paths are shortened, so neither can part a secret from its name
 * or its quotes, and again after. Every repeated part is bounded or anchored, so no pattern
 * backtracks quadratically on a long argument; the tests time 200,000-character arguments against
 * that.
 */
const SECRET_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  // A PEM or PGP private key pasted into an argument, whole: from BEGIN to END, or to the end of
  // the line when it was cut short:
  // `"-----BEGIN RSA PRIVATE KEY-----MIIEow-----END RSA PRIVATE KEY-----"` → `"***"`.
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g, '***'],
  // A URL's whole userinfo, whenever an `@` comes before its host: `postgres://admin:hunter2@db.local:5432`
  // → `postgres://***@db.local:5432`, and `https://token@host`. The user may be empty (`redis://:pw@host`),
  // and the password may hold `@`, `/`, `?` and `#` (`https://u:ab/cd@github.com`): it runs to the last `@`
  // before a `//`, a space or a quote. The user before the colon holds none of `/?#`, so an `@` in a path
  // or a query (`https://registry.npmjs.org/@types/node`, `https://x.com/a?to=bob@x.com`) is no userinfo.
  // A scheme is short; unbounded, a long `a-b-c-…` argument costs quadratic time.
  [new RegExp(String.raw`(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s@"'/:?#]*(?::${PASSWORD_PART}*)?@(?:${PASSWORD_PART}*@)*`, 'gi'), '$1***@'],
  // Authorization: Bearer abc (HTTP scheme names are case-insensitive). Eight characters at least,
  // so prose such as `Basic usage` survives; every character but a space or a quote counts, so a
  // token with symbols in it goes whole: `Bearer sk-abc123` → `Bearer ***`.
  [/\b(Bearer|Basic)\s+[^\s"']{8,}/gi, '$1 ***'],
  // A cookie header, every pair of it up to twenty: `Cookie: a=1; session=abc` → `Cookie: ***`.
  [/(\bcookie[=:]\s*)[^\s"';]+(?:;\s*[^\s"';]+){0,20}/gi, '$1***'],
  // A key standing alone, any of `ISSUER_KEYS`: `ghp_abc…` → `***`.
  [new RegExp(String.raw`\b(?:${ISSUER_KEYS.map(key => key.source).join('|')})`, 'g'), '***'],
  // curl's -u bob:hunter2, -ubob:hunter2 and --user bob:hunter2, the password after the colon:
  // `-u bob:hunter2` → `-u bob:***`.
  [/((?<!\S)(?:-u|--user)[\s=]*["']?[^\s:"'=]+:)[^\s"']+/g, '$1***'],
  // mysql's and mariadb's -p with the password glued on, among their first twenty arguments:
  // `mysql -u root -phunter2 db` → `mysql -u root -p*** db`. A -p on its own asks for the
  // password, and another tool's -p is a port or a path, so neither is touched.
  [/(\b(?:mysql|mariadb)\w*(?:\s+(?:[^\s-]|-[^\sp])\S*){0,20}\s+-p)[^\s"']+/g, '$1***'],
  // Tools that take a password as a plain argument: `sshpass -p hunter2`, `redis-cli -a hunter2`,
  // `vault login s.abc` → `sshpass -p ***`.
  [new RegExp(String.raw`(\b(?:sshpass\s+-p\s*|redis-cli\s+-a\s+|vault\s+login\s+))(?:${VALUE})`, 'g'), '$1***'],
  // A password PowerShell turns into a SecureString:
  // `ConvertTo-SecureString 'hunter2' -AsPlainText` → `ConvertTo-SecureString *** -AsPlainText`.
  [new RegExp(String.raw`(\bConvertTo-SecureString\s+(?:-String\s+)?)(?:${VALUE})`, 'gi'), '$1***'],
  // --token abc, --client_secret 'abc', github_token=abc, {"apiKey":"abc"}: a credential's name, in
  // any case, then its `VALUE`. The name's prefix is capped at four parts: unbounded, a long
  // `a_b_c_…` argument costs quadratic time. The name must end the word, but for up to four digits
  // (`--token2`) and the quote that closes a quoted name (`"--token" "abc"`, `\"apiKey\":`), before the
  // `=`, `:` or spaces after it, so `--keyboard`, `--author`, `--passes` and `--hotkey=ctrl` are left
  // alone. A quoted value goes whole: `--api-key "two words"` → `--api-key ***`.
  [
    new RegExp(String.raw`((?<![a-z0-9])(?:[a-z0-9]+[_-]){0,4}(?:${CREDENTIAL_WORDS.source}|${MORE_CREDENTIAL_WORDS.source})\d{0,4}(?:\\?["'])?[=:\s]+)(?:${VALUE})`, 'gi'),
    '$1***',
  ],
  // AccountKey=abc, clientSecret: abc, _authToken=abc, "accessToken":"abc": a camelCase name ending in
  // one (connection strings, .npmrc, JSON). Case-sensitive, so the capital marks the word boundary;
  // the value is a `SETTING_VALUE`, so the rest of a connection string keeps its shape:
  // `AccountKey=c2Vj…;EndpointSuffix=core` → `AccountKey=***;EndpointSuffix=core`.
  [
    new RegExp(
      String.raw`((?<![A-Za-z0-9])[A-Za-z0-9]*[a-z0-9](?:${CAMEL_CREDENTIAL_WORDS.source})\d{0,4}(?:\\?["'])?[=:]\s*)(?:${SETTING_VALUE})`,
      'g',
    ),
    '$1***',
  ],
  // -AccessToken abc, --clientSecret abc: a camelCase option with a space before its value, as
  // PowerShell passes one: `-ClientSecret s3cret` → `-ClientSecret ***`.
  [new RegExp(String.raw`((?<!\S)--?[A-Za-z0-9]*[a-z0-9](?:${CAMEL_CREDENTIAL_WORDS.source})\d{0,4}\s+)(?:${VALUE})`, 'g'), '$1***'],
  // API_KEY_ID=abc, DB_CONNECTION_STRING=abc: the name in the middle of an environment variable.
  // Upper case only, so it reads as an environment variable: `API_KEY=s3cret` → `API_KEY=***`. The
  // parts on either side of the name are capped at forty characters: unbounded, a long run of upper
  // case (`AKEYAKEY…`) costs quadratic time.
  [
    new RegExp(String.raw`\b([A-Z][A-Z0-9_]{0,40}(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|CONNECTION_STRING)[A-Z0-9_]{0,40}=)(?:${VALUE})`, 'g'),
    '$1***',
  ],
]

/** `text` with every `SECRET_SHAPES` pattern replaced, one after another. */
function redact(text: string): string {
  return SECRET_SHAPES.reduce((out, [pattern, to]) => out.replace(pattern, to), text)
}

/**
 * A quoted argument that stands alone, after a space, the start or an `=` and before a space or
 * the end, with no quote of either kind inside: `"C:\Program Files\nodejs\node.exe"`,
 * `--hook="https://…"`. Its quotes come off (`unquote`). One with a quote inside, such as JSON in
 * single quotes, keeps its own: taking them off could pair a quote inside with one outside, and
 * tidying again would find more to take off.
 */
const LONE_QUOTED = /(?<![^\s=])(?:"([^"']*)"|'([^"']*)')(?!\S)/g

/**
 * A `LONE_QUOTED` argument without its quotes (the inside of the double or the single ones). A
 * quoted absolute path of two slashes or more shortens to its last part here, whatever its
 * folders hold: a space, which only the quotes held together (`"C:\Program Files\nodejs\node.exe"`
 * → `node.exe`), or a `:` or `=`, where `URL_OR_PATH` would see two values. Anything else is left
 * for `URL_OR_PATH`.
 */
function unquote(_: string, double: string | undefined, single: string | undefined): string {
  const text = double ?? single!
  return /^(?:[a-z]:)?[\\/][^\\/]*[\\/]/i.test(text) ? baseName(text) : text
}

/**
 * A URL's scheme and host, up to the first `/`, `?` or `#`: what `tidyCommand` keeps of a URL.
 * The host may be empty, as in `file:///etc/passwd`. A scheme is short; unbounded, a long
 * `a-b-c-…` argument costs quadratic time.
 */
const URL_HEAD = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/?#]*/i

/**
 * One character of a part of a path: anything but a slash, a space, a quote, or the punctuation
 * that parts a value from its name or from the next value (`=`, `:`, `,`, `;`, brackets), so
 * `PATH=/usr/bin` keeps its name and `/a/b:/c/d` is two paths.
 */
const PATH_PART = String.raw`[^\s"'\\/=:,;()[\]{}]`

/**
 * A path with two or more slashes (or runs of them) among its parts, relative or not, with or
 * without a drive letter, capturing its last part: `dist/cli/index.js`, `./certs/server.key`,
 * `/usr/bin/node` and `C:\x\npx-cli.js` are such paths, while `@playwright/mcp`, `src/x` and
 * `/node` are not (one slash names a package or a folder, not where a program lives). It starts
 * only at the start of a word, after a space, a quote or the punctuation `PATH_PART` leaves out,
 * so it never starts inside a part or a run of slashes (`dist/cli/index.js` once became
 * `distindex.js`), and each character is tried by one start at most: tried from every slash of a
 * long run, it took quadratic time (a second for 40,000). Its last part is whole and is never a
 * URL's scheme: in `a/b/https://host/x` the path ends at `b`, so the URL after it is still
 * shortened as a URL, in the same pass.
 */
const LONG_PATH = new RegExp(
  String.raw`(?<![^\s"'=:,;([{])(?:[a-z]:)?${PATH_PART}*[\\/]+${PATH_PART}+(?:[\\/]+${PATH_PART}+)*[\\/]+(${PATH_PART}+)(?!${PATH_PART}|:\/\/)`,
  'i',
)

/**
 * Either a URL (`URL_HEAD`, then whatever follows up to a space or a quote) or a `LONG_PATH`, as
 * one pattern, so that at each place the URL is tried first and a match is never searched again.
 * Its groups are the URL's head, the rest of the URL, and the path's last part.
 */
const URL_OR_PATH = new RegExp(String.raw`(${URL_HEAD.source})([/?#][^\s"']*)?|${LONG_PATH.source}`, 'gi')

/** What is left of a `URL_OR_PATH` match: a URL's head, with `/…` when anything followed it, or a path's last part. */
function shorten(_: string, url: string | undefined, rest: string | undefined, last: string | undefined): string {
  if (url === undefined) return last!
  return rest ? `${url}/…` : url
}

/**
 * Hides anything that looks like a credential in a command line, shortens paths to their
 * last part and URLs to their host: a URL's path and query can carry a secret of their own.
 * The steps, in order:
 * 1. Format characters (`\p{Cf}`) are dropped: a right-to-left override would reorder what the tab
 *    shows, and a zero-width space would part a credential's name. Every run of control characters
 *    and whitespace becomes one space, so no terminal escape reaches the tab.
 * 2. Credentials are hidden (`SECRET_SHAPES`), while each still sits next to its name and quotes.
 * 3. Lone quoted arguments lose their quotes (`LONE_QUOTED`), then URLs and paths are shortened
 *    (`URL_OR_PATH`).
 * 4. Credentials are hidden again, since shortening can bring a name next to a value that a path
 *    held apart, and spaces are collapsed.
 * The result tidies to itself: the shared file holds a command tidied once, and each session's tab
 * tidies it again, so both show the same text.
 * `tidyCommand('node app.js --token abc123 API_KEY=s3cret')` → `node app.js --token *** API_KEY=***`;
 * `tidyCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\x\\npx-cli.js" -y @playwright/mcp')`
 * → `node.exe npx-cli.js -y @playwright/mcp`; `https://api.example.com/v1/users?id=7` →
 * `https://api.example.com/…`. It is a best effort over known shapes, not a guarantee: a secret
 * passed with no recognizable name or prefix stays visible.
 */
export function tidyCommand(command: string): string {
  const plain = command.replaceAll(/\p{Cf}/gu, '').replaceAll(/[\s\p{Cc}]+/gu, ' ')
  const shortened = redact(plain).replaceAll(LONE_QUOTED, unquote).replaceAll(URL_OR_PATH, shorten)
  return redact(shortened).replaceAll(/\s+/g, ' ').trim()
}

/** Whether `proc`'s CPU time has not moved for `IDLE_AFTER_MS` or more, as of `now` (Unix ms); exactly 30 minutes counts. */
export function isIdle(proc: HudProc, now: number): boolean {
  return now - proc.activeAt >= IDLE_AFTER_MS
}

/** Unowned and doing nothing for half an hour: what "End all stale" ends. */
export function isStale(proc: HudProc, now: number): boolean {
  return proc.state === 'unowned' && isIdle(proc, now)
}

/**
 * Hosts of other sessions: ending one ends every session inside it. These are `procKind`'s
 * names, and they hold whatever the process's state, even `unowned`.
 */
const HOST_KINDS = new Set(['desktop app', 'daemon', 'background host'])

/**
 * Whether the person may end it at all: never this session, never a terminal tab, never a host of
 * sessions, and never pid 0 or 1, the system's first process (a container's own program, when that
 * is node): ending it ends the machine or the container. The Procs tab shows an End button only
 * where this holds, and `endProcesses` checks it again against a fresh scan before ending anything.
 */
export function canEnd(proc: HudProc): boolean {
  return proc.pid > 1 && (proc.state === 'owned' || proc.state === 'unowned') && !HOST_KINDS.has(proc.kind)
}

/**
 * Every ancestor of the given pids. Ending a process ends its tree (`taskkill /T`),
 * so an ancestor of this session or of a protected tab can never be ended either.
 * The given pids themselves are not included unless one is an ancestor of another. The walk
 * from each pid stops at a parent missing from the tree, a process that is its own parent (pid
 * 0 on Windows), a reused pid (`isReusedPid`, as `procState` reads it), a parent already
 * collected (so shared ancestors are walked once), or 40 levels.
 */
export function ancestorsOf(pids: Iterable<number>, tree: Map<number, TreeNode>): Set<number> {
  const out = new Set<number>()
  for (const pid of pids) {
    let cur = tree.get(pid)
    for (let depth = 0; cur !== undefined && depth < 40; depth++) {
      const parent = tree.get(cur.ppid)
      // A parent that started after its child, by more than `ps` rounding explains, is a reused pid.
      if (parent === undefined || cur.ppid === cur.pid || isReusedPid(parent, cur)) break
      // Everything above an ancestor already collected has been collected with it.
      if (out.has(parent.pid)) break
      out.add(parent.pid)
      cur = parent
    }
  }
  return out
}

/**
 * The colour that says what the person can do with `proc`: blue for this session, red for stale,
 * amber for unowned but still active, grey for idle, green for active. Stale is checked before
 * unowned, since a stale process is also unowned. Also the memory Raster's colours.
 */
export function procHex(proc: HudProc, now: number): string {
  if (proc.state === 'mine') return '#58a6ff'
  if (isStale(proc, now)) return '#f85149'
  if (proc.state === 'unowned') return '#d29922'
  if (isIdle(proc, now)) return '#8b949e'
  return '#3fb950'
}

/**
 * This session's own pids, from a scan this session ran: the scanner, then
 * its parent (or the first claude above it). A shared scan another session
 * ran cannot say which session is "this" one, so each session keeps its own.
 * On Windows the chain starts at the scanning PowerShell, so this is that PowerShell up to and
 * including the first claude within four levels, or the PowerShell and its parent when there is
 * none. Under `ps` the chain is the one pid that ran `sh`, which is the whole answer.
 */
export function selfOf(scan: Scan): number[] {
  const firstClaude = scan.chain.findIndex(pid => /^claude(\.exe)?$/.test(scan.tree.get(pid)?.name ?? ''))
  return scan.chain.slice(0, firstClaude >= 0 && firstClaude <= 3 ? firstClaude + 1 : 2)
}

/** A scan as the sessions share it on disk: command lines already tidied (paths shortened, credentials hidden). */
export type CachedScan = { at: number; rows: RawProc[]; tree: TreeNode[] }

/**
 * The form of `scan` written to the shared file, taken at `at` (Unix ms). Each command line is
 * tidied here, before it reaches the disk; the chain is dropped, since it names the scanning
 * session and means nothing to the others.
 */
export function toCache(scan: Scan, at: number): CachedScan {
  return { at, rows: scan.rows.map(r => ({ ...r, cmd: tidyCommand(r.cmd) })), tree: [...scan.tree.values()] }
}

/**
 * A shared scan back as a `Scan`, with an empty chain: the reader passes its own self pids to
 * `buildProcs` instead. `readCachedScan` in register.tsx checks its age and shape before this.
 */
export function fromCache(cached: CachedScan): Scan {
  return { rows: cached.rows, tree: new Map(cached.tree.map(n => [n.pid, n])), chain: [] }
}

/**
 * Whether `row` is one of the desktop app's Electron helpers on Windows (or on macOS, read without
 * a name listing): a claude process run with `--type=`. Only a claude process is one: Electron
 * starts them as copies of the app, while a node process's `--type=module` is an option of the
 * program it runs.
 */
function isDesktopHelper(row: RawProc): boolean {
  return /^claude(\.exe)?$/i.test(row.name) && / --type=/.test(row.cmd)
}

/**
 * The desktop app's main binary on macOS, by the path it runs from:
 * `/Applications/Claude.app/Contents/MacOS/Claude`. Its helpers run from under `Frameworks`, so
 * none of them matches.
 */
const MAC_DESKTOP = /Claude\.app\/Contents\/MacOS\/Claude(?=\s|$)/

/**
 * The pids of the desktop app, a host of sessions. A helper's parent is the app itself, which is
 * how the app is known: the parent of an `isDesktopHelper` row, or of any process `comm` names
 * `claude helper …`, as macOS names the helpers (they are no claude rows there, so the first test
 * alone never finds the app). A claude row running `MAC_DESKTOP` is the app too, helpers or not.
 */
function desktopPids(scan: Scan): Set<number> {
  const helperParents = [
    ...scan.rows.filter(isDesktopHelper).map(r => scan.tree.get(r.pid)?.ppid ?? 0),
    ...[...scan.tree.values()].filter(n => n.name.startsWith('claude helper')).map(n => n.ppid),
  ]
  return new Set([...helperParents, ...scan.rows.filter(r => MAC_DESKTOP.test(r.cmd)).map(r => r.pid)])
}

/**
 * Builds the list from a scan, carrying each process's CPU history over from the previous scan.
 * `previous` is the last list built, taken at `lastAt` (Unix ms), and `now` is this scan's time;
 * `selfPids` defaults to the scan's own chain, and is passed explicitly for a shared scan, which
 * has none. The list is sorted stale first, then the other unowned ones, then by memory, largest
 * first, so what the person most likely wants to end is at the top.
 */
export function buildProcs(
  scan: Scan,
  previous: readonly HudProc[],
  now: number,
  lastAt: number,
  selfPids: readonly number[] = selfOf(scan),
): HudProc[] {
  const self = new Set(selfPids)
  // The desktop app's helpers are folded into it; it and the daemon own their children.
  const desktop = desktopPids(scan)
  const hosts = new Set([...desktop, ...scan.rows.filter(r => /\bdaemon run\b/.test(r.cmd)).map(r => r.pid)])
  const before = new Map(previous.map(p => [p.pid, p]))
  const kept = scan.rows.filter(r => r.pid > 0 && /^(node|claude)(\.exe)?$/i.test(r.name) && !isDesktopHelper(r))
  const states = new Map(kept.map(r => [r.pid, procState(r.pid, scan.tree, self, hosts)]))
  // Whatever holds this session or a terminal tab in its tree is protected with it.
  const holders = ancestorsOf([...self, ...kept.filter(r => states.get(r.pid) !== 'owned' && states.get(r.pid) !== 'unowned').map(r => r.pid)], scan.tree)
  return kept
    .map(r => {
      const name = r.name.toLowerCase().startsWith('claude') ? 'claude' : 'node'
      const prior = before.get(r.pid)
      // The same process only when the start time agrees within 2 s; otherwise the pid was reused
      // and the old CPU figure belongs to something else.
      const isSame = prior !== undefined && Math.abs(prior.startedAt - r.start) < 2_000
      const delta = isSame ? r.cpu - prior.cpuSec : undefined
      const interval = Math.max(1, now - lastAt)
      // CPU seconds over the interval in ms, as percent of one core to one decimal:
      // delta * 1000 / interval is the fraction, * 100 the percent, * 10 then round then / 10 the
      // decimal. Never negative, though the counter can step back between the two scan methods.
      const cpuPct = delta === undefined ? undefined : Math.max(0, Math.round((delta * 1000 * 1000) / interval) / 10)
      // A process first seen counts as active now; after that, only when its CPU time moves.
      // Moving means 0.2 s of CPU or more since the last scan, so background ticking stays idle.
      const activeAt = isSame && delta !== undefined && delta < 0.2 ? prior.activeAt : now
      return {
        pid: r.pid,
        name,
        startedAt: r.start,
        memMb: r.mem,
        cpuSec: r.cpu,
        cpuPct,
        activeAt,
        // An ancestor of this session or of a protected process would take them with it under
        // `taskkill /T`; this session's own pids stay `mine`.
        state: holders.has(r.pid) && states.get(r.pid) !== 'mine' ? 'protected' : states.get(r.pid)!,
        kind: procKind(name, r.cmd, desktop.has(r.pid)),
        command: tidyCommand(r.cmd),
      } satisfies HudProc
    })
    .sort((a, b) => Number(isStale(b, now)) - Number(isStale(a, now)) || Number(b.state === 'unowned') - Number(a.state === 'unowned') || b.memMb - a.memMb)
}

/**
 * Memory as one stacked row, each process's share colored by its state.
 * The result is the Raster's packed cells, base64: three little-endian uint32 words per cell,
 * the glyph's code point, the foreground as 0xRRGGBB and the background (`DEFAULT_COLOR`, the
 * terminal's own). Each process with memory takes at least one full block (U+2588), in `procs`
 * order, so a long tail of small ones may run past the row and be cut off; the rest of the row is
 * light shade (U+2591) in a dim grey. The row always has exactly `columns` cells, all shade when
 * nothing uses memory.
 */
export function memoryCells(procs: readonly HudProc[], columns: number, now: number): string {
  const total = procs.reduce((sum, p) => sum + p.memMb, 0)
  const words = new Uint32Array(columns * 3)
  let col = 0
  for (const proc of procs) {
    const cells = total === 0 ? 0 : Math.max(1, Math.round((proc.memMb / total) * columns))
    const color = Number.parseInt(procHex(proc, now).slice(1), 16)
    for (let i = 0; i < cells && col < columns; i++, col++) words.set([0x2588, color, DEFAULT_COLOR], col * 3)
  }
  for (; col < columns; col++) words.set([0x2591, 0x30363d, DEFAULT_COLOR], col * 3)
  // The Uint32Array's bytes are in the platform's order, little-endian on every supported machine.
  return base64(new Uint8Array(words.buffer))
}

/**
 * The PowerShell that ends one process tree on Windows, only while the pid still
 * belongs to the process that started at `startedAt` (exit 3 when it does not).
 * The check and the kill run in one script, so the window for the pid to be reused between them
 * is as small as it can be. `pid` and `startedAt` are truncated to integers and must be safe
 * integers (and the pid positive) before they are written into the script; anything else returns
 * the bare script `exit 3`, so no value can carry PowerShell of its own. Exit codes: 3 when
 * refused, gone, or a different process now; otherwise taskkill's own (0 when the tree ended).
 */
export function endScript(pid: number, startedAt: number): string {
  const id = Math.trunc(pid)
  const start = Math.trunc(startedAt)
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(start)) return 'exit 3'
  return [
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${id}'`,
    // Gone since the scan.
    'if ($null -eq $p) { exit 3 }',
    '$ms = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()',
    // Started more than 2 s away from the process the person chose: the pid was reused.
    `if ([math]::Abs($ms - ${start}) -ge 2000) { exit 3 }`,
    // /T ends the whole tree, /F without asking it to close first.
    `taskkill /PID ${id} /T /F | Out-Null`,
    'exit $LASTEXITCODE',
  ].join('\n')
}
