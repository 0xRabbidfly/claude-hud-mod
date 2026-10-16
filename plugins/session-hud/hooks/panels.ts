/**
 * The pure logic behind the HUD's tabs, and the Raster drawings they show. Nothing here
 * reads a file, touches state or renders; `register.tsx` feeds it events and draws what it returns.
 *
 * Cache: pricing each turn's input (`cacheHit`, `cacheTotals`: read ×0.1, write ×2, fresh ×1 of
 * the plain input rate), how long the cache has left (`cacheWarmth`), and fingerprinting what
 * sits above the cache boundary (`prefixOf`, `prefixChange`) so a rebuild can be announced
 * before the request goes out.
 *
 * Flight: labels, colours and times for the tool calls of a reply (`callLabel`, `toolColor`,
 * `shortTool`, `formatSeconds`).
 *
 * Drawings: `iceCells` returns the base64 cell buffer a `<Raster>` takes; `pack` documents the
 * layout.
 */
import type {
  HudCacheTurn,
  HudCall,
  HudFile,
  HudListedSkill,
  HudPrefixParts,
  HudSkillFire,
  HudSkills,
  HudTouched,
  HudTree,
} from '../types'
import { base64, fingerprint, formatMb, formatSpan, formatTokens } from './lib'

/** A Raster colour word with bit 24 set: the terminal's own foreground or background, not an RGB. */
const DEFAULT_COLOR = 0x01000000

/** Urgent: red. */
export const FAIL_HEX = '#f85149'
/** Nothing to say: grey. */
export const IDLE_HEX = '#6e7681'
/** Worth a look: amber. */
export const AMBER_HEX = '#d29922'

// ---------------------------------------------------------------- cache

/** How long a prompt-cache entry lives after the turn that last used it: one hour, in ms. */
export const CACHE_TTL_MS = 60 * 60_000

// What each kind of input token costs, as a multiple of the model's plain input rate. The
// ratios are Anthropic's list pricing and are the same on every Claude model, so the HUD can
// price a session without knowing which model it is. The write rate is the 1-hour one, to
// match CACHE_TTL_MS; a 5-minute cache writes at 1.25x instead.
export const CACHE_READ_RATE = 0.1
/** A cache write costs twice a plain input token (the 1-hour rate; see `CACHE_READ_RATE`). */
export const CACHE_WRITE_RATE = 2

/**
 * One request's input split three ways from the API's `usage`: `read` (served from the cache),
 * `write` (put into it), `fresh` (neither), their `total`, and `hit`, the read share of the total
 * from 0 to 1 (0 when there was no input at all). `input_tokens` counts only the fresh part.
 */
export function cacheHit(usage: {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): { hit: number; total: number; read: number; write: number; fresh: number } {
  // A usage that leaves a field out counts it as none, rather than turning every figure into NaN.
  const read = usage.cache_read_input_tokens || 0
  const write = usage.cache_creation_input_tokens || 0
  const fresh = usage.input_tokens || 0
  const total = fresh + read + write
  return { hit: total === 0 ? 0 : read / total, total, read, write, fresh }
}

/**
 * What the session's input came to, and what it would have come to with no cache, both in
 * units of one plain input token. `billed` under `uncached` is the cache paying for itself;
 * over it is the write premium, which the reads that follow earn back. `ratio` is `billed` over
 * `uncached` (0.17 means the cache took 83% off), and 1 when there are no tokens yet.
 */
export function cacheTotals(turns: readonly HudCacheTurn[]): {
  read: number
  write: number
  fresh: number
  billed: number
  uncached: number
  ratio: number
} {
  let read = 0
  let write = 0
  let fresh = 0
  for (const turn of turns) {
    read += turn.read
    write += turn.write
    fresh += turn.fresh
  }
  // read ×0.1 + write ×2 + fresh ×1, against every token at ×1 as if there were no cache.
  const billed = read * CACHE_READ_RATE + write * CACHE_WRITE_RATE + fresh
  const uncached = read + write + fresh
  return { read, write, fresh, billed, uncached, ratio: uncached === 0 ? 1 : billed / uncached }
}

/**
 * How much of the cache's lifetime is left, 0 to 1, from the last turn.
 * Each turn restarts the clock, so it falls in a straight line from 1 at the last turn's end to
 * 0 one `ttlMs` later: 20 minutes into a 60-minute TTL is 0.67. No turns yet is 0 (nothing is
 * cached). `now` and the turns' `at` are epoch ms.
 */
export function cacheWarmth(turns: readonly HudCacheTurn[], now: number, ttlMs = CACHE_TTL_MS): number {
  const last = turns.at(-1)
  if (last === undefined) return 0
  // Clamped at both ends: a clock that runs backwards still reads full, a long gap reads cold.
  return Math.max(0, Math.min(1, 1 - (now - last.at) / ttlMs))
}

// ------------------------------------------------------- what breaks the cache

/**
 * Orders strings by UTF-16 code units, the order `sort()` uses by default, said out loud. Not
 * `localeCompare`: a fingerprint must not change with the machine's locale, nor with an upgrade
 * (a fingerprint saved before one is compared with the next).
 */
function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : Number(a > b)
}

