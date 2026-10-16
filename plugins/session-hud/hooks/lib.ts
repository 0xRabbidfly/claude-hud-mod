/**
 * Small pure helpers shared across the HUD: the context colour gradient and the Hub's context
 * bar and its patterns, base64 for Raster cells, text bars and number formats, parsers for
 * `git status`, `git diff --numstat` and `git log --shortstat` output, short names for /context
 * categories and rate-limit windows, release version comparison, a text fingerprint, and the
 * UTF-16 code units it hashes.
 *
 * Nothing here touches the engine. `register.tsx` uses most of it to draw the Hub; `aria.ts`,
 * `panels.ts` and `procs.ts` borrow `base64` and `gradient` for their own Raster cells,
 * `panels.ts` uses `fingerprint` to notice the cached prompt prefix changing, and `procs.ts`
 * uses `utf16Units` to encode a PowerShell script.
 */
import type { HudCommit, HudFile, HudFileCode, HudGit } from '../types'

/**
 * Context quality bands: green while the window is light, red as it nears compaction.
 * Each stop is a position on the 0-1 scale and the 0xRRGGBB colour at it; the 0.4, 0.6 and
 * 0.8 stops match the bands of `qualityLabel`.
 */
const STOPS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0x3fb950],
  [0.4, 0xd29922],
  [0.6, 0xf0883e],
  [0.8, 0xf85149],
  [1.0, 0xa40e26],
]

/**
 * The colour at `t` on the context gradient (`STOPS`), as 0xRRGGBB, blending each channel
 * linearly between the two stops around it. `t` is a fraction, 0-1, and is clamped, so callers
 * pass a percent divided by 100. `gradient(0)` → `0x3fb950` (green), `gradient(1)` →
 * `0xa40e26` (deep red).
 */
export function gradient(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i]!
    const [t0, c0] = STOPS[i - 1]!
    if (x <= t1) {
      // How far `x` is from the lower stop to the upper one, 0-1.
      const f = (x - t0) / (t1 - t0)
      /** One 8-bit channel (`shift` 16 red, 8 green, 0 blue) blended by `f`, left in place in the word. */
      const ch = (shift: number): number => {
        const a = (c0 >> shift) & 0xff
        const b = (c1 >> shift) & 0xff
        return Math.round(a + (b - a) * f) << shift
      }
      return ch(16) | ch(8) | ch(0)
    }
  }
  // Unreachable while the last stop is at 1.0 and `x` is clamped; kept as a safe fallback.
  return STOPS.at(-1)![1]
}

/** A 0xRRGGBB colour as CSS hex for text: `hex(0x3fb950)` → `#3fb950`. */
export function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

/**
 * The context percent (0-100) in words, on the same bands as the gradient: under 40 `sharp`,
 * under 60 `good`, under 80 `degrading`, then `compact soon`; `no reading yet` when undefined.
 */
export function qualityLabel(percent: number | undefined): string {
  if (percent === undefined) return 'no reading yet'
  if (percent < 40) return 'sharp'
  if (percent < 60) return 'good'
  if (percent < 80) return 'degrading'
  return 'compact soon'
}

/** The CSS colour of a Hub rate-limit bar for its percent used (0-100): green, amber from 50, red from 80. */
export function limitColor(percent: number): string {
  if (percent < 50) return '#3fb950'
  if (percent < 80) return '#d29922'
  return '#f85149'
}

/**
 * The textures the context's categories are drawn in, largest first: the bar fills each
 * category's share with its own glyph, and the legend under it repeats it, so a category reads
 * in the bar by its pattern rather than by a colour of its own.
 */
export const PART_PATTERNS = ['█', '▓', '▒', '░'] as const

/**
 * `n` cells shared out between `weights` in proportion, by largest remainder, so the counts
 * always add up to `n`. While there are at least as many cells as weighted entries, each one
 * gets a cell, taken from the largest share, so a small category still shows in the bar.
 * Entries of zero or less get none; with no weight at all, the first entry takes every cell.
 * `allocate([3, 1], 8)` → `[6, 2]`; `allocate([98, 1, 1], 5)` → `[3, 1, 1]`.
 */