/**
 * Everything the request sends above the prompt cache's boundary, fingerprinted. The
 * conversation beneath it only ever grows, so it cannot break the cache; these three can,
 * and when one of them changes the whole prefix is written again at the write rate instead
 * of read at a tenth. `prompt.compose` hands all three over before the request goes out.
 */
export function prefixOf(
  model: string,
  tools: readonly string[],
  sections: readonly { id: string; text: string }[],
): HudPrefixParts {
  return {
    model,
    // Sorted, so the same roster in another order is the same fingerprint.
    tools: fingerprint([...tools].sort(byCodeUnits).join('\n')),
    // NUL between a section's id and text and U+0001 between sections, characters a prompt does
    // not contain, so renaming a section or moving text across a boundary changes the fingerprint.
    prompt: fingerprint(sections.map(s => `${s.id}\u0000${s.text}`).join('\u0001')),
  }
}

/**
 * What changed above the boundary, in a few words; undefined when nothing did.
 * `the tool list changed`; with all three, `the model, the tool list and the system prompt changed`.
 */
export function prefixChange(before: HudPrefixParts, after: HudPrefixParts): string | undefined {
  const changed: string[] = []
  if (before.model !== after.model) changed.push('the model')
  if (before.tools !== after.tools) changed.push('the tool list')
  if (before.prompt !== after.prompt) changed.push('the system prompt')
  if (changed.length === 0) return undefined
  const last = changed.pop()!
  // The parts before the last, joined by commas and an `and`; nothing when only one changed.
  const others = changed.length === 0 ? '' : `${changed.join(', ')} and `

  return `${others}${last} changed`
}

// ---------------------------------------------------------------- session registry

/** What the HUD reads from this session's registry entry: its name, and its Remote Control id. */
export type SessionEntry = {
  /** The session's name, '' when it has none. */
  name: string
  /** The Remote Control session id (`session_...`) while Remote Control is on, '' when it is off. */
  remote: string
}

/**
 * The name and Remote Control id in one `~/.claude/sessions/<pid>.json`, when that file is this
 * session's. The engine writes `bridgeSessionId` there while Remote Control (`/rc`) is connected.
 * Undefined for any other session's entry, or for anything that does not parse.
 */
export function sessionEntryIn(text: string, id: string): SessionEntry | undefined {
  try {
    const row = JSON.parse(text) as { sessionId?: unknown; name?: unknown; bridgeSessionId?: unknown }
    if (row.sessionId !== id) return undefined

    return {
      name: typeof row.name === 'string' ? row.name : '',
      remote: typeof row.bridgeSessionId === 'string' ? row.bridgeSessionId : '',
    }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- flight

/**
 * A colour (0xRRGGBB) per family of tool, first match wins: shell orange, edits green, reads
 * blue, agents and skills purple, web cyan, MCP pink. Named tools match whole, so a `ReadFoo` is
 * not `Read`; `Web` and `mcp__` match as prefixes (`WebFetch`, `WebSearch`, any MCP tool).
 */
const TOOL_COLORS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(Bash|PowerShell)$/, 0xf0883e],
  [/^(Edit|Write|NotebookEdit)$/, 0x3fb950],
  [/^(Read|Grep|Glob)$/, 0x58a6ff],
  [/^(Agent|Task|Skill)$/, 0xbc8cff],
  [/^Web/, 0x39c5cf],
  [/^mcp__/, 0xf778ba],
]

/** A tool's bar colour in Flight, as 0xRRGGBB; grey for a tool in no family. */
export function toolColor(tool: string): number {
  return TOOL_COLORS.find(([pattern]) => pattern.test(tool))?.[1] ?? 0x8b949e
}