export function allocate(weights: readonly number[], n: number): number[] {
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0)
  if (total <= 0) return weights.map((_, i) => (i === 0 ? n : 0))
  const raw = weights.map(w => (Math.max(0, w) / total) * n)
  const counts = raw.map(Math.floor)
  // The cells flooring left over go to the largest fractions; an entry without weight has none.
  const byRemainder = [...raw.keys()].sort((a, b) => raw[b]! - counts[b]! - (raw[a]! - counts[a]!))
  const left = n - counts.reduce((sum, c) => sum + c, 0)
  for (const i of byRemainder.slice(0, left)) counts[i]!++
  const weighted = weights.filter(w => w > 0).length
  if (n < weighted) return counts
  for (const i of counts.keys()) {
    if (weights[i]! <= 0 || counts[i]! > 0) continue
    // Some entry holds two or more: the cells add up to n, which covers one per weighted entry.
    const largest = counts.indexOf(Math.max(...counts))
    counts[largest]!--
    counts[i] = 1
  }
  return counts
}

/**
 * The categories the context legend lists, at most `max` (one per pattern): the largest as
 * they are, and past that the rest summed into one `other` in the last place.
 */
export function legendParts<P extends { name: string; tokens: number }>(
  parts: readonly P[],
  max: number = PART_PATTERNS.length,
): { name: string; tokens: number }[] {
  if (parts.length <= max) return parts.map(p => ({ name: p.name, tokens: p.tokens }))
  const rest = parts.slice(max - 1).reduce((sum, p) => sum + p.tokens, 0)
  return [...parts.slice(0, max - 1).map(p => ({ name: p.name, tokens: p.tokens })), { name: 'other', tokens: rest }]
}

/**
 * The Hub's context bar: `width` characters for `percent` (0-100, clamped), its filled run
 * drawn in each category's pattern, shared out between them by `allocate` (solid without
 * `weights`), and the empty run in `·`, which no pattern uses.
 * `patternBar(50, 8, [3, 1])` → `{ full: '███▓', empty: '····' }`.
 */
export function patternBar(percent: number, width: number, weights: readonly number[] = []): { full: string; empty: string } {
  const n = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  const counts = allocate(weights.length === 0 ? [1] : weights.slice(0, PART_PATTERNS.length), n)
  return { full: counts.map((count, i) => PART_PATTERNS[i]!.repeat(count)).join(''), empty: '·'.repeat(width - n) }
}

/** Cells of cargo in each car of the Hub's context train. */
export const CAR_CARGO = 6

/** Columns a car of the train takes: its two walls, its cargo and the coupler in front of it. */
const CAR_COLUMNS = CAR_CARGO + 3

/** The engine at the train's head, in columns: cab, boiler, chimney and nose. */
const ENGINE_COLUMNS = 5

/**
 * The Hub's context bar as a train in `width` columns: as many cars as fit behind the engine
 * (one at least), their cargo filled as `patternBar` fills that many cells and dealt to the
 * cars from the back, CAR_CARGO cells each (`·` where none is loaded); and the car that holds
 * `compactAt` (a percent), whose coupler marks it. `trainCars(38, 40, [2, 1], 40)` → 3 cars,
 * `['█████▓', '▓·····', '······']`, compaction in car 1.
 */
export function trainCars(percent: number, width: number, weights: readonly number[], compactAt: number): { cars: string[]; compactCar: number } {
  const count = Math.max(1, Math.floor((width - ENGINE_COLUMNS) / CAR_COLUMNS))
  const cells = count * CAR_CARGO
  const b = patternBar(percent, cells, weights)
  const load = b.full + b.empty
  const cars = Array.from({ length: count }, (_, i) => load.slice(i * CAR_CARGO, (i + 1) * CAR_CARGO))
  const compactCar = Math.min(count - 1, Math.floor((Math.max(0, compactAt) / 100) * count))
  return { cars, compactCar }
}

/** The standard base64 alphabet (RFC 4648, not the URL-safe one). */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Standard padded base64 of `bytes`: the encoding a Raster's `cells` expects. Written out
 * here so it needs neither `btoa` nor `Buffer`. Pass `new Uint8Array(words.buffer)` to encode
 * a Uint32Array of cells, which keeps the platform's byte order (little-endian on every
 * platform Claude Code runs on).
 */
export function base64(bytes: Uint8Array): string {
  let out = ''
  // Three bytes make one 24-bit group and four 6-bit characters; a short last group pads with '='.
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += b === undefined ? '=' : B64[(n >> 6) & 63]!
    out += c === undefined ? '=' : B64[n & 63]!
  }
  return out
}

/**
 * A text progress bar `width` characters wide for `percent` (0-100, clamped), split into its
 * filled and empty runs so each can be coloured: `bar(50, 10)` → five `█` and five `░`.
 * The Hub's context bar off the terminal, and each rate-limit window.
 */
export function bar(percent: number, width: number): { full: string; empty: string } {
  const n = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return { full: '█'.repeat(n), empty: '░'.repeat(width - n) }
}

/**
 * A token count in a few characters: as is under 1,000, whole thousands with `k`, and millions
 * with `M` to one decimal place, a trailing `.0` dropped.
 * `formatTokens(999)` → `999`, `formatTokens(999_499)` → `999k`, `formatTokens(999_600)` → `1M`,
 * `formatTokens(1_500_000)` → `1.5M`.
 */
export function formatTokens(n: number): string {
  // From 999.5k, rounding to thousands would print 1000k: say 1M instead.
  if (n >= 999_500) return `${Number((n / 1_000_000).toFixed(1))}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** A memory size in megabytes as `512 MB`, or `1.5 GB` from 1024 MB up. */
export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

/**
 * A duration in `ms` as the two largest units, rounded down: `now` for zero or less, then
 * `5m`, `1h 05m` or `1d 3h`. Under a minute shows `0m`. Used for when a rate limit resets,
 * when the 5-hour window runs out, and how long the prompt cache stays warm.
 */
export function formatSpan(ms: number): string {
  if (ms <= 0) return 'now'
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m`
  return `${mins}m`
}

/**
 * A rate-limit window's `kind` as the Hub labels it, short enough for two windows to share a
 * row: `five_hour` → `5h`, `seven_day` → `7d`, `seven_day_opus` → `7d opus`, and any other
 * with spaces for underscores.
 */
export function limitName(kind: string): string {
  return kind.replace(/^five_hour/, '5h').replace(/^seven_day/, '7d').replaceAll('_', ' ')
}

/**
 * The one-letter change code for a porcelain status pair `xy` (index and worktree columns):
 * `?` for untracked, else deleted, renamed or added if either column says so, in that order,
 * and `M` for everything else (including conflicts and copies).
 */
function codeOf(xy: string): HudFileCode {
  if (xy === '??') return '?'
  if (xy.includes('D')) return 'D'
  if (xy.includes('R')) return 'R'
  if (xy.includes('A')) return 'A'
  return 'M'
}

/** The C escapes git writes in a quoted path for the control characters it holds. */
const C_ESCAPES: Readonly<Record<string, string>> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r' }

/**
 * A path as git printed it, with the C-style quoting git adds around unusual names undone.
 * Git writes each byte outside printable ASCII as a three-digit octal escape, and those bytes
 * are UTF-8, so they are gathered as bytes and decoded together: `"caf\303\251.ts"` → `café.ts`.
 * A control character comes back from its letter (`\t` → a tab), and any other escaped character
 * is itself (`"a\"b.ts"` → `a"b.ts`). A path without both quotes is returned as is.
 */
function unquote(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path
  const body = path.slice(1, -1)
  const encoder = new TextEncoder()
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const code = body.codePointAt(i)!
    // A character outside the BMP is two UTF-16 units: step over the second.
    if (code > 0xffff) i++
    if (code !== 0x5c || i + 1 >= body.length) {
      bytes.push(...encoder.encode(String.fromCodePoint(code)))
      continue
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0]
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8) & 0xff)
      i += octal.length
      continue
    }
    const escaped = body[++i]!
    bytes.push(...encoder.encode(C_ESCAPES[escaped] ?? escaped))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** The number captured by `pattern`'s first group in `text`, or 0 when it does not match. */
function countIn(text: string, pattern: RegExp): number {
  return Number(pattern.exec(text)?.[1] ?? 0)
}

/**
 * Parses `git status --porcelain=v1 -b`: the `## branch...upstream [ahead n, behind m]` header
 * and one entry per changed file. A new repository's branch comes from `No commits yet on`,
 * a detached head reads `detached HEAD`, a branch without an upstream has `upstream` null, and
 * a rename keeps only its new path. The branch is `?` when the output has no header.
 */