/** A leading `cd <dir>;` or `cd <dir> &&`, the dir bare or quoted: where a command runs, not what it does. */
const LEADING_CD = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&]+)\s*(?:;|&&)\s*/

/**
 * A few words that say what a call did: its description, command, file or pattern. The first
 * non-blank field in that order of preference, first line only; a command loses any leading
 * `cd <dir>;` or `cd <dir> &&` (unless that is all it is), and a file path is cut to its name
 * (`C:\src\app.ts` → `app.ts`). `''` when the input has none of them.
 */
export function callLabel(input: Record<string, unknown>): string {
  for (const field of ['description', 'command', 'file_path', 'pattern', 'url', 'query', 'prompt']) {
    const value = input[field]
    if (typeof value === 'string' && value.trim() !== '') {
      const text = value.trim().split(/\r?\n/)[0]!
      if (field === 'file_path') return text.split(/[\\/]/).pop()!
      if (field !== 'command') return text
      let command = text
      for (let next = command.replace(LEADING_CD, ''); next !== command && next !== ''; next = command.replace(LEADING_CD, '')) {
        command = next
      }
      return command
    }
  }
  return ''
}

/** Each file `git diff HEAD --numstat` lists, by its path as git writes it, with its lines (a binary file counts none). */
export function numstatFiles(output: string): Record<string, { added: number; removed: number }> {
  const files: Record<string, { added: number; removed: number }> = {}
  for (const line of output.split(/\r?\n/)) {
    const [a, r, path] = line.split('\t')
    if (path === undefined || path === '') continue
    files[path] = { added: Number(a) || 0, removed: Number(r) || 0 }
  }
  return files
}

/**
 * The working tree at one git reading: the uncommitted lines of each file against HEAD (from
 * `numstat`), and each untracked file `git status` lists (`files` with code `?`), which has no
 * lines yet and is marked new.
 */
export function treeOf(head: string, numstat: string, files: readonly HudFile[]): HudTree {
  const tree: HudTree = { head, files: numstatFiles(numstat) }
  for (const f of files) {
    if (f.code === '?' && tree.files[f.path] === undefined) tree.files[f.path] = { added: 0, removed: 0, isNew: true }
  }
  return tree
}

/** A file absent from a reading: no uncommitted lines. */
const UNCHANGED = { added: 0, removed: 0 }

/**
 * `touched` with what changed from the reading `before` to `after`, file by file: lines added
 * since, and lines removed since; a line added earlier and now gone counts as removed, and one
 * removed earlier and now back as added. A file that comes into or leaves the diff counts though
 * its lines did not move (an untracked file written or deleted). Nothing is added without a
 * `before`, or across a commit (HEAD moved), when the diff shrinks by what was committed, not by
 * what anyone edited. Files keep the order they were first touched in.
 */
export function touchFiles(touched: readonly HudTouched[], before: HudTree | undefined, after: HudTree): HudTouched[] {
  if (before === undefined || before.head !== after.head) return [...touched]
  let next = [...touched]
  for (const path of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    const was = before.files[path] ?? UNCHANGED
    const now = after.files[path] ?? UNCHANGED
    const da = now.added - was.added
    const dr = now.removed - was.removed
    const isMoved = (before.files[path] === undefined) !== (after.files[path] === undefined)
    if (da === 0 && dr === 0 && !isMoved) continue
    const prior = next.find(t => t.path === path)
    const entry: HudTouched = {
      path,
      added: (prior?.added ?? 0) + Math.max(0, da) + Math.max(0, -dr),
      removed: (prior?.removed ?? 0) + Math.max(0, dr) + Math.max(0, -da),
      ...(after.files[path]?.isNew === true && { isNew: true }),
    }
    next = prior === undefined ? [...next, entry] : next.map(t => (t === prior ? entry : t))
  }
  return next
}

/** `text` cut from its start to `columns`, an ellipsis standing for what went: the end of a path is the part that names it. */
export function fitStart(text: string, columns: number): string {
  return text.length <= columns ? text : `…${text.slice(text.length - columns + 1)}`
}

/** How long a call may run and still arrive on time on the departures board. */
const DELAYED_AFTER_MS = 10_000

/** A call's line on the Turn tab's departures board. */
export type Departure = 'BOARDING' | 'ARRIVED' | 'DELAYED' | 'CANCELLED'