export function parseStatus(
  output: string,
): Pick<HudGit, 'branch' | 'upstream' | 'ahead' | 'behind' | 'files'> {
  const lines = output.split(/\r?\n/).filter(line => line.length > 0)
  let branch = '?'
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const files: HudFile[] = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // The header: local branch, then optionally "...remote" and " [ahead n, behind m]".
      const head = line.slice(3)
      const noCommits = /^No commits yet on (.+)$/.exec(head)
      if (noCommits) {
        branch = noCommits[1]!
        continue
      }
      const [names = '', tracking = ''] = head.split(' [')
      const [local = '?', remote] = names.split('...')
      branch = local === 'HEAD (no branch)' ? 'detached HEAD' : local
      upstream = remote ?? null
      ahead = countIn(tracking, /ahead (\d+)/)
      behind = countIn(tracking, /behind (\d+)/)
      continue
    }
    // A file line: two status columns, a space, then the path ("old -> new" for a rename).
    const xy = line.slice(0, 2)
    const rest = line.slice(3)
    const path = rest.includes(' -> ') ? rest.split(' -> ')[1]! : rest
    files.push({ code: codeOf(xy), path: unquote(path) })
  }
  return { branch, upstream, ahead, behind, files }
}

/**
 * The branches `branch` may have been made from, most likely first: the remote's default
 * (`originHead`, as `git symbolic-ref --short refs/remotes/origin/HEAD` prints it), then main
 * and master on the remote and locally. Never the branch itself or its own remote copy, so the
 * default branch has none and is not counted against itself.
 * `forkBases('origin/main\n', 'feature')` → `['origin/main', 'origin/master', 'main', 'master']`.
 */
export function forkBases(originHead: string, branch: string): string[] {
  const bases = new Set([originHead.trim(), 'origin/main', 'origin/master', 'main', 'master'])
  return [...bases].filter(base => base !== '' && base !== branch && base !== `origin/${branch}`)
}

/**
 * `git rev-list --left-right --count <base>...HEAD`: the commits only the base has (`behind`)
 * and those only the branch has (`ahead`). Undefined for anything but two counts.
 */
export function parseLeftRight(output: string): { behind: number; ahead: number } | undefined {
  const counts = /^(\d+)\s+(\d+)$/.exec(output.trim())
  return counts === null ? undefined : { behind: Number(counts[1]), ahead: Number(counts[2]) }
}

/** Sums `git diff --numstat` (binary files count as zero lines). */
export function parseNumstat(output: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of output.split(/\r?\n/)) {
    const [a, r] = line.split('\t')
    if (a === undefined || r === undefined) continue
    // A binary file shows "-" for both counts, which `Number` makes NaN and `|| 0` makes zero.
    added += Number(a) || 0
    removed += Number(r) || 0
  }
  return { added, removed }
}

/** The format `parseLog` reads: each commit starts a record (0x1e), its hash and subject split by 0x1f. */
export const LOG_FORMAT = '--format=%x1e%h%x1f%s'
/** The field separator `LOG_FORMAT` puts between a commit's hash and subject. */
const LOG_FIELD = '\x1f'
/** The record separator `LOG_FORMAT` starts each commit with. */
const LOG_RECORD = '\x1e'

/**
 * Parses `git log --shortstat` in `LOG_FORMAT`: one commit per record, its short hash, its
 * subject (the message's first line), and the files and lines its `--shortstat` line counts.
 * A commit without that line (a merge, or one that changed nothing) counts zero.
 */
export function parseLog(output: string): HudCommit[] {
  return output
    .split(LOG_RECORD)
    .filter(record => record.includes(LOG_FIELD))
    .map(record => {
      const [head = '', ...stat] = record.split(/\r?\n/)
      const [hash = '', subject = ''] = head.split(LOG_FIELD)
      const counts = stat.join(' ')
      return {
        hash,
        subject,
        files: countIn(counts, /(\d+) files? changed/),
        added: countIn(counts, /(\d+) insertions?\(\+\)/),
        removed: countIn(counts, /(\d+) deletions?\(-\)/),
      }
    })
}

/**
 * /context category names and the short label each gets, tried in order with the first match
 * winning, so the patterns anchored at the start of the name go before the looser ones.
 */
const PART_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^messages/i, 'msgs'],
  [/^system prompt/i, 'system'],
  [/^system tools/i, 'tools'],
  [/^mcp/i, 'mcp'],
  [/agent/i, 'agents'],
  [/memory/i, 'memory'],
  [/skill/i, 'skills'],
  [/plugin/i, 'plugins'],
  [/slash|command/i, 'commands'],
]

/**
 * A short label for a /context category name, for the Hub's context breakdown: the first
 * `PART_NAMES` match, or the name lower-cased when none matches.
 */
export function partName(name: string): string {
  return PART_NAMES.find(([pattern]) => pattern.test(name))?.[1] ?? name.toLowerCase()
}

/** `partName`'s labels in three letters, for the legend's one row. */
const PART_SHORT: Record<string, string> = {
  msgs: 'msg',
  system: 'sys',
  tools: 'tls',
  agents: 'agt',
  memory: 'mem',
  skills: 'skl',
  plugins: 'plg',
  commands: 'cmd',
  other: 'oth',
}

/**
 * A /context category name in three letters at most: `partName`'s label shortened by
 * `PART_SHORT`, or, for a label it does not know, its first three letters, spaces dropped.
 * `partShort('System tools')` → `tls`; `partShort('Something new')` → `som`.
 */
export function partShort(name: string): string {
  const label = partName(name)
  return PART_SHORT[label] ?? label.replace(/\s+/g, '').slice(0, 3)
}

/**
 * What follows each swatch on the legend's one row in `width` columns: the category in three
 * letters and its tokens (`msg 150k`), or, where those do not fit with a swatch before each
 * and a space between, the tokens alone.
 */
export function legendLabels(parts: readonly { name: string; tokens: number }[], width: number): string[] {
  const named = parts.map(p => `${partShort(p.name)} ${formatTokens(p.tokens)}`)
  const columns = named.reduce((n, label) => n + 1 + label.length, 0) + Math.max(0, parts.length - 1)
  return columns <= width ? named : parts.map(p => formatTokens(p.tokens))
}

/**
 * Where an installed plugin came from, read off its root: `…/plugins/cache/<marketplace>/<name>/<version>`
 * gives its marketplace and the plugins folder, with either slash. A root anywhere else (a
 * `--plugin-dir` checkout) gives undefined: there is no marketplace to upgrade from.
 */
export function pluginSource(root: string): { marketplace: string; pluginsDir: string } | undefined {
  const match = /^(.*[\\/]plugins)[\\/]cache[\\/]([^\\/]+)[\\/][^\\/]+[\\/][^\\/]+[\\/]?$/.exec(root)
  return match === null ? undefined : { pluginsDir: match[1]!, marketplace: match[2]! }
}

/** The version a marketplace.json's text lists for the plugin `name`, or '' when it lists none or is not one. */
export function marketplaceVersion(text: string, name: string): string {
  try {
    const { plugins } = JSON.parse(text) as { plugins?: unknown }
    if (!Array.isArray(plugins)) return ''
    const entry = plugins.find((p): p is { name: unknown; version?: unknown } => typeof p === 'object' && p !== null && (p as { name?: unknown }).name === name)
    return typeof entry?.version === 'string' ? entry.version : ''
  } catch {
    return ''
  }
}

/**
 * A plugin's version, from the plugin.json in its directory (under .claude-plugin/, or
 * beside it); '' when neither states one. The engine gives a plugin its name and
 * directory, not its version.
 */
export async function manifestVersion(root: string, read: (path: string) => Promise<string>): Promise<string> {
  for (const path of [`${root}/.claude-plugin/plugin.json`, `${root}/plugin.json`]) {
    try {
      const { version } = JSON.parse(await read(path)) as { version?: unknown }
      if (typeof version === 'string') return version
    } catch {
      // not there, or not JSON: try the other place
    }
  }
  return ''
}

/**
 * Compares release versions part by part (2.1.289 < 2.1.300); a pre-release suffix is ignored.
 * Returns a negative number when `a` is older, positive when newer, 0 when equal. A missing part
 * counts as 0 (`2.1` equals `2.1.0`), as does a part that is not a number. The Hub uses it to
 * show the Claude version in red when a newer release is out.
 */