/**
 * A call as the departures board shows it: boarding while it runs, cancelled when it failed,
 * delayed when it took `DELAYED_AFTER_MS` or more, else arrived.
 */
export function departureStatus(call: HudCall): Departure {
  if (call.end === undefined) return 'BOARDING'
  if (call.isError) return 'CANCELLED'
  return call.end - call.start >= DELAYED_AFTER_MS ? 'DELAYED' : 'ARRIVED'
}

/** A tool's name without its MCP server: `mcp__github__create_issue` → `create_issue`; others unchanged. */
export function shortTool(tool: string): string {
  return tool.startsWith('mcp__') ? (tool.split('__')[2] ?? tool) : tool
}

/**
 * A duration in ms as `4.2s` under ten seconds, `42s` under a minute, `3m 07s` above.
 * Each unit is picked by the value as rounded, so 59.6s reads 1m 00s and 9.96s reads 10s, never 60s or 10.0s.
 */
export function formatSeconds(ms: number): string {
  const tenths = Math.round(ms / 100)
  if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// ---------------------------------------------------------------- skills

/** How many days a listed skill may go unfired before the Skills tab calls it quiet. */
export const QUIET_DAYS = 30

const DAY_MS = 24 * 60 * 60_000

/** The most fires the Skills tab's chain keeps. */
const MAX_CHAIN = 8

/** A skill's name as a row shows it: a plugin's skill without its `plugin:` prefix. */
export function skillShortName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1)
}

/** A rough token count for text a skill brought into the context: four characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * The Skills tab's record after one more fire of `name` at `at` (epoch ms), its prompt `tokens`
 * long, by `by`: its count and tokens added up, who fired it (`both` once you and Claude each
 * have), the chain extended unless it repeats the last fire, and the skill seen now. Recording
 * starts the record's `since` when it has none.
 */
export function recordSkill(skills: HudSkills, name: string, tokens: number, by: 'you' | 'claude', at: number): HudSkills {
  const prior = skills.fired.find(f => f.name === name)
  const fire: HudSkillFire =
    prior === undefined
      ? { name, count: 1, tokens, by, at }
      : { name, count: prior.count + 1, tokens: prior.tokens + tokens, by: prior.by === by ? by : 'both', at }
  const fired = prior === undefined ? [...skills.fired, fire] : skills.fired.map(f => (f.name === name ? fire : f))
  const chain = skills.chain.at(-1) === name ? skills.chain : [...skills.chain, name].slice(-MAX_CHAIN)
  return { fired, chain, seen: { ...skills.seen, [name]: at }, since: skills.since || at }
}

/**
 * Adds `tokens` to the fire of `name` already recorded, matched in full or by its short name:
 * for a prompt whose fire was counted first from the Skill call or the typed command, which
 * do not carry the prompt. With no such fire, `skills` comes back as it was.
 */
export function addSkillTokens(skills: HudSkills, name: string, tokens: number): HudSkills {
  const short = skillShortName(name)
  const prior = skills.fired.find(f => f.name === name || skillShortName(f.name) === short)
  if (prior === undefined) return skills
  return { ...skills, fired: skills.fired.map(f => (f === prior ? { ...f, tokens: f.tokens + tokens } : f)) }
}

/** The engine's words for where a skill came from, as the Skills tab names a group. */
const SOURCE_NAMES: Record<string, string> = {
  userSettings: 'user',
  projectSettings: 'project',
  localSettings: 'local',
  policySettings: 'policy',
  syncedSkills: 'synced',
}

/**
 * Who pays for the skill listing: the listed skills grouped by the plugin that provides them,
 * or where they came from when no plugin does, with how many each group lists and their tokens,
 * most tokens first (ties by name).
 */
export function skillGroups(list: readonly HudListedSkill[]): { name: string; count: number; tokens: number }[] {
  const groups = new Map<string, { name: string; count: number; tokens: number }>()
  for (const skill of list) {
    const name = skill.plugin ?? SOURCE_NAMES[skill.source] ?? skill.source
    const group = groups.get(name) ?? { name, count: 0, tokens: 0 }
    group.count++
    group.tokens += skill.tokens
    groups.set(name, group)
  }
  return [...groups.values()].sort((a, b) => b.tokens - a.tokens || (a.name < b.name ? -1 : 1))
}