export function compareVersions(a: string, b: string): number {
  /** The numeric parts of version `v`, with any "-suffix" dropped first. */
  const parts = (v: string) => v.split('-')[0]!.split('.').map(n => Number(n) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * The UTF-16 code units of `text`, in order: what `text.length` counts and what a string holds
 * in memory. A character outside the BMP comes out as its surrogate pair, and a lone surrogate as
 * itself, so the list is the same for every string, well-formed or not. PowerShell's
 * -EncodedCommand and `fingerprint` both work on these units rather than on code points.
 */
export function utf16Units(text: string): number[] {
  // `text[i]` is the one unit at `i` as a string of its own, so its only code point is that unit,
  // a surrogate included: it is never joined to its partner the way `text.codePointAt(i)` would.
  return Array.from({ length: text.length }, (_, i) => text[i]!.codePointAt(0)!)
}

/** FNV-1a as 8 hex characters: enough to notice text changing, not a digest. */
export function fingerprint(text: string): string {
  // FNV-1a's 32-bit offset basis and prime. It hashes UTF-16 code units, not UTF-8 bytes, so
  // values differ from other FNV-1a tools; they only ever need to match each other.
  let h = 0x811c9dc5
  for (const unit of utf16Units(text)) {
    h ^= unit
    // Math.imul keeps the multiply in 32 bits, where a plain `*` would lose precision past 2^53.
    h = Math.imul(h, 0x01000193)
  }

  // `>>> 0` reads the signed 32-bit result as unsigned, so the hex has no minus sign.
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * The last part of `path`, split on either slash so Windows and POSIX paths both work, and a
 * trailing slash ignored: `baseName('/a/b/')` → `b`. A path with no parts at all, such as `/`,
 * comes back unchanged. The Hub's workspace name.
 */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

/** Each effort level's colour, rising with its rank: grey, blue, green, amber, orange. */
const EFFORT_HEX: Record<string, string> = {
  low: '#8b949e',
  medium: '#79c0ff',
  high: '#3fb950',
  xhigh: '#d29922',
  max: '#f0883e',
}

/** The colours `ultra` cycles through, one letter each. */
const ULTRA_HEX = ['#f85149', '#f0883e', '#e3b341', '#3fb950', '#79c0ff', '#d2a8ff']

/**
 * An effort level as coloured spans, by its rank: `low` grey up to `max` orange, and `ultra`
 * in every colour, a letter each. Any other level (or none, as `default`) is one span in no
 * colour of its own. `effortSpans('high')` → `[{ text: 'high', hex: '#3fb950' }]`.
 */
export function effortSpans(effort: string): { text: string; hex?: string }[] {
  const level = effort || 'default'
  if (level === 'ultra') return [...level].map((ch, i) => ({ text: ch, hex: ULTRA_HEX[i % ULTRA_HEX.length] }))
  return [{ text: level, hex: EFFORT_HEX[level] }]
}

/** How far apart the stops on the Hub's track may be, in tokens: 1, 2 and 5 of each power of ten from 10k. */
const STOP_STEPS = [10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000]

/** The most stops the Hub's track holds between the start and compaction. */
const MAX_STOPS = 6

/**
 * The stops on the Hub's track to compaction, in tokens, the same unit as YOU ARE HERE and
 * COMPACT: one every `step`, the smallest of 10k, 20k, 50k, 100k… that keeps them to six, from
 * the first step up to short of `compactAt` (its own station). Those at or below `tokens` are
 * passed, the rest ahead (all of them with no reading), so the two always add up to the same
 * stops as the marker moves along the track.
 * `trackStops(301_000, 467_000)` → `{ passed: [100_000, 200_000, 300_000], ahead: [400_000] }`.
 */
export function trackStops(tokens: number | undefined, compactAt: number): { passed: number[]; ahead: number[] } {
  const step = STOP_STEPS.find(s => Math.ceil(compactAt / s) - 1 <= MAX_STOPS) ?? STOP_STEPS.at(-1)!
  const stops = Array.from({ length: Math.max(0, Math.ceil(compactAt / step) - 1) }, (_, i) => (i + 1) * step)
  const at = tokens ?? 0
  return { passed: stops.filter(s => s <= at), ahead: stops.filter(s => s > at) }
}

/**
 * The cell `tokens` falls on along the Hub's curled track, `span` cells from 0 at the first to
 * `end` (compaction) at the last, clamped to the track: past `end` sits on the terminus.
 * Cell 0 everywhere while `end` is unknown (0). `trackCell(100_000, 400_000, 41)` → `10`.
 */
export function trackCell(tokens: number, end: number, span: number): number {
  if (end <= 0 || span <= 1) return 0
  return Math.round(Math.min(1, Math.max(0, tokens / end)) * (span - 1))
}

/**
 * The colour of a cell of the Hub's curled track, `span` cells from 0 to compaction, by how far
 * along it the cell is: green the first 60%, the warning amber the next 30% (never the line's
 * own amber, so caution never looks like the track), red the last 10%. The marker, its reading,
 * the train's cargo and the legend take the colour of the cell the marker stands on.
 * `zoneHex(6, 11)` → `'#d29922'`.
 */
export function zoneHex(cell: number, span: number): string {
  const along = span <= 1 ? 0 : cell / (span - 1)
  if (along < 0.6) return '#3fb950'
  if (along < 0.9) return '#d29922'
  return '#f85149'
}

/**
 * The cells `from` up to (not including) `to` of the curled track, in runs of one zone's colour.
 * `zoneRuns(0, 10, 11)` → green 0–6, amber 6–9, red 9–10 (each `to` exclusive).
 */
export function zoneRuns(from: number, to: number, span: number): { from: number; to: number; hex: string }[] {
  const runs: { from: number; to: number; hex: string }[] = []
  for (let cell = from; cell < to; cell++) {
    const hex = zoneHex(cell, span)
    const last = runs.at(-1)
    if (last?.hex === hex) last.to = cell + 1
    else runs.push({ from: cell, to: cell + 1, hex })
  }
  return runs
}

/** A label on a row of the curled track: what it says, the column it starts at, and a key to style it by. */
export type RowLabel = { key: string; start: number; text: string }

/**
 * The labels that fit on a row `width` columns wide, sorted by where they start. `wants` is in
 * priority order, each its own places to try in order (all with one key); a label takes the
 * first that stays inside the row with a space clear of every label already placed, or is left
 * out. `fitRow(10, [[{ key: 'a', start: 0, text: 'abc' }], [{ key: 'b', start: 3, text: 'de' }]])`
 * leaves `b` out: it would touch `a`.
 */
export function fitRow(width: number, wants: readonly (readonly RowLabel[])[]): RowLabel[] {
  const placed: RowLabel[] = []
  const fits = (l: RowLabel) =>
    l.start >= 0 && l.start + l.text.length <= width && placed.every(p => l.start + l.text.length < p.start || p.start + p.text.length < l.start)
  for (const tries of wants) {
    const label = tries.find(fits)
    if (label !== undefined) placed.push(label)
  }
  return placed.sort((a, b) => a.start - b.start)
}

/**
 * `path` split where its own name (`baseName`) starts: the folders above it, separators
 * kept, and the name. `dirParts('/a/b/')` → `{ head: '/a/', tail: 'b' }`; a path that is only
 * a name (`~`, `/`) has an empty head. The Hub's working dir, its name drawn apart.
 */
export function dirParts(path: string): { head: string; tail: string } {
  const tail = baseName(path)
  return { head: path.slice(0, path.lastIndexOf(tail)), tail }
}

/**
 * `path` with the `home` folder at its start written as `~`, the rest as it was:
 * `tildePath('C:\\Users\\me\\x', 'C:\\Users\\me')` → `~\\x`. Either slash matches either, and a
 * Windows home (one with a drive letter) matches in any case, as Windows does; a POSIX one is
 * case-sensitive. A folder that only starts with the home's name (`/home/meg` for `/home/me`),
 * one elsewhere, or an empty home leaves `path` unchanged. The Hub's workspace path.
 */
export function tildePath(path: string, home: string): string {
  // The trailing slashes go from where their run starts, as `homeDir` trims them.
  const root = home.replace(/(?<![\\/])[\\/]+$/, '')
  if (root === '') return path
  const isWindows = /^[A-Za-z]:/.test(root)
  const same = (s: string) => (isWindows ? s.replaceAll('\\', '/').toLowerCase() : s.replaceAll('\\', '/'))
  const rest = path.slice(root.length)
  if (same(path.slice(0, root.length)) !== same(root) || (rest !== '' && !/^[\\/]/.test(rest))) return path
  return `~${rest}`
}