/**
 * The listed skills that have not fired in `QUIET_DAYS` (or since the record began, when it
 * is younger), in listing order: what the listing pays for every turn and gets nothing back.
 */
export function quietSkills(list: readonly HudListedSkill[], skills: HudSkills, now: number): string[] {
  const cutoff = now - QUIET_DAYS * DAY_MS
  return list.map(s => s.name).filter(name => (skills.seen[name] ?? 0) < cutoff)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * How long the quiet list looks back: `QUIET_DAYS` once the record is that old, else since it
 * began (`Oct 10`, in UTC). A record not yet begun (`since` 0) begins now.
 */
export function quietSpan(since: number, now: number): string {
  const start = since || now
  if (start <= now - QUIET_DAYS * DAY_MS) return `in ${QUIET_DAYS} days`
  const d = new Date(start)
  return `since ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

// ---------------------------------------------------------------- drawings

/**
 * Packs a `columns` × `rows` grid into the base64 cell buffer a `<Raster>` takes. Each cell is
 * three uint32 words, row by row then column by column: the glyph's code point, the foreground
 * as 0xRRGGBB and the background as 0xRRGGBB, either colour `DEFAULT_COLOR` for the terminal's
 * own. `paint` returns a cell's three words, or null for a blank (a space in default colours).
 * The words go out in the platform's byte order, little-endian on every machine this runs on,
 * which is the order Raster reads.
 */
function pack(columns: number, rows: number, paint: (col: number, row: number) => readonly [number, number, number] | null): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      words.set(paint(col, row) ?? [0x20, DEFAULT_COLOR, DEFAULT_COLOR], (row * columns + col) * 3)
    }
  }
  return base64(new Uint8Array(words.buffer))
}

/** The ice cube's width in cells, and in pixels: one pixel per column. */
export const ICE_COLUMNS = 10
/** The ice cube's height in cells; each cell is two pixels tall, so the picture is 10 × 10. */
export const ICE_ROWS = 5

/** The puddle's colour (0xRRGGBB): blue while any cache is left, grey once it has all melted at 0. */
function puddleColor(warmth: number): number {
  return warmth === 0 ? 0x6e7681 : 0x388bfd
}

/**
 * An ice cube that melts into its puddle as the cache's lifetime runs out.
 * `warmth` is `cacheWarmth`'s 0..1. At 1 the cube is seven pixels tall over a two-pixel puddle;
 * as it falls the cube shrinks from the top and the puddle widens to the full ten pixels; at
 * exactly 0 the cube is gone and the puddle turns grey. The picture is drawn in pixels half a
 * cell tall and packed two to a cell with half blocks.
 */
export function iceCells(warmth: number): string {
  // In pixels: y runs 0 (top) to `height - 1`, the puddle row; x runs 0 to 9.
  const height = ICE_ROWS * 2
  // The last empty pixel row above the cube: 1 at full warmth (cube on y 2..8, seven rows), 8
  // when cold (no cube rows left). The cube is the `height - 2 - cubeTop` rows below it.
  const cubeTop = height - 2 - Math.round(warmth * 7) // 1..8, so 7..0 pixel rows of cube
  // How far the puddle reaches beyond its centre pair (x 4..5) on each side: 0 when warm, 4 when cold.
  const spread = Math.round((1 - warmth) * 4)
  /** The colour (0xRRGGBB) of the pixel at `x`, `y`, or null where the picture is empty. */
  const pixel = (x: number, y: number): number | null => {
    if (y === height - 1) {
      return x >= 4 - spread && x <= 5 + spread ? puddleColor(warmth) : null
    }
    // The cube spans x 1..8, between `cubeTop` and the puddle row, both exclusive.
    if (warmth === 0 || x < 1 || x > 8 || y <= cubeTop || y >= height - 1) return null
    if (y === cubeTop + 1 && x <= 2) return 0xe6f6ff // highlight
    if (x === 8) return 0x388bfd // shaded side
    return 0x79c0ff
  }
  return pack(ICE_COLUMNS, ICE_ROWS, (col, row) => {
    // A cell holds pixel rows `2 * row` (top) and `2 * row + 1` (bottom).
    const top = pixel(col, row * 2)
    const bottom = pixel(col, row * 2 + 1)
    if (top === null && bottom === null) return null
    // Only the bottom pixel: U+2584 lower half block in its colour over the default background.
    if (top === null) return [0x2584, bottom!, DEFAULT_COLOR]
    // U+2580 upper half block: the top pixel as foreground, the bottom one (or nothing) as background.
    return [0x2580, top, bottom ?? DEFAULT_COLOR]
  })
}

// ------------------------------------------------------- the dispatcher

/** What a dispatch's button does: open Prep compact, show the Procs tab, or open what is new. */
export type DispatchAction = 'prep' | 'procs' | 'read'

/** One announcement on the Hub's band: its words, their colour, and the button that acts on it, if any. */
export type Dispatch = { key: string; text: string; hex: string; action?: DispatchAction }

/** What the dispatcher weighs, gathered by the Hub. */
export type DispatchInput = {
  /** When the 5-hour window runs out at the recent pace, and when it resets, in ms from now; undefined when it will not. */
  limit?: { ms: number; resetsInMs?: number }
  /** How long the cache stays warm, in ms, and the prefix it would re-cache, in tokens; undefined while cold or a reply keeps it warm. */
  cache?: { leftMs: number; tokens: number }
  /** The compaction advice, as `adviceFor` gives it. */
  advice?: { text: string; color: string }
  uncommitted: { files: number; lines: number }
  stale: { count: number; memMb: number }
  /** A newer Claude Code out on this channel, or ''. */
  update: string
}

/** How soon the 5-hour window running out turns red. */
const LIMIT_SOON_MS = 60 * 60_000

/** How little warm time left makes the cache worth a word: its last quarter. */
const CACHE_WARN_MS = CACHE_TTL_MS / 4

/** Uncommitted work worth a word: this many changed lines, or this many files. */
const UNCOMMITTED_LINES = 300
const UNCOMMITTED_FILES = 15

/**
 * What the Hub's band says, most urgent first, each short enough for a sidebar: the 5-hour
 * window running out within the hour, compaction overdue, the cache in its last
 * quarter (with the tokens a cold one re-caches), compaction advised, the window running out
 * later, a lot of work uncommitted, stale processes, a newer Claude Code. With none of them,
 * one dispatch saying all is clear, with the cache's time left (the 5-hour pace is ARIA's).
 */
export function dispatches(d: DispatchInput): Dispatch[] {
  const limit: Dispatch | undefined =
    d.limit === undefined
      ? undefined
      : {
          key: 'limit',
          text: `5h limit in ~${formatSpan(d.limit.ms)}${d.limit.resetsInMs === undefined ? '' : ` · resets ${formatSpan(d.limit.resetsInMs)}`}`,
          hex: d.limit.ms <= LIMIT_SOON_MS ? FAIL_HEX : AMBER_HEX,
        }
  const isSoon = limit?.hex === FAIL_HEX
  const advice: Dispatch | undefined = d.advice === undefined ? undefined : { key: 'compact', text: d.advice.text, hex: d.advice.color, action: 'prep' }
  const isOverdue = advice?.hex === FAIL_HEX
  const { files, lines } = d.uncommitted
  const ranked = [
    isSoon ? limit : undefined,
    isOverdue ? advice : undefined,
    d.cache !== undefined && d.cache.leftMs <= CACHE_WARN_MS
      ? { key: 'cache', text: `❄ cold in ${formatSpan(d.cache.leftMs)} · re-cache ${formatTokens(d.cache.tokens)}`, hex: AMBER_HEX }
      : undefined,
    isOverdue ? undefined : advice,
    isSoon ? undefined : limit,
    lines >= UNCOMMITTED_LINES || files >= UNCOMMITTED_FILES
      ? { key: 'uncommitted', text: `${lines} lines uncommitted · ${files} file${files === 1 ? '' : 's'}`, hex: AMBER_HEX }
      : undefined,
    d.stale.count > 0
      ? { key: 'stale', text: `${d.stale.count} stale proc${d.stale.count === 1 ? '' : 's'} · ${formatMb(d.stale.memMb)}`, hex: AMBER_HEX, action: 'procs' as const }
      : undefined,
    d.update !== '' ? { key: 'update', text: `${d.update} out`, hex: '#d2a8ff', action: 'read' as const } : undefined,
  ].filter((x): x is Dispatch => x !== undefined)
  if (ranked.length > 0) return ranked
  return [{ key: 'clear', text: d.cache === undefined ? '✓ All clear' : `✓ All clear · ❄ ${formatSpan(d.cache.leftMs)}`, hex: IDLE_HEX }]
}
