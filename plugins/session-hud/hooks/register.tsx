/**
 * The session-hud hooks module: `register(on)` wires Claude Code's engine events to the HUD's
 * state and draws everything the HUD shows. The helper modules (lib, aria, compact, panels,
 * procs) are pure or nearly so; this file is where events, timers, processes, files and the
 * screen meet.
 *
 * Architecture is event → state → render. Hooks and timers learn something, write it into a
 * `$.state` atom with `update`, and the engine redraws whatever read that atom: the sidebar Pane
 * (tabs Hub, Turn, Procs, Commits, Skills), the "Prep compact" dialog Pane, and the one-line
 * AbovePrompt band that stands in for the sidebar while it is not on screen. Render hooks only
 * read atoms; they never fetch. Every hook passes the event on with `next(e)`, so the engine's
 * own behaviour is never replaced, only observed (or, for session.compact, given extra
 * instructions). The exceptions answer for what is the HUD's own: the `/hud` command and the
 * render hooks of the HUD's two Panes, which nothing beneath could draw.
 *
 * The atoms and who writes them:
 * - `gitAtom`: branch, changed files and line counts; `readGit`, behind `refreshGit`.
 * - `usageAtom`: context tokens, window, rate limits, cost and the category breakdown;
 *   session.start and session.measure.
 * - `metaAtom`: cwd, id, name, model, effort, version, the HUD's own version, latest release,
 *   turns, the wall-clock minute; session.start, `tick`, turn.step, `checkRelease`, `readGit`
 *   (committedAt).
 * - `historyAtom`: usage samples for ARIA's runway and pace forecasts; `recordSample`.
 * - `tabAtom`: the sidebar's current tab; the tab buttons and `/hud <tab>`.
 * - `draftAtom`: the Prep compact keep-list and its status; `startDraft`, `runCompact`, the dialog.
 * - `cacheAtom`: per-reply prompt-cache read/write/fresh split; `endFlight` on turn.complete.
 * - `prefixAtom`: the cached prefix's parts and the last reason it changed; `notePrefix` on
 *   prompt.compose, cleared of its pending flag on turn.complete.
 * - `flightAtom` and `nowAtom`: the current reply's tool calls and a 1 s clock while it runs;
 *   `startFlight`, `flightCall`, `endFlight`, `bumpNow`.
 * - `paneEpochAtom`: bumped on every sidebar open or close, so the band redraws and re-asks
 *   whether the sidebar is showing.
 * - `commitsAtom`: the branch's last ten commits for the Commits tab; `readCommits`, run when the
 *   tab is chosen and, while it shows, by `readGit` once the last commit moves.
 * - `skillsAtom`: the skills fired this session, their chain, and when each last fired in any
 *   session (from `$.store`); `noteSkill` on skill.prompt, `loadSkillsSeen` on session.start.
 * - `procsAtom` and `confirmAtom`: the claude/node process list and the pid awaiting an "End"
 *   confirmation (-1 for "End all stale"); `scanProcs`, `endProcesses`, the Procs buttons.
 *
 * Timers, all started on session.start (`$.clock.every`): `tick` every 15 s (meta, session name,
 * the /clear-and-resume reset), `gitTick` every 30 s (only while the sidebar
 * shows Hub or Commits), `blink` every 5.2 s (ARIA's eyes), `checkRelease` every 6 h, `procsTick`
 * every 30 s (scans every 30 s on the Procs tab, every 5 min otherwise), and a 1 s `bumpNow` only
 * while a reply runs. Everything else is event-driven: git refreshes after a file-changing tool,
 * after each reply and when the sidebar opens; usage on session.measure; cache and flight on
 * turn and tool events. Only the git index/HEAD stat, the release check and the process scan are
 * polled.
 *
 * Files: reads `~/.claude/sessions/<pid>.json` (the engine's session registry, for the name),
 * the HUD's own plugin.json once at session start (its version, for the Hub's rule),
 * git's `.git/index` and `.git/HEAD` (stat only); reads and writes
 * `~/.claude/session-hud/procs-scan.json` (the machine-wide process scan shared between sessions,
 * command lines tidied by `toCache`) and writes keep-list files under
 * `~/.claude/session-hud/keep/`. The newest release and when each skill last fired are kept in the
 * plugin's `$.store`, shared by every session.
 *
 * Hot reload: module-level `let`s (in-flight scan, git busy flags, the ending flag, session-name
 * path, the flight timer, re-check flags, own pids, the git signature) reset to their initial
 * values on every reload, so each is written to tolerate starting empty, and the engine cancels
 * the old module's pending timers; atoms in `$.state` and the release check in `$.store`
 * survive. A reload runs `register` again and fires session.start again, which starts the timers
 * anew and clears the ending flag; only the 1 s Flight clock waits, since it starts on
 * turn.start, for the next reply. A session.end that ends the process (not a /clear or a
 * resume) sets the ending flag, after which no git refresh starts.
 *
 * Ending processes: nothing is signalled without a fresh scan that still shows the same pid
 * (same start time) as endable, nor any pid that is not a whole number above 1; "End all stale"
 * also needs each one still stale in that scan. The shared scan file is checked field by field
 * before use, since any session (or a hand edit) may have written it.
 */
import { atom, read, update } from 'claude-code'
import type {
  Elements,
  EngineInterface,
  Register,
  RenderElement,
  RenderSurface,
  SessionContextUsage,
  SessionCost,
  SessionRateLimit,
} from 'claude-code'

import type {
  HudCacheTurn,
  HudCommits,
  HudDraft,
  HudCall,
  HudFlight,
  HudFork,
  HudGit,
  HudMeta,
  HudPrefix,
  HudPrefixParts,
  HudProc,
  HudProcs,
  HudReleaseNotes,
  HudSample,
  HudSkills,
  HudTab,
  HudTouched,
  HudTree,
  HudUsage,
} from '../types'
import {
  ARIA_COLUMNS,
  ARIA_ROWS,
  COMPACT_TARGET,
  MOOD_HEX,
  ariaCells,
  limitForecast,
  forecastLine,
  moodLine,
  moodOf,
  trendCells,
  turnsToCompact,
} from './aria'
import type { LimitForecast, Mood } from './aria'
import { CHANGELOG_URL, changelogSections, parseReleasePicks, releaseNotesPrompt, releaseRange } from './release'
import {
  LOG_FORMAT,
  PART_PATTERNS,
  bar,
  compareVersions,
  dirParts,
  fitRow,
  effortSpans,
  forkBases,
  formatMb,
  formatSpan,
  formatTokens,
  hex,
  legendParts,
  limitColor,
  limitName,
  manifestVersion,
  parseLog,
  parseLeftRight,
  parseNumstat,
  parseStatus,
  marketplaceVersion,
  pluginSource,
  legendLabels,
  tildePath,
  trainCars,
  CAR_CARGO,
  trackCell,
  trackStops,
  zoneHex,
  zoneRuns,
} from './lib'
import type { RowLabel } from './lib'
import {
  CACHE_TTL_MS,
  CACHE_WRITE_RATE,
  ICE_COLUMNS,
  ICE_ROWS,
  addSkillTokens,
  callLabel,
  cacheHit,
  cacheTotals,
  cacheWarmth,
  departureStatus,
  estimateTokens,
  fitStart,
  formatSeconds,
  iceCells,
  prefixChange,
  prefixOf,
  quietSkills,
  quietSpan,
  recordSkill,
  sessionEntryIn,
  shortTool,
  skillGroups,
  skillShortName,
  toolColor,
  touchFiles,
  treeOf,
  dispatches,
} from './panels'
import type { Departure, DispatchAction, DispatchInput, SessionEntry } from './panels'
import {
  adviceFor,
  compactInstructions,
  compactPoint,
  configuredCompactWindow,
  draftPrompt,
  isBreakpoint,
  keepListFile,
  keepListInstructions,
  parseKeepList,
  recheckNote,
  zoneOf,
} from './compact'
import type { Zone } from './compact'
import type { CachedScan, Scan } from './procs'
import {
  PS_SCAN,
  WINDOWS_SCAN,
  buildProcs,
  endScript,
  fromCache,
  selfOf,
  toCache,
  encodePowerShell,
  canEnd,
  isIdle,
  isStale,
  memoryCells,
  parsePsScan,
  parseWindowsScan,
  procHex,
} from './procs'

/** The sidebar's pane id: the `requestId` its render hook matches and the id `ui.open` and `ui.panes` use. */
const PANE = 'session-hud'
/** The sidebar's title as the engine shows it. */
const TITLE = 'Session'
// Git is refreshed by events (a file-changing tool, a reply ending, the sidebar opening);
// this timer only catches outside commits, by statting git's own files (no process).
const GIT_EVERY_MS = 30_000
/** How often `tick` refreshes meta (model, cwd, turns, the minute) and the name. */
const META_EVERY_MS = 15_000
/** Tools after which git is re-read: the edit tools and the shells, which may change any file. */
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'])

/** Git's reading outside a repository, or when `git status` fails: the Hub then says "Not a git repository". */
const EMPTY_GIT: HudGit = {
  isRepo: false,
  branch: '',
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
  linesAdded: 0,
  linesRemoved: 0,
  lastCommit: '',
}

/** The working tree as `git status` last saw it; written only through `setGit`, which skips no-op writes. */
const gitAtom = atom({ plugin: 'session-hud', key: 'git' } as const, EMPTY_GIT)
/**
 * The latest context and rate-limit reading plus the category breakdown and auto-compact
 * threshold; written through `setUsage` on session.start and every session.measure.
 */
const usageAtom = atom({ plugin: 'session-hud', key: 'usage' } as const, { window: 0, limits: [] })
/**
 * Facts about the session that change slowly: folder, id, name, model, effort, installed and
 * newest version, last commit time, start time, prompt count, and `minute` (wall-clock minutes
 * since the epoch, which the Pane uses as its "now" so it redraws at most once a minute when idle).
 * Written through `patchMeta`.
 */
const metaAtom = atom({ plugin: 'session-hud', key: 'meta' } as const, {
  cwd: '',
  home: '',
  id: '',
  name: '',
  remote: '',
  model: '',
  effort: '',
  version: '',
  hudVersion: '',
  latest: '',
  committedAt: 0,
  startedAt: 0,
  turns: 0,
  minute: 0,
})

/** The last `MAX_SAMPLES` usage samples (context percent, five-hour percent), for ARIA's forecasts and trend bars. */
const historyAtom = atom({ plugin: 'session-hud', key: 'history' } as const, [])

/** The sidebar tab on screen; it survives reloads, so the sidebar reopens where it was left. */
const tabAtom = atom({ plugin: 'session-hud', key: 'tab' } as const, 'hub')
/**
 * The Prep compact dialog's state: idle, drafting, ready, compacting or error, the drafted
 * items with their ticks, and the person's steer. Lives in `$.state`, so a reload mid-draft
 * keeps it (which is why a failed fork must still leave "drafting").
 */
const draftAtom = atom({ plugin: 'session-hud', key: 'compactDraft' } as const, { status: 'idle', items: [] })

/** The Prep compact dialog's pane id, distinct from the sidebar's so each has its own render hook. */
const DRAFT_PANE = 'hud-compact'
/** One entry per main-conversation reply: when it ended and its input's cache read/write/fresh split. */
const cacheAtom = atom({ plugin: 'session-hud', key: 'cache' } as const, [])
/**
 * The cached prefix (model, tools, system sections) the last request sent, the last reason it
 * changed and when, and `isPending` while the re-cache that change forces has not been paid yet.
 */
const prefixAtom = atom({ plugin: 'session-hud', key: 'prefix' } as const, { reason: '', at: 0, isPending: false })
// Below this there is nothing worth warning about: re-caching a small prompt is cheap.
const BREAK_WARN_TOKENS = 100_000
/** The current or last main-conversation reply: its turn id, start, end once done, and its tool calls. */
const flightAtom = atom({ plugin: 'session-hud', key: 'flight' } as const, { turnId: '', startedAt: 0, calls: [] })
/**
 * A clock in milliseconds that ticks every second only while a reply runs, so the Flight bars
 * and the running timer move; at rest the Pane falls back to `metaAtom.minute`.
 */
const nowAtom = atom({ plugin: 'session-hud', key: 'now' } as const, 0)
/**
 * A counter bumped on every sidebar open or close. The band reads it only so it redraws then:
 * whether the sidebar is shown is not itself an atom, so nothing else would wake the band.
 */
const paneEpochAtom = atom({ plugin: 'session-hud', key: 'paneEpoch' } as const, 0)
/** The last process scan: when (`at`, 0 for never), the listed processes, and the last error. */
const procsAtom = atom({ plugin: 'session-hud', key: 'procs' } as const, { at: 0, list: [] })
/** The pid whose "End" awaits confirmation: 0 for none, -1 for "End all stale". */
const confirmAtom = atom({ plugin: 'session-hud', key: 'confirmPid' } as const, 0)
/** Presses of the dispatcher's +N: the band shows the dispatch this many along, wrapping. */
const dispatchAtom = atom({ plugin: 'session-hud', key: 'dispatch' } as const, 0)
/** The branch's last commits, as `readCommits` last listed them, for the Commits tab. */
const commitsAtom = atom({ plugin: 'session-hud', key: 'commits' } as const, { list: [] })
/** The Skills tab's record: what fired this session, and when each skill last fired in any. */
const skillsAtom = atom({ plugin: 'session-hud', key: 'skills' } as const, { fired: [], chain: [], seen: {}, since: 0 })
/** The sidebar's What's new: what was asked for, and the picks once read (or why there are none). */
const releaseAtom = atom({ plugin: 'session-hud', key: 'releaseNotes' } as const, { status: 'idle', versions: '', sections: [] })

/** The sidebar's tabs in order, as `[id, label, hotkey]`; `/hud <id or label>` also selects one. */
const TABS: ReadonlyArray<readonly [HudTab, string, string]> = [
  ['hub', 'Hub', '1'],
  ['turn', 'Turn', '2'],
  ['procs', 'Procs', '3'],
  ['commits', 'Commits', '4'],
  ['skills', 'Skills', '5'],
]
/** Names of tabs merged into another, which `/hud` still takes: Cache and Flight are the Turn tab now. */
const TAB_ALIASES: Record<string, HudTab> = { cache: 'turn', flight: 'turn' }
/** Replies kept for the Turn tab's cache; also the widest the hits strip draws. */
const MAX_CACHE_TURNS = 120
/** Tool calls kept for one reply's Flight log, the latest-started; a very long reply cannot grow it without bound. */
const MAX_CALLS = 200
/** Tool calls drawn on the departures board; older ones are counted in "… earlier calls". */
const MAX_FLIGHT_ROWS = 14
/** Processes drawn on the Procs tab; the rest are counted in "… more". */
const MAX_PROC_ROWS = 14
/** Commits listed on the Commits tab. */
const MAX_COMMITS = 10
/** A reply at least this long (2 min) ends with a toast, for the person who looked away. */
const LONG_TURN_MS = 120_000
// Process scans are machine-wide, so sessions share one through a cache file. Every
// 30 s while the Procs tab is on screen, every 5 min otherwise (for the summary count).
const PROCS_EVERY_MS = 30_000
/** The scan cadence while the Procs tab is not on screen: enough to keep the digest's count honest. */
const PROCS_IDLE_EVERY_MS = 5 * 60_000

/** ARIA blinks every 5.2 s; each blink is two blits of her cells, never a redraw of the Pane. */
const BLINK_EVERY_MS = 5_200
/** How often (6 h) npm is asked for the newest release, and how long the shared answer stays good. */
const RELEASE_EVERY_MS = 6 * 60 * 60_000
/** npm's dist-tags for Claude Code: a few hundred bytes mapping channel to version. */
const RELEASE_TAGS_URL = 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags'
/** Usage samples kept in `historyAtom`, enough for the forecasts and the trend bars. */
const MAX_SAMPLES = 120

/** Section headings: the label and the rule after it. */
const HEADING_HEX = '#58a6ff'
/** A version (Claude's in its heading, the plugin's in the footer): set apart from the label before it. */
const VERSION_HEX = '#d2a8ff'
/** How far a section's content sits in from its box's left edge: the line, then a space. */
const INDENT = 2

/** Colors of git's status codes: modified, renamed, added, untracked and deleted. */
const CODE_COLOR = { M: '#d29922', R: '#58a6ff', A: '#3fb950', '?': '#3fb950', D: '#f85149' } as const

/** The usage shape both `$.session.usage()` and the session.measure event carry. */
type Usage = { context: SessionContextUsage; rateLimits: SessionRateLimit[]; cost?: SessionCost }

/** The engine's usage reading reduced to what the HUD keeps; the breakdown is merged in by the caller. */
function toUsage(u: Usage): HudUsage {
  return {
    tokens: u.context.tokens,
    window: u.context.window,
    percent: u.context.percent,
    limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    costUsd: u.cost?.usd,
  }
}

/**
 * The window by category (a local estimate, no API call), the skill listing, and where
 * auto-compaction runs: by the engine's threshold, or failing that by the compaction window
 * the settings or the CLAUDE_CODE_AUTO_COMPACT_WINDOW variable set (`compactPoint`).
 */
async function readBreakdown($: EngineInterface): Promise<Pick<HudUsage, 'parts' | 'compactAt' | 'compactAtTokens' | 'skills'>> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const breakdown = context.breakdown
  const settings = (await $.settings.read()) as Record<string, unknown>
  const configured = configuredCompactWindow(settings, await $.session.model(), await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW'))
  const compactAtTokens = compactPoint(breakdown, configured)
  // The point is in tokens; express it against the model's window, the base `percent` uses.
  const compactAt =
    compactAtTokens !== undefined && context.window > 0 ? Math.round((compactAtTokens / context.window) * 100) : undefined
  if (breakdown === undefined) return { compactAt, compactAtTokens }
  const parts = breakdown.categories
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map(c => ({ name: c.name, tokens: c.tokens }))
  const listing = breakdown.skills
  const skills =
    listing === undefined
      ? undefined
      : {
          total: listing.totalSkills,
          included: listing.includedSkills,
          tokens: listing.tokens,
          list: listing.skillFrontmatter.map(k => ({ name: k.name, source: k.source, plugin: k.pluginName, tokens: k.tokens })),
        }
  return { parts, compactAt, compactAtTokens, skills }
}

/**
 * Writes `gitAtom` only when the reading differs (compared as JSON), so the frequent refreshes
 * after tools and replies redraw nothing when the tree has not changed.
 */
async function setGit($: EngineInterface, value: HudGit): Promise<void> {
  const current = await read($, gitAtom)
  if (JSON.stringify(current) !== JSON.stringify(value)) await update($, gitAtom, () => value)
}

/** Writes `usageAtom` only when the reading differs, for the same reason as `setGit`. */
async function setUsage($: EngineInterface, value: HudUsage): Promise<void> {
  const current = await read($, usageAtom)
  if (JSON.stringify(current) !== JSON.stringify(value)) await update($, usageAtom, () => value)
}

/** Merges `patch` into `metaAtom`, writing (and redrawing) only when some field actually changed. */
async function patchMeta($: EngineInterface, patch: Partial<HudMeta>): Promise<void> {
  const current = await read($, metaAtom)
  const next = { ...current, ...patch }
  if (JSON.stringify(current) !== JSON.stringify(next)) await update($, metaAtom, () => next)
}

// No event carries the session's name, but the engine keeps a small registry of the running
// sessions: ~/.claude/sessions/<pid>.json, one of which holds this session's id and name, and,
// while Remote Control is on, its bridge session id. The file is a few hundred bytes, so once
// found it is re-read on the meta tick; the name changes when the person renames the session,
// the bridge id when they turn /rc on or off.
let namePath: string | undefined

/**
 * Reads the session's name and Remote Control id from the registry; leaves them alone when
 * nothing can be read. Tries the remembered file first (one small read per tick); when that no
 * longer names `id` (the engine restarted under a new pid, or the conversation changed) it scans
 * the folder again. Writes `metaAtom.name` and `metaAtom.remote`.
 */
async function refreshName($: EngineInterface, id: string): Promise<void> {
  if (id === '') return
  const home = await homeDir($)
  if (home === undefined) return
  const folder = `${home}/.claude/sessions`
  // The entry in one registry file when it is this session's; undefined for another session's
  // file or one that is unreadable or vanished mid-scan (a session exiting), hence the catch.
  const entryAt = async (path: string): Promise<SessionEntry | undefined> => {
    const text = await $.fs.read(path).catch(() => undefined)
    return text === undefined ? undefined : sessionEntryIn(text, id)
  }
  if (namePath !== undefined) {
    const known = await entryAt(namePath)
    if (known !== undefined) {
      await patchMeta($, known)

      return
    }
    namePath = undefined
  }
  const entries = await $.fs.list(folder).catch(() => [])
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue
    const path = `${folder}/${entry.name}`
    const found = await entryAt(path)
    if (found !== undefined) {
      namePath = path
      await patchMeta($, found)

      return
    }
  }
}

/** ARIA's reading of the session: her mood, turns left to compaction, the five-hour forecast and the token zone. */
type Assessment = { mood: Mood; turnsLeft?: number; forecast: LimitForecast; zone: Zone }

/**
 * Judges the session's health from the latest usage and the sample history at `now` (epoch
 * ms). The runway aims at the engine's auto-compact percent when known, else `COMPACT_TARGET`.
 * The mood from percentages is then raised by the token zone, so a heavy 1M-token window that
 * is still a small percent is not called happy. Shared by the Pane and `blink`, so both agree.
 */
function assess(usage: HudUsage, history: readonly HudSample[], now: number): Assessment {
  const five = usage.limits.find(l => l.kind === 'five_hour')
  const turnsLeft = turnsToCompact(history, usage.compactAt ?? COMPACT_TARGET)
  const forecast = limitForecast(history, now, five?.resetsAt === undefined ? undefined : Date.parse(five.resetsAt))
  const { zone } = zoneOf(usage.tokens, usage.window, usage.compactAtTokens)
  let mood = moodOf(usage.percent, five?.percentUsed, turnsLeft, forecast)
  // Token pressure counts even when the percent of a 1M window looks small.
  if (zone === 'red' && mood !== 'sleep') mood = 'alarm'
  else if (zone === 'amber' && mood === 'happy') mood = 'focus'
  return { mood, turnsLeft, forecast, zone }
}

/**
 * Appends one usage sample to `historyAtom`, keeping the last `MAX_SAMPLES`. `isTurn` marks a
 * sample taken when the context changed (a reply), which the runway forecast counts as a turn;
 * a reading with neither a context nor a five-hour percent is dropped as carrying nothing.
 */
async function recordSample($: EngineInterface, usage: HudUsage, isTurn: boolean): Promise<void> {
  const five = usage.limits.find(l => l.kind === 'five_hour')?.percentUsed
  if (usage.percent === undefined && five === undefined) return
  const sample: HudSample = { t: await $.clock.now(), ctx: usage.percent, five, isTurn }
  await update($, historyAtom, list => [...list, sample].slice(-MAX_SAMPLES))
}

/**
 * One blink of ARIA's eyes: blits closed-eye cells straight into the sidebar's `aria` Raster,
 * then open ones 160 ms later, without redrawing the Pane. A sleeping face is already shut, so
 * it is skipped; a refused first blit (the sidebar is closed, or the Hub tab with the Raster is
 * not drawn) skips the reopen too, since there is nothing to reopen.
 */
async function blink($: EngineInterface): Promise<void> {
  const [usage, history] = await Promise.all([read($, usageAtom), read($, historyAtom)])
  const { mood } = assess(usage, history, await $.clock.now())
  if (mood === 'sleep') return
  const shut = await $.ui.blit({ requestId: PANE, key: 'aria', cells: ariaCells(mood, true) })
  if (shut.deny !== undefined) return
  $.clock.after(160, () => void $.ui.blit({ requestId: PANE, key: 'aria', cells: ariaCells(mood, false) }))
}

/**
 * Adds or replaces (by id) one tool call in the Flight log: a call is written once as it
 * starts and again with its end and outcome. Calls stay ordered by start, since parallel calls
 * finish out of order, and only the latest `MAX_CALLS` are kept.
 */
async function flightCall($: EngineInterface, call: HudCall): Promise<void> {
  await update($, flightAtom, (flight: HudFlight) => {
    const others = flight.calls.filter(c => c.id !== call.id)
    return { ...flight, calls: [...others, call].sort((a, b) => a.start - b.start).slice(-MAX_CALLS) }
  })
}

/** How long after a reply ends a git reading still counts toward its touched files: the refresh its last call fired may land late. */
const TOUCH_GRACE_MS = 10_000

/**
 * Adds what changed in the working tree since the last git reading (`tree`) to the reply's
 * touched files, whatever changed it: an edit tool, a shell command, a formatter, a subagent.
 * The first reading of a reply only sets the base. Readings between replies change nothing.
 */
async function noteTouched($: EngineInterface, tree: HudTree): Promise<void> {
  const now = await $.clock.now()
  await update($, flightAtom, (flight: HudFlight): HudFlight => {
    if (flight.startedAt === 0 || (flight.endedAt !== undefined && now - flight.endedAt > TOUCH_GRACE_MS)) return flight
    return { ...flight, base: tree, touched: touchFiles(flight.touched ?? [], flight.base, tree) }
  })
}

/**
 * The 1 s clock that runs only while a reply does. A hot reload mid-reply cancels the timer and
 * resets this to undefined, so the running timer freezes until the next `startFlight`.
 */
let flightTimer: { cancel: () => void } | undefined

/** Moves `nowAtom` to the engine's clock, redrawing the Flight timer and bars. */
async function bumpNow($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
}

/**
 * Begins a reply's Flight: a fresh log under `turnId`, `nowAtom` at its start, and the 1 s
 * clock (any earlier one cancelled first, so turns never stack two).
 */
async function startFlight($: EngineInterface, turnId: string): Promise<void> {
  const now = await $.clock.now()
  await update($, flightAtom, () => ({ turnId, startedAt: now, calls: [] }))
  await update($, nowAtom, () => now)
  flightTimer?.cancel()
  flightTimer = $.clock.every(1_000, () => void bumpNow($))
}

/**
 * Ends the reply's Flight: stops the 1 s clock, stamps the end, appends the reply's cache split
 * `turn` to `cacheAtom` (undefined when the reply reported no input usage), and toasts when it
 * took `LONG_TURN_MS` or more. `durationMs` is the engine's own measure of the reply.
 */
async function endFlight($: EngineInterface, durationMs: number, turn: HudCacheTurn | undefined): Promise<void> {
  flightTimer?.cancel()
  flightTimer = undefined
  const now = await $.clock.now()
  await update($, flightAtom, (flight: HudFlight) => ({ ...flight, endedAt: now }))
  await update($, nowAtom, () => now)
  if (turn !== undefined) await update($, cacheAtom, (turns: HudCacheTurn[]) => [...turns, turn].slice(-MAX_CACHE_TURNS))
  if (durationMs >= LONG_TURN_MS) $.ui.toast(`Reply finished in ${formatSeconds(durationMs)}`)
}

/** Bumps `paneEpochAtom` so the AbovePrompt band redraws and re-checks whether the sidebar is shown. */
async function bumpPanes($: EngineInterface): Promise<void> {
  await update($, paneEpochAtom, n => n + 1)
}

/**
 * The process scan in flight, if any: `refreshProcs` keeps one at a time, since a scan spawns
 * PowerShell or `ps`. Resolves true when it refreshed the list. Reset by a hot reload, which at
 * worst lets one extra scan overlap the old instance's.
 */
let procsScan: Promise<boolean> | undefined
// This session's own pids, learned from the first scan it runs itself. Empty until then, which
// is also what forces that first scan to be its own: a shared scan has no ancestry chain.
let selfPids: number[] = []

/** The home folder, when it is an absolute path: an empty USERPROFILE would put files at the drive root. */
async function homeDir($: EngineInterface): Promise<string | undefined> {
  // Each name stays a literal: the engine lists the variables a module reads from its call sites.
  for (const read of [() => $.env.get('USERPROFILE'), () => $.env.get('HOME')]) {
    const value = (await read())?.trim()
    // Absolute only (`C:\…`, `C:/…` or `/…`): `$.fs` resolves a relative path against the
    // session's folder, so a relative home would scatter `.claude/` into the project. Trailing
    // separators are trimmed so `${home}/.claude/…` joins cleanly.
    // The trailing slashes go from where their run starts (`(?<![\\/])`), not from each slash in it.
    if (value && /^(?:[A-Za-z]:)?[\\/]/.test(value)) return value.replace(/(?<![\\/])[\\/]+$/, '')
  }
  return undefined
}

/**
 * Where sessions share the machine-wide process scan: `~/.claude/session-hud/procs-scan.json`.
 * Undefined without a usable home folder, and then every scan is this session's own.
 */
async function scanCachePath($: EngineInterface): Promise<string | undefined> {
  const home = await homeDir($)
  return home === undefined ? undefined : `${home}/.claude/session-hud/procs-scan.json`
}

/** Whether a parsed JSON value is a plain object, whose fields can be checked one by one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether each of the named fields of `value` is a finite number. */
function hasNumbers(value: Record<string, unknown>, names: readonly string[]): boolean {
  return names.every(name => Number.isFinite(value[name]))
}

/** Whether a shared scan's row has every field `buildProcs` reads, each of its type (`RawProc`). */
function isCachedRow(value: unknown): boolean {
  return isRecord(value) && hasNumbers(value, ['pid', 'start', 'mem', 'cpu']) && typeof value.name === 'string' && typeof value.cmd === 'string'
}

/** Whether a shared scan's tree entry has every field the ancestry walk reads, each of its type (`TreeNode`). */
function isCachedNode(value: unknown): boolean {
  return isRecord(value) && hasNumbers(value, ['pid', 'ppid', 'start']) && typeof value.name === 'string'
}

/**
 * Whether a parsed shared scan has the shape `toCache` writes. The file is written by any session
 * on the machine, of any version, and may be half-written or edited by hand; one bad row would
 * make `buildProcs` throw on every read for as long as the file stays fresh, so a scan that fails
 * this is no scan, and the reader runs its own.
 */
function isCachedScan(value: unknown): value is CachedScan {
  return (
    isRecord(value) &&
    Number.isFinite(value.at) &&
    Array.isArray(value.rows) &&
    value.rows.every(isCachedRow) &&
    Array.isArray(value.tree) &&
    value.tree.every(isCachedNode)
  )
}

/** The shared scan when it is at most `maxAgeMs` old and well formed; undefined when missing, stale, unreadable or malformed. */
async function readCachedScan($: EngineInterface, path: string, now: number, maxAgeMs: number): Promise<Scan | undefined> {
  try {
    const cached: unknown = JSON.parse(await $.fs.read(path))
    if (!isCachedScan(cached)) return undefined
    const age = now - cached.at
    // A scan dated in the future (another session's clock) is not fresh, however long it waits.
    return age >= 0 && age <= maxAgeMs ? fromCache(cached) : undefined
  } catch {
    // missing (no session has scanned yet), half-written by another session, or not JSON: scan afresh
    return undefined
  }
}

/**
 * Lists every claude and node process: from the shared scan when it is fresh
 * enough, else one PowerShell CIM query on Windows (`ps` elsewhere), which it
 * then shares. `maxAgeMs` 0 always scans, after waiting out a scan already
 * running; otherwise a scan already running is enough. Resolves true when the
 * list was refreshed by this call.
 */
async function refreshProcs($: EngineInterface, maxAgeMs: number): Promise<boolean> {
  // A routine refresh is satisfied by the scan already running; its result lands in procsAtom.
  if (procsScan !== undefined && maxAgeMs > 0) return false
  // A forced one (Rescan, End) must see a scan that starts after it was asked: wait out the
  // running one, looping because another waiter may have started a scan in between.
  while (procsScan !== undefined) await procsScan
  procsScan = scanProcs($, maxAgeMs)
  try {
    return await procsScan
  } finally {
    procsScan = undefined
  }
}

/**
 * One scan, behind `refreshProcs`'s one-at-a-time guard. Uses the shared scan when it is at most
 * `maxAgeMs` old and this session already knows its own pids; otherwise runs PowerShell (30 s
 * bound) on Windows or `ps` (15 s) elsewhere, learns its own pids from the result and writes it
 * to the shared file. Writes `procsAtom`, carrying CPU history over from the previous list.
 * Never throws: a failure is shown as `procs.error` and resolves false, keeping the old list.
 */
async function scanProcs($: EngineInterface, maxAgeMs: number): Promise<boolean> {
  try {
    const now = await $.clock.now()
    const path = await scanCachePath($)
    // Another session's scan cannot say which processes are this session's, so the first
    // scan is always run here; `maxAgeMs` 0 (Rescan, End) also refuses the shared copy.
    const shared =
      path !== undefined && selfPids.length > 0 && maxAgeMs > 0 ? await readCachedScan($, path, now, maxAgeMs) : undefined
    let scan = shared
    // Also what ending does here, so the End prompt can say it: taskkill /T takes the whole tree.
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    if (scan === undefined) {
      const result = isWindows
        ? await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(WINDOWS_SCAN)], {
            timeoutMs: 30_000,
          })
        : await $.process.run(['sh', '-c', PS_SCAN], {
            timeoutMs: 15_000,
          })
      if (result.exitCode !== 0) {
        // The first stderr line, cut to 120 characters, is enough to name the failure in one row.
        const error = (result.stderr.trim().split(/\r?\n/)[0] ?? '').slice(0, 120) || 'process scan failed'
        await update($, procsAtom, (procs: HudProcs) => ({ ...procs, at: now, error }))
        return false
      }
      scan = isWindows ? parseWindowsScan(result.stdout) : parsePsScan(result.stdout, now)
      selfPids = selfOf(scan)
      // Shared with command lines tidied (credentials hidden). Sharing is an optimisation only:
      // a failed write (a refused path, a full disk) only costs other sessions a scan of their own.
      if (path !== undefined) await $.fs.write(path, JSON.stringify(toCache(scan, now))).catch(() => undefined)
    }
    const previous = await read($, procsAtom)
    // The previous scan's time measures CPU since then; on the first scan there is none.
    const list = buildProcs(scan, previous.list, now, previous.at || now, selfPids)
    await update($, procsAtom, () => ({ at: now, list, endsTree: isWindows }))
    return true
  } catch {
    // A spawn refused or timed out, or output that would not parse: keep the last list, say so.
    await update($, procsAtom, (procs: HudProcs) => ({ ...procs, error: 'process scan failed' }))
    return false
  }
}

/**
 * Whether a pid is one this module will ever signal: a whole number above 1. Pid 1 is a
 * container's init, and ending it ends the container with this session inside; 0 and the
 * negatives mean a process group or every process to `kill`. `canEnd` refuses these too; this
 * is the second line, checked on the very pid about to be signalled.
 */
function isEndablePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1
}

/**
 * Whether `target`, as the person confirmed it, is still in the fresh `list` as something to
 * end: the same pid, still endable, and started within 2 s of the listed start (a reused pid
 * belongs to a process that started later, so it fails the match). For "End all stale"
 * (`mustBeStale`) it must also still be stale at `now`: one that woke after the confirm was
 * confirmed as idle, and is no longer what the person agreed to end.
 */
function isStillEndable(list: readonly HudProc[], target: HudProc, mustBeStale: boolean, now: number): boolean {
  if (!isEndablePid(target.pid)) return false
  return list.some(
    p => p.pid === target.pid && canEnd(p) && Math.abs(p.startedAt - target.startedAt) < 2_000 && (!mustBeStale || isStale(p, now)),
  )
}

/**
 * Ends the given processes after a fresh scan: one that is gone, now under this
 * session, or whose pid was reused since is skipped, and so, for "End all stale"
 * (`mustBeStale`), is one no longer stale. Without a fresh scan nothing is ended:
 * the list it would check against is old. On Windows each one ends with its tree
 * (`taskkill /T`, start time re-checked in the same call by `endScript`);
 * elsewhere `kill -TERM` signals that one process, so its children may outlive it.
 */
async function endProcesses($: EngineInterface, targets: readonly HudProc[], mustBeStale: boolean): Promise<void> {
  await update($, confirmAtom, () => 0)
  if (!(await refreshProcs($, 0))) {
    $.ui.toast('Could not re-scan processes: nothing was ended')
    return
  }
  const { list, at } = await read($, procsAtom)
  const live = targets.filter(t => isStillEndable(list, t, mustBeStale, at))
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  let ended = 0
  for (const proc of live) {
    // On Windows the pid's start time is checked again in the same call that ends it, so a reused pid is never hit.
    const argv = isWindows
      ? ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(endScript(proc.pid, proc.startedAt))]
      : ['kill', '-TERM', String(proc.pid)]
    const result = await $.process.run(argv, { timeoutMs: 15_000 })
    if (result.exitCode === 0) ended += 1
  }
  const skipped = targets.length - live.length
  // Said only when something was skipped: a clean run needs no aside.
  const skippedNote = skipped > 0 ? ` (${skipped} changed, skipped)` : ''
  $.ui.toast(`Ended ${ended} of ${targets.length} process${targets.length === 1 ? '' : 'es'}${skippedNote}`)
  // A last forced scan so the list shows what is actually left.
  await refreshProcs($, 0)
}

/** The digest's parts, each text with its color: cache, the reply in flight, processes. */
type Summary = {
  cache: string
  cacheHex: string
  flight: string
  flightHex: string
  procs: string
  procsHex: string
}

/** One part of the digest: its text and the color it is drawn in. */
type SummaryPart = { text: string; hex: string }

/**
 * The color of the cache part by `warmth`, the share of the cache's lifetime left (1 just after
 * a reply, 0 once lapsed): grey when lapsed, amber in its last quarter (the time to reply before
 * the next one pays to re-cache), blue while warm.
 */
function warmthHex(warmth: number): string {
  if (warmth === 0) return '#6e7681'
  return warmth < 0.25 ? '#d29922' : '#79c0ff'
}

/** Whether a reply is running: each of its requests reads and refreshes the cache, however long the reply takes. */
function isReplying(flight: HudFlight): boolean {
  return flight.startedAt > 0 && flight.endedAt === undefined
}

/** How warm the cache is, 0 to 1: full while a reply runs, else what is left since the last reply ended. */
function liveWarmth(cache: readonly HudCacheTurn[], flight: HudFlight, now: number): number {
  return isReplying(flight) && cache.length > 0 ? 1 : cacheWarmth(cache, now)
}

/**
 * The cache part of the digest, the ice cube saying what it is: the last reply's hit share and
 * the time left warm (`live` while a reply keeps it warm), or cold, or a dash before any reply.
 */
function summarizeCache(cache: readonly HudCacheTurn[], flight: HudFlight, now: number): SummaryPart {
  const last = cache.at(-1)
  if (last === undefined) return { text: '❄ —', hex: '#6e7681' }
  const warmth = liveWarmth(cache, flight, now)
  const left = isReplying(flight) ? 'live' : formatSpan(warmth * CACHE_TTL_MS)
  const text = warmth > 0 ? `${Math.round(last.hit * 100)}% ❄ ${left}` : '❄ cold'
  return { text, hex: warmthHex(warmth) }
}

/**
 * The reply-in-flight part of the digest: running with its age, or the last one's length. Only
 * the time, so it stays short; a last reply with a failed call is drawn red.
 */
function summarizeFlight(flight: HudFlight, now: number): SummaryPart {
  if (flight.startedAt <= 0) return { text: 'idle', hex: '#6e7681' }
  if (flight.endedAt === undefined) {
    return { text: `▶ ${formatSeconds(Math.max(0, now - flight.startedAt))}`, hex: '#f0883e' }
  }
  return {
    text: `last ${formatSeconds(flight.endedAt - flight.startedAt)}`,
    hex: flight.calls.some(c => c.isError) ? '#f85149' : '#8b949e',
  }
}

/** The processes part of the digest: how many, and how many look stale (drawn red when any do), or a dash before the first scan. */
function summarizeProcs(procs: HudProcs, now: number): SummaryPart {
  const stale = procs.list.filter(p => isStale(p, now)).length
  const staleNote = stale > 0 ? ` (${stale} stale)` : ''
  const text = procs.at === 0 ? 'procs —' : `procs ${procs.list.length}${staleNote}`
  return { text, hex: stale > 0 ? '#f85149' : '#8b949e' }
}

/** The skills part of the digest: how many skills fired this session, drawn purple once any has. */
function summarizeSkills(skills: HudSkills): SummaryPart {
  const used = skills.fired.length
  return { text: `skills ${used}`, hex: used > 0 ? VERSION_HEX : '#6e7681' }
}

/** The one-line digest of cache, the current reply and processes, for the band and the tabs. */
function summarize(cache: readonly HudCacheTurn[], flight: HudFlight, procs: HudProcs, now: number): Summary {
  const cachePart = summarizeCache(cache, flight, now)
  const flightPart = summarizeFlight(flight, now)
  const procsPart = summarizeProcs(procs, now)
  return {
    cache: cachePart.text,
    cacheHex: cachePart.hex,
    flight: flightPart.text,
    flightHex: flightPart.hex,
    procs: procsPart.text,
    procsHex: procsPart.hex,
  }
}

/** The release check as kept in `$.store` under `release`: when (epoch ms), for which npm tag, and the version found. */
type ReleaseCheck = { at: number; channel: string; version: string }

/**
 * The npm dist-tag for the settings' `autoUpdatesChannel`: `rc` publishes as `next`, `stable`
 * as itself, and anything else (the default) as `latest`.
 */
function releaseTag(autoUpdatesChannel: unknown): string {
  if (autoUpdatesChannel === 'stable') return 'stable'
  return autoUpdatesChannel === 'rc' ? 'next' : 'latest'
}

/**
 * The newest Claude Code release on this install's update channel, from npm's
 * dist-tags, at most every 6 hours; the answer is kept in the plugin's store so
 * every session shares one check. Offline or refused: nothing changes.
 */
async function checkRelease($: EngineInterface): Promise<void> {
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    const channel = releaseTag(settings.autoUpdatesChannel)
    const now = await $.clock.now()
    const cached = (await $.store.get('release')) as ReleaseCheck | undefined
    // Reused only for the same channel: switching channels must not show the other's version.
    let version = cached?.channel === channel && now - cached.at < RELEASE_EVERY_MS ? cached.version : undefined
    if (version === undefined) {
      const response = await $.http.fetch(RELEASE_TAGS_URL)
      if (!response.ok) return
      const tags = JSON.parse(response.text) as Record<string, unknown>
      if (typeof tags[channel] !== 'string') return
      version = tags[channel] as string
      await $.store.set('release', { at: now, channel, version } satisfies ReleaseCheck)
    }
    await patchMeta($, { latest: version })
  } catch {
    // offline, proxy refused, or an unexpected reply: keep the version uncoloured
  }
}

/** Git's settings for a fetch that runs unattended: it fails rather than ask for a login. */
const QUIET_GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }

/** How often the HUD asks its marketplace for a newer version of itself. */
const HUD_RELEASE_EVERY_MS = 30 * 60_000

/**
 * Asks the HUD's own marketplace which version it lists now, without changing what is installed:
 * the newer of what its local clone holds (which any `claude plugin marketplace update` brings
 * up to date) and what the remote's head holds, fetched into the clone. Nothing happens outside
 * a marketplace (a `--plugin-dir` checkout); a remote git cannot reach leaves the local reading.
 */
async function checkHudRelease($: EngineInterface): Promise<void> {
  const source = pluginSource($.plugin.root)
  if (source === undefined) return
  const repo = `${source.pluginsDir}/marketplaces/${source.marketplace}`
  const found: string[] = []
  try {
    found.push(marketplaceVersion(await $.fs.read(`${repo}/.claude-plugin/marketplace.json`), $.plugin.name))
  } catch {
    // no clone on disk: the fetch below may still find one
  }
  try {
    const fetched = await $.process.run(['git', '-C', repo, 'fetch', '--quiet', 'origin', 'HEAD'], { timeoutMs: 30_000, env: QUIET_GIT_ENV })
    const shown = fetched.exitCode === 0 ? await $.process.run(['git', '-C', repo, 'show', 'FETCH_HEAD:.claude-plugin/marketplace.json'], { timeoutMs: 10_000 }) : fetched
    if (shown.exitCode === 0) found.push(marketplaceVersion(shown.stdout, $.plugin.name))
  } catch {
    // git missing: the local reading stands
  }
  const newest = found.filter(v => v !== '').sort((a, b) => compareVersions(b, a))[0]
  if (newest !== undefined) await patchMeta($, { hudLatest: newest })
}

/** Whether an upgrade is running, so a second press waits for it rather than starting another. */
let isUpgrading = false

/**
 * Upgrades the HUD from its marketplace, as `claude plugin marketplace update` then `claude
 * plugin update` would, and toasts how it went: a restart applies it. When the CLI cannot be
 * run from here, the toast gives the command to run by hand.
 */
async function upgradeHud($: EngineInterface): Promise<void> {
  const source = pluginSource($.plugin.root)
  if (source === undefined || isUpgrading) return
  const id = `${$.plugin.name}@${source.marketplace}`
  isUpgrading = true
  $.ui.toast(`Upgrading ${$.plugin.name}…`)
  try {
    const refreshed = await $.process.run(['claude', 'plugin', 'marketplace', 'update', source.marketplace], { timeoutMs: 180_000, env: QUIET_GIT_ENV })
    const updated = refreshed.exitCode === 0 ? await $.process.run(['claude', 'plugin', 'update', id], { timeoutMs: 180_000, env: QUIET_GIT_ENV }) : refreshed
    $.ui.toast(updated.exitCode === 0 ? `${$.plugin.name} upgraded: restart Claude Code to apply` : `Could not upgrade: run claude plugin update ${id}`)
  } catch {
    $.ui.toast(`Could not upgrade: run claude plugin update ${id}`)
  } finally {
    isUpgrading = false
  }
}

/** The picks as kept in `$.store` under `releaseNotes`, for the versions they were picked from. */
type StoredRelease = { versions: string; sections: HudReleaseNotes['sections'] }

/** Whether a stored value is a `StoredRelease`: any session, or a hand edit, may have written it. */
function isStoredRelease(value: unknown): value is StoredRelease {
  return (
    isRecord(value) &&
    typeof value.versions === 'string' &&
    Array.isArray(value.sections) &&
    value.sections.every(s => isRecord(s) && typeof s.version === 'string' && Array.isArray(s.items) && s.items.every(i => typeof i === 'string'))
  )
}

/**
 * Turns the sidebar to What's new for the installed version, or for every version since it when
 * a newer one is out, and fills it: the changelog is fetched, its sections for those versions
 * cut out, and a fork of the conversation (so it knows what this person works on) picks the
 * changes worth knowing. A new session, with nothing to fork yet, asks without it. The picks
 * are kept in the store for every session; `isFresh` reads them again. A read already running,
 * or done for the same versions, only shows the view.
 *
 * It is the sidebar's own view, not a pane of its own: a pane opened from a press in the sidebar
 * cannot take the focus from it, so it would open as a tab behind the sidebar and the click
 * would seem to do nothing. From the band, the open brings the sidebar up.
 */
async function showReleaseNotes($: EngineInterface, isFresh = false): Promise<void> {
  const meta = await read($, metaAtom)
  const versions = releaseRange(meta.version, meta.latest)
  await update($, tabAtom, (): HudTab => 'news')
  await $.ui.open({ id: PANE, title: TITLE, columns: 40 })
  const current = await read($, releaseAtom)
  if (current.status === 'reading' || (!isFresh && current.status === 'ready' && current.versions === versions)) return
  const stored = await $.store.get('releaseNotes').catch(() => undefined)
  if (!isFresh && isStoredRelease(stored) && stored.versions === versions) {
    await update($, releaseAtom, (): HudReleaseNotes => ({ status: 'ready', versions, sections: stored.sections }))
    return
  }
  await update($, releaseAtom, (): HudReleaseNotes => ({ status: 'reading', versions, sections: [] }))
  const fail = async (error: string): Promise<void> => {
    await update($, releaseAtom, (): HudReleaseNotes => ({ status: 'error', versions, sections: [], error }))
  }
  try {
    const response = await $.http.fetch(CHANGELOG_URL)
    if (!response.ok) return await fail(`the changelog did not load (HTTP ${response.status})`)
    const sections = changelogSections(response.text, meta.version, meta.latest)
    if (sections.length === 0) return await fail(`the changelog has no notes for ${versions} yet`)
    const prompt = releaseNotesPrompt(sections)
    const forked = await $.model.fork({ prompt })
    const reply = !forked.isAnswered && forked.reason === 'nothing-to-fork' ? await $.model.complete({ model: 'haiku', prompt, maxTokens: 2_000 }) : forked
    if (!reply.isAnswered) return await fail(`the notes could not be read (${reply.reason})`)
    const picks = parseReleasePicks(reply.text)
    await update($, releaseAtom, (): HudReleaseNotes => ({ status: 'ready', versions, sections: picks }))
    await $.store.set('releaseNotes', { versions, sections: picks } satisfies StoredRelease).catch(() => undefined)
  } catch (error) {
    await fail(error instanceof Error ? error.message.slice(0, 80) : 'the notes could not be read')
  }
}

/** When each skill last fired in any session, as kept in `$.store` under `skillsSeen`, and since when it has been kept. */
type SkillsSeen = { since: number; seen: Record<string, number> }

/** Whether a stored value is a `SkillsSeen`: any session, or a hand edit, may have written it. */
function isSkillsSeen(value: unknown): value is SkillsSeen {
  return (
    isRecord(value) &&
    typeof value.since === 'number' &&
    isRecord(value.seen) &&
    Object.values(value.seen).every(at => typeof at === 'number')
  )
}

/** The stored record of when each skill last fired, begun now when there is none (or it is malformed). */
async function readSkillsSeen($: EngineInterface, now: number): Promise<SkillsSeen> {
  const stored = await $.store.get('skillsSeen')
  return isSkillsSeen(stored) ? stored : { since: now, seen: {} }
}

/** Brings the stored record into `skillsAtom` at session start, so the Skills tab knows which skills have gone quiet. */
async function loadSkillsSeen($: EngineInterface): Promise<void> {
  try {
    const record = await readSkillsSeen($, await $.clock.now())
    await $.store.set('skillsSeen', record)
    await update($, skillsAtom, skills => ({ ...skills, seen: { ...record.seen, ...skills.seen }, since: record.since }))
  } catch {
    // no store: the tab still lists this session's fires, and calls every skill quiet
  }
}

/**
 * Skills Claude has called through the Skill tool whose prompts have not expanded yet: the
 * Skill call's own hook adds one, and the expansion it causes takes it, so a prompt with none
 * waiting was typed by the person (or preloaded into an agent). A module `let`: a reload drops
 * one in flight, which then counts as yours.
 */
const pendingSkills = new Set<string>()

/**
 * A fire's two reports. `skill.prompt` brings the prompt, and so its tokens, but where an
 * organization manages Claude Code it never reaches a plugin the person installed; the Skill
 * call and the typed command reach every plugin, without the prompt. Whichever reports a fire
 * first counts it and leaves its name here, and the other takes the name instead of counting
 * it again (`skill.prompt` adding its tokens). Emptied when a reply ends, so a report that
 * never came leaves nothing behind. Module `let`s: a reload drops them, at worst counting a
 * fire in flight twice.
 */
const promptNoted = new Set<string>()
const callNoted = new Set<string>()

/** Takes `name` from `noted`, matched in full or without its `plugin:` prefix. */
function takeSkill(noted: Set<string>, name: string): boolean {
  for (const pending of noted) {
    if (pending === name || skillShortName(pending) === skillShortName(name)) return noted.delete(pending)
  }
  return false
}

/**
 * Records one fire of skill `name`, `by` the person or Claude, its prompt `tokens` long (0 when
 * not known yet): in `skillsAtom` for this session, and in the store for every session, which
 * only ever moves a skill's time forward.
 */
async function noteSkill($: EngineInterface, name: string, tokens: number, by: 'you' | 'claude'): Promise<void> {
  const now = await $.clock.now()
  await update($, skillsAtom, skills => recordSkill(skills, name, tokens, by, now))
  const record = await readSkillsSeen($, now)
  await $.store.set('skillsSeen', { since: record.since, seen: { ...record.seen, [name]: now } } satisfies SkillsSeen)
}

/** A skill's prompt expanded, `text` long: its fire counted, or its tokens added to the fire the call or command counted. */
async function noteSkillPrompt($: EngineInterface, name: string, text: string): Promise<void> {
  const by = takeSkill(pendingSkills, name) ? 'claude' : 'you'
  if (takeSkill(callNoted, name)) {
    await update($, skillsAtom, skills => addSkillTokens(skills, name, estimateTokens(text)))
    return
  }
  promptNoted.add(name)
  await noteSkill($, name, estimateTokens(text), by)
}

/** A Skill call or a typed skill ran: its fire counted, unless its prompt's expansion already did. */
async function noteSkillCall($: EngineInterface, name: string, by: 'you' | 'claude'): Promise<void> {
  if (takeSkill(promptNoted, name)) return
  callNoted.add(name)
  await noteSkill($, name, 0, by)
}

/**
 * Whether the typed command `name` is a skill: one the listing names, in full or by its short
 * name, or the person's own (`user`) command, which expands a prompt as a skill does. A
 * plugin's skill past the listing's budget is missed: it cannot be told from a command a plugin
 * registers.
 */
async function isSkillCommand($: EngineInterface, name: string): Promise<boolean> {
  const listed = (await read($, usageAtom)).skills?.list ?? []
  if (listed.some(s => s.name === name || skillShortName(s.name) === skillShortName(name))) return true
  const commands = await $.command.list()
  return commands.some(c => c.name === name && c.source === 'user')
}

/**
 * True from a compaction's install until the re-check note is appended after it: set by the
 * session.compact hook, `runCompact` or a typed /compact, consumed by the compaction
 * session.append (or, failing that, the next turn.start). A module `let`: a reload in between
 * drops the note, harmlessly.
 */
let isRecheckPending = false

/**
 * Set by the session.compact hook, so a typed /compact can tell whether that hook briefed it.
 * Where an organization manages Claude Code the hook never runs in a plugin the person
 * installed, and the command arms the re-check note itself.
 */
let isCompactHookSeen = false
// The keep-list file of the compaction now running from the Prep button, for the re-check note.
let pendingKeepListPath: string | undefined

/**
 * Appends the post-compaction re-check note as a user message, naming the keep-list file when
 * one was saved, and forgets that path. Best effort: a refused note (a run plugins may not
 * shape) must never disturb the conversation, so its failure is swallowed.
 */
async function appendRecheck($: EngineInterface): Promise<void> {
  const text = recheckNote(pendingKeepListPath)
  pendingKeepListPath = undefined
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
}

/**
 * Step 1 of "Prep compact": open the dialog and have a fork of the conversation
 * (nothing is added to the conversation itself) draft what must survive. `steerText` is what
 * the person typed (cut to 400 characters); when absent or blank the previous steer is kept.
 * While a draft or compaction runs, a second call only brings the dialog forward. Writes
 * `draftAtom` (drafting, then ready or error).
 */
async function startDraft($: EngineInterface, steerText?: string): Promise<void> {
  const current = await read($, draftAtom)
  if (current.status === 'drafting' || current.status === 'compacting') {
    await $.ui.open({ id: DRAFT_PANE, title: 'Prep compact', focus: true, closeOnEscape: true })
    return
  }
  // A steer sticks until it is replaced: redrafting again keeps the person's words.
  const typed = steerText?.trim().slice(0, 400)
  const steer = typed === undefined || typed === '' ? current.steer : typed
  await update($, draftAtom, (): HudDraft => ({ status: 'drafting', items: [], steer }))
  await $.ui.open({ id: DRAFT_PANE, title: 'Prep compact', focus: true, closeOnEscape: true })
  // A fork that throws (offline, aborted) must not leave the dialog drafting for good:
  // that state hides Cancel and refuses every later draft, and it survives a reload.
  const reply = await $.model.fork({ prompt: draftPrompt(steer) }).catch((error: unknown) => ({
    isAnswered: false as const,
    reason: error instanceof Error ? error.message.slice(0, 80) : 'error',
  }))
  if (!reply.isAnswered) {
    const why = reply.reason === 'nothing-to-fork' ? 'nothing to summarise yet' : `the draft failed (${reply.reason})`
    await update($, draftAtom, (): HudDraft => ({ status: 'error', items: [], steer, error: why }))
    return
  }
  const items = parseKeepList(reply.text)
  // With a steer there is already something to keep, so an empty draft is not an error.
  await update($, draftAtom, (): HudDraft =>
    items.length > 0 || steer !== undefined
      ? { status: 'ready', items, steer }
      : { status: 'error', items: [], error: 'the draft came back empty' },
  )
}

/**
 * Step 2: save the approved items to a file (files survive compaction whole),
 * then compact with them first in the instructions; the standing brief follows.
 * Refuses (back to ready, with a message) when nothing is ticked and there is no steer. The
 * file goes to `~/.claude/session-hud/keep/<session id>-<ISO time>.md`; if it cannot be saved
 * the compaction still runs with the items inline. On success the dialog closes with a toast.
 */
async function runCompact($: EngineInterface): Promise<void> {
  const draft = await read($, draftAtom)
  const kept = draft.items.filter(i => i.keep).map(i => i.text)
  const steer = draft.steer
  if (kept.length === 0 && (steer === undefined || steer === '')) {
    await update($, draftAtom, (d): HudDraft => ({ ...d, status: 'ready', error: 'keep something, or say what matters below' }))
    return
  }
  await update($, draftAtom, (d): HudDraft => ({ ...d, status: 'compacting', error: undefined }))
  try {
    const home = await homeDir($)
    const sessionId = await $.session.id()
    const stamp = new Date(await $.clock.now()).toISOString()
    let path: string | undefined
    if (home !== undefined) {
      // The id is sanitised to word characters and dashes, and the time's `:` and `.` replaced,
      // so the name is one valid file name on Windows too and can never climb out of keep/.
      path = `${home}/.claude/session-hud/keep/${sessionId.replaceAll(/[^\w-]/g, '_') || 'session'}-${stamp.replaceAll(/[:.]/g, '-')}.md`
      // Unsaved, the instructions simply do not point at a file: the items still go in them.
      await $.fs.write(path, keepListFile(kept, sessionId, stamp, steer)).catch(() => {
        path = undefined
      })
    }
    pendingKeepListPath = path
    // A compaction this plugin starts skips its own session.compact hook, so the standing
    // brief and the re-check note are armed here instead.
    isRecheckPending = true
    const result = await $.session.compact({ instructions: compactInstructions(keepListInstructions(kept, path, steer)) })
    if ('skip' in result && result.skip !== undefined) {
      isRecheckPending = false
      pendingKeepListPath = undefined
      await update($, draftAtom, (d): HudDraft => ({ ...d, status: 'ready', error: `compaction skipped: ${result.skip}` }))
      return
    }
    await update($, draftAtom, (): HudDraft => ({ status: 'idle', items: [] }))
    await $.ui.close({ id: DRAFT_PANE })
    const sizes =
      result.tokensBefore !== undefined && result.tokensAfter !== undefined
        ? ` (${formatTokens(result.tokensBefore)} → ${formatTokens(result.tokensAfter)})`
        : ''
    $.ui.toast(`Compacted with your keep-list${sizes}`)
  } catch {
    isRecheckPending = false
    pendingKeepListPath = undefined
    await update($, draftAtom, (d): HudDraft => ({
      ...d,
      status: 'ready',
      error: 'could not compact now (a reply may be running); try again when it finishes',
    }))
  }
}

/**
 * Notes what the request about to go out sends above the prompt cache's boundary, and warns
 * when it no longer matches the last one: the whole prefix is then written again at twice
 * the input rate instead of read at a tenth, which is the one genuinely expensive turn.
 */
async function notePrefix($: EngineInterface, parts: HudPrefixParts): Promise<void> {
  const before = await read($, prefixAtom)
  // The first request of a session (or after a reset) has nothing to differ from: it only
  // records the parts. An unchanged prefix writes nothing, so composing redraws nothing.
  const reason = before.parts === undefined ? undefined : prefixChange(before.parts, parts)
  if (reason === undefined) {
    if (before.parts === undefined) await update($, prefixAtom, (p): HudPrefix => ({ ...p, parts }))

    return
  }
  const at = await $.clock.now()
  await update($, prefixAtom, (): HudPrefix => ({ parts, reason, at, isPending: true }))
  // The last measured context approximates what is about to be re-cached. The toast fires now,
  // before the request leaves, so the warning arrives ahead of the cost rather than after it.
  const { tokens } = await read($, usageAtom)
  if (tokens !== undefined && tokens >= BREAK_WARN_TOKENS) {
    $.ui.toast(`${reason}: the next reply re-caches ${formatTokens(tokens)}`)
  }
}

/** True while `refreshGit` runs, so overlapping requests (tool calls, replies, timers) never run git twice at once. */
let isGitBusy = false
// Asked for while a refresh ran: that one may have read the tree before the edit that asked.
let isGitDirty = false
/**
 * True from a session.end that ends the process (anything but a /clear or a resume, after which
 * the process goes on) until the next session.start: git is not started for a session on its
 * way out, whose answer nobody would see. A hot reload starts it false, and fires session.start.
 */
let isEnding = false

/**
 * Re-reads git, one refresh at a time. A request arriving mid-refresh does not wait or start a
 * second one; it marks the refresh dirty, and the running one reads again once more when done,
 * so the last edit is always seen and a burst of requests folds into one more read. Callers
 * fire it with `void`: nothing waits on git, and `readGit` never throws. Once the session is
 * ending (`isEnding`) it does nothing, and a running refresh reads no more after its current one.
 */
async function refreshGit($: EngineInterface): Promise<void> {
  if (isEnding) return
  if (isGitBusy) {
    isGitDirty = true
    return
  }
  isGitBusy = true
  try {
    do {
      isGitDirty = false
      await readGit($)
    } while (isGitDirty && !isEnding)
  } finally {
    isGitBusy = false
  }
}

/**
 * One git reading of the session's folder: `status` first (its failure means no repository,
 * and `gitAtom` goes to `EMPTY_GIT`), then diff line counts and the last commit in
 * parallel, each bounded at 10 s. A new last commit stamps `metaAtom.committedAt`
 * (the "committed recently" breakpoint).
 */
async function readGit($: EngineInterface): Promise<void> {
  try {
    // Non-ASCII paths verbatim instead of octal-escaped in quotes, so file names display as typed.
    const flags = ['-c', 'core.quotepath=false']
    const status = await $.process.run(['git', ...flags, 'status', '--porcelain=v1', '-b'], { timeoutMs: 10_000 })
    if (status.exitCode !== 0) {
      await setGit($, EMPTY_GIT)
      return
    }
    const [diff, log] = await Promise.all([
      $.process.run(['git', ...flags, 'diff', 'HEAD', '--numstat'], { timeoutMs: 10_000 }),
      $.process.run(['git', ...flags, 'log', '-1', '--format=%h %s'], { timeoutMs: 10_000 }),
    ])
    const lines = parseNumstat(diff.exitCode === 0 ? diff.stdout : '')
    const lastCommit = log.exitCode === 0 ? log.stdout.trim() : ''
    const before = await read($, gitAtom)
    // Only a change from a known commit counts: the first reading of a session is not a commit.
    if (before.lastCommit !== '' && lastCommit !== '' && lastCommit !== before.lastCommit) {
      await patchMeta($, { committedAt: await $.clock.now() })
    }
    const parsed = parseStatus(status.stdout)
    await setGit($, {
      isRepo: true,
      ...parsed,
      linesAdded: lines.added,
      linesRemoved: lines.removed,
      lastCommit,
    })
    await noteTouched($, treeOf(lastCommit, diff.exitCode === 0 ? diff.stdout : '', parsed.files))
    // The list follows HEAD: it is read again only when the last commit moved and someone looks.
    const shown = (await read($, commitsAtom)).list[0]
    const head = shown === undefined ? '' : `${shown.hash} ${shown.subject}`
    if (head !== lastCommit && (await isPaneOnTab($, 'commits'))) await readCommits($)
  } catch {
    // git missing or timed out: keep the last reading; the next event tries again
  }
}

/**
 * Where the checked-out branch left the branch it was made from: the first of `forkBases` git
 * knows, with the commits on each side since. Undefined on the default branch itself, on a
 * detached HEAD, or when no base exists.
 */
async function readFork($: EngineInterface): Promise<HudFork | undefined> {
  const { branch } = await read($, gitAtom)
  if (branch === '' || branch === 'detached HEAD') return undefined
  const head = await $.process.run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { timeoutMs: 10_000 })
  for (const base of forkBases(head.exitCode === 0 ? head.stdout : '', branch)) {
    const counted = await $.process.run(['git', 'rev-list', '--left-right', '--count', `${base}...HEAD`], { timeoutMs: 10_000 })
    const sides = counted.exitCode === 0 ? parseLeftRight(counted.stdout) : undefined
    if (sides !== undefined) return { base, ...sides }
  }
  return undefined
}

/**
 * Lists the branch's last `MAX_COMMITS` commits with the files and lines each changed, and where
 * the branch left its base (`readFork`), into
 * `commitsAtom` (empty outside a repository or before the first commit). Writes only when the
 * list differs. Never throws: git missing or slow keeps the last list.
 */
async function readCommits($: EngineInterface): Promise<void> {
  try {
    const [log, fork] = await Promise.all([
      $.process.run(['git', 'log', `-${MAX_COMMITS}`, '--shortstat', LOG_FORMAT], { timeoutMs: 10_000 }),
      readFork($),
    ])
    const list = log.exitCode === 0 ? parseLog(log.stdout) : []
    const value: HudCommits = fork === undefined ? { list } : { list, fork }
    const current = await read($, commitsAtom)
    if (JSON.stringify(current) !== JSON.stringify(value)) await update($, commitsAtom, () => value)
  } catch {
    // git missing or timed out: keep the last list; the next look tries again
  }
}

/**
 * Whether the sidebar is on screen (placed and shown, not just open) at `tab`; the timers use
 * it to do their heavier work only while someone can see the result.
 */
async function isPaneOnTab($: EngineInterface, tab: HudTab): Promise<boolean> {
  if ((await read($, tabAtom)) !== tab) return false
  const panes = await $.ui.panes()
  return panes.some(p => p.id === PANE && p.isPlaced && p.isShown)
}

/**
 * `gitTick`'s last view of git's own files, as `index mtime:index size:HEAD mtime`; when it is
 * unchanged on the Hub tab, git is not run. Empty after a reload, so the first tick runs git.
 */
let gitSignature = ''

/**
 * The slow git timer (every 30 s), for changes made outside this session (a lazygit stage or
 * commit, an editor save). It does nothing unless the sidebar is on screen at the Hub or Commits
 * tab. It only stats git's own index and HEAD, which costs no process, and runs git when either
 * moved; a worktree (whose .git is a file) falls back to running git.
 */
async function gitTick($: EngineInterface): Promise<void> {
  if (!(await isPaneOnTab($, 'hub')) && !(await isPaneOnTab($, 'commits'))) return
  const repo = await $.session.repo()
  if (repo === null) return
  try {
    const [index, head] = await Promise.all([
      $.fs.stat(`${repo.root}/.git/index`),
      $.fs.stat(`${repo.root}/.git/HEAD`),
    ])
    const signature = `${index.mtimeMs}:${index.size}:${head.mtimeMs}`
    if (signature === gitSignature) return
    gitSignature = signature
  } catch {
    // no plain .git directory here: fall through and ask git itself
  }
  await refreshGit($)
}

/**
 * Scans on the Procs tab's rhythm while it is on screen, and rarely otherwise. The timer fires
 * every 30 s either way; this decides whether a scan is due.
 */
async function procsTick($: EngineInterface): Promise<void> {
  const isWatching = await isPaneOnTab($, 'procs')
  const now = await $.clock.now()
  const { at } = await read($, procsAtom)
  // 2 s of slack so timer jitter does not skip a whole period. The shared scan accepted is
  // younger than the period (by 5 s, or 30 s idle), so a copy another session wrote at nearly
  // the same moment is reused rather than this session paying for its own.
  if (now - at < (isWatching ? PROCS_EVERY_MS : PROCS_IDLE_EVERY_MS) - 2_000) return
  await refreshProcs($, isWatching ? PROCS_EVERY_MS - 5_000 : PROCS_IDLE_EVERY_MS - 30_000)
}

/**
 * Starts over for a new conversation in the same process: its own id and name, and none of the
 * old one's history. Clears samples, cache turns, the prefix, the Flight, and the Prep compact draft;
 * keeps what belongs to the folder or machine (git, usage, processes, the tab), and the module `let`s tied to the old conversation are dropped.
 */
async function resetConversation($: EngineInterface, id: string): Promise<void> {
  namePath = undefined
  isRecheckPending = false
  pendingKeepListPath = undefined
  flightTimer?.cancel()
  flightTimer = undefined
  const now = await $.clock.now()
  await patchMeta($, { id, name: '', remote: '', startedAt: now, turns: 0, committedAt: 0 })
  await update($, historyAtom, () => [])
  await update($, cacheAtom, () => [])
  await update($, prefixAtom, (): HudPrefix => ({ reason: '', at: 0, isPending: false }))
  await update($, flightAtom, (): HudFlight => ({ turnId: '', startedAt: 0, calls: [] }))
  await update($, draftAtom, (): HudDraft => ({ status: 'idle', items: [] }))
}

/**
 * The 15 s meta tick: refreshes the minute, model, folder and prompt count, notices a new
 * conversation id (a /clear or resume) and resets the HUD for it, then re-reads the session's
 * name. Also run on demand by `/hud` and one second after a /clear.
 */
async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await patchMeta($, {
    minute: Math.floor(now / 60_000),
    model: await $.session.model(),
    cwd: await $.session.cwd(),
    turns: await $.session.turns(),
  })
  // A /clear or a resume goes on in this process under a new id: what the HUD showed was the old conversation's.
  // An id that cannot be read (mid-switch) is '' and changes nothing until the next tick.
  const id = await $.session.id().catch(() => '')
  if (id !== '' && id !== (await read($, metaAtom)).id) await resetConversation($, id)
  // Best effort: the name keeps its last reading when nothing can be read.
  await refreshName($, id).catch(() => undefined)
}

/**
 * The drafted items with a key each that follows the item rather than its row: its text, then how
 * many earlier items share that text, so two identical points still get distinct keys. `index` is
 * the item's place in the draft, which a tick toggles by and its button is keyed by.
 */
function keyedItems(items: HudDraft['items']): { item: HudDraft['items'][number]; index: number; key: string }[] {
  const seen = new Map<string, number>()
  return items.map((item, index) => {
    const count = seen.get(item.text) ?? 0
    seen.set(item.text, count + 1)
    return { item, index, key: `${item.text}#${count}` }
  })
}

/** The element constructors the sidebar's render helpers draw with: the ones every surface has. */
type PaneUi = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button'>

/**
 * Everything the sidebar's render helpers draw from, read once per render so that any atom's
 * change redraws the whole Pane: the resolved elements, the inner width, the two clocks, and
 * each atom's value under its own name.
 */
type PaneView = {
  ui: PaneUi
  // Only the terminal draws Rasters; elsewhere this is undefined and the tabs leave their strips out.
  Raster: Elements['terminal']['Raster'] | undefined
  isTerminal: boolean
  // The pane's inner width in columns, never below 24 so the fixed-width rows still lay out.
  width: number
  // What a section's content has once it sits INDENT in from its heading: bars, rasters and the
  // gantt are sized to this, so nothing spills by one.
  inner: number
  // Two clocks: `now` moves by the minute (the Hub's ages and forecasts need no more), and
  // `liveNow` also takes the 1 s reply clock and the last scan time, for the tabs that tick.
  now: number
  liveNow: number
  git: HudGit
  usage: HudUsage
  meta: HudMeta
  history: readonly HudSample[]
  tab: HudTab
  cache: readonly HudCacheTurn[]
  flight: HudFlight
  procs: HudProcs
  confirmPid: number
  dispatch: number
  prefix: HudPrefix
  commits: HudCommits
  skills: HudSkills
  release: HudReleaseNotes
}

/** Text a rule carries after its label, each a space after what came before: in the rule's color and bold unless it says otherwise. */
type RuleSpan = { text: string; color?: string; isDim?: boolean }

/**
 * A rule across the pane: the label in bold, any `after` spans, then a line filling the rest of
 * the row (label, spans and line, a space between each, = `width`), all in `color`.
 */
function paneRule(v: PaneView, label: string, color: string, after: readonly RuleSpan[] = []): RenderElement {
  const { Text } = v.ui
  const used = after.reduce((n, s) => n + 1 + s.text.length, label.length)
  return (
    <Text wrap="truncate-end">
      <Text bold color={color}>
        {label}
      </Text>
      {after.map(s => (
        <Text key={s.text} bold={s.isDim !== true} dimColor={s.isDim === true} color={s.isDim === true ? undefined : (s.color ?? color)}>
          {` ${s.text}`}
        </Text>
      ))}
      <Text color={color}>{` ${'─'.repeat(Math.max(0, v.width - used - 1))}`}</Text>
    </Text>
  )
}

/**
 * A section heading, the top of its box: a rounded corner and one dash joining it to the label,
 * then a heading-blue rule. A tab's one section sits a row below the tabs (`isSpaced`); the Hub's
 * boxes stack with nothing between them.
 */
function paneHeading(v: PaneView, label: string, after: readonly RuleSpan[] = [], isSpaced = true): RenderElement {
  const { Box } = v.ui
  return <Box marginTop={isSpaced ? 1 : 0}>{paneRule(v, `╭─ ${label}`, HEADING_HEX, after)}</Box>
}

/** Rows of the line down a box's left edge: more than any section holds, the box clipping the rest. */
const FRAME_ROWS = 200

/**
 * A section's content, the rest of its box: a dimmed heading-blue line down its left edge, so
 * the content outweighs it, the content INDENT columns in past it, and a rounded corner and one
 * dash closing it, as its heading opens it. The line is pinned to the box and clipped by it, so
 * it is exactly as tall as the content without counting rows.
 */
function paneSection(v: PaneView, content: RenderElement): RenderElement {
  const { Box, Text } = v.ui
  return (
    <Box flexDirection="column">
      <Box position="relative" overflow="hidden" flexDirection="column" paddingLeft={INDENT}>
        <Box position="absolute" top={0} left={0}>
          <Text color={HEADING_HEX} dimColor>
            {'│\n'.repeat(FRAME_ROWS)}
          </Text>
        </Box>
        {content}
      </Box>
      <Text color={HEADING_HEX}>╰─</Text>
    </Box>
  )
}

/** How long ago `at` (epoch ms) was by the ticking clock, as `5m ago`; never negative. */
function paneAgo(v: PaneView, at: number): string {
  return `${formatSpan(Math.max(0, v.liveNow - at))} ago`
}

/**
 * The tab buttons, Procs with a red count beside it while any process is stale. Switching to a
 * tab that polls freshens it at once, without waiting for the next timer; the tab change itself
 * does not wait on either.
 */
function renderTabBar($: EngineInterface, v: PaneView): RenderElement {
  const { Box, Button, Text } = v.ui
  // A button draws in no colour of its own: the stale count beside Procs carries the red.
  const stale = v.procs.list.filter(p => isStale(p, v.liveNow)).length
  return (
    <Box flexDirection="row" flexWrap="wrap">
      {TABS.map(([id, label, key]) => (
        <Box key={id} marginRight={1}>
          <Button
            key={`tab-${id}`}
            label={label}
            hotkey={key}
            variant={v.tab === id ? 'primary' : 'secondary'}
            dimColor={v.tab !== id}
            onPress={() => {
              if (id === 'procs') void refreshProcs($, PROCS_EVERY_MS - 5_000)
              if (id === 'hub') void refreshGit($)
              if (id === 'commits') void readCommits($)
              return update($, tabAtom, () => id)
            }}
          />
          {id === 'procs' && stale > 0 && <Text key="procs-stale" color="#f85149">{` ●${stale}`}</Text>}
        </Box>
      ))}
    </Box>
  )
}

/**
 * The digest under the tabs: the cache, the reply in flight and the skills fired, each in its
 * color. Processes are the Procs tab's, which turns red when any is stale. On the Hub the cache
 * is left to the dispatcher's band.
 */
function renderDigest(v: PaneView): RenderElement {
  const { Box, Text } = v.ui
  const sum = summarize(v.cache, v.flight, v.procs, v.liveNow)
  const skills = summarizeSkills(v.skills)
  const isHub = v.tab === 'hub'
  return (
    <Text wrap="truncate-end">
      {!isHub && <Text color={sum.cacheHex}>{sum.cache}</Text>}
      {!isHub && <Text dimColor> │ </Text>}
      <Text color={sum.flightHex}>{sum.flight}</Text>
      <Text dimColor> │ </Text>
      <Text color={skills.hex}>{skills.text}</Text>
    </Text>
  )
}

/** Whether now is a good moment to compact: nothing running or failing, the tree committed. */
function atBreakpoint(v: PaneView): boolean {
  const { flight, git, meta } = v
  return isBreakpoint({
    isRunning: flight.startedAt > 0 && flight.endedAt === undefined,
    hadErrors: flight.calls.some(c => c.isError),
    isTreeClean: git.isRepo && git.files.length === 0,
    committedRecently: meta.committedAt > 0 && v.liveNow - meta.committedAt < 15 * 60_000,
  })
}

/**
 * Beside the mascot, the conductor's words: her name and her mood line on one row, the 5-hour
 * window's forecast in words under it (once there is a 5-hour limit), then the two trend bars,
 * all within her height; what to do about it is the dispatcher's, on the band atop the line. Her
 * text column is what the mascot and its 2-column margin leave (at least 12); the trend Raster
 * gives 4 columns to the `ctx`/`5h` labels and their margin, and caps at 48.
 */
function renderAriaText(v: PaneView, assessment: Assessment): RenderElement {
  const { Box, Text } = v.ui
  const { history, isTerminal, Raster } = v
  const { mood, forecast } = assessment
  const trendColumns = Math.max(6, Math.min(48, ariaColumn(v) - 4))
  const hasFive = v.usage.limits.some(l => l.kind === 'five_hour')
  // Running out is the dispatcher's colours: red within the hour, amber later; any other pace is quiet.
  const forecastHex = forecast.kind !== 'hits' ? undefined : forecast.ms <= 60 * 60_000 ? '#f85149' : '#d29922'
  return (
    <Box flexDirection="column">
      <Box key="aria-mood">
        <Text wrap="truncate-end">
          <Text bold color={MOOD_HEX[mood]}>
            ARIA
          </Text>
          <Text dimColor> · </Text>
          <Text color={MOOD_HEX[mood]}>{moodLine(mood)}</Text>
        </Text>
      </Box>
      {hasFive && (
        <Box key="aria-forecast">
          <Text color={forecastHex} dimColor={forecastHex === undefined} wrap="truncate-end">
            {forecastLine(forecast)}
          </Text>
        </Box>
      )}
      {/* Trend bars need two samples to draw a line, and a Raster, which only the terminal has. */}
      {isTerminal && history.length >= 2 && Raster !== undefined && (
        <Box flexDirection="row">
          <Box flexDirection="column" marginRight={1}>
            <Text dimColor>ctx</Text>
            <Text dimColor>5h</Text>
          </Box>
          <Raster key="trend" columns={trendColumns} rows={2} cells={trendCells(history, trendColumns)} />
        </Box>
      )}
    </Box>
  )
}

/** The columns beside ARIA's head: what the head and its 2-column margin leave, at least 12. */
function ariaColumn(v: PaneView): number {
  return Math.max(12, v.inner - ARIA_COLUMNS - 2)
}

/**
 * ARIA, the line's conductor: a mascot whose mood is the session's health. Her head starts on
 * the legend's row, the legend flush right beside it, and her words come a row under the legend;
 * off the terminal, the legend flush right across the row and her words under it. `legend` draws
 * the legend in the columns it is given.
 */
function renderAria(v: PaneView, assessment: Assessment, legend: (columns: number) => RenderElement): RenderElement {
  const { Box } = v.ui
  const { Raster } = v
  const isDrawn = v.isTerminal && Raster !== undefined
  const columns = isDrawn ? ariaColumn(v) : v.inner
  const beside = (
    <Box flexDirection="column" marginLeft={isDrawn ? 2 : 0} width={columns}>
      {legend(columns)}
      <Box marginTop={1}>{renderAriaText(v, assessment)}</Box>
    </Box>
  )
  if (!isDrawn) return beside
  return (
    <Box flexDirection="row">
      <Raster key="aria" columns={ARIA_COLUMNS} rows={ARIA_ROWS} cells={ariaCells(assessment.mood)} />
      {beside}
    </Box>
  )
}

/**
 * What's new, the sidebar's view without a tab button: the changes in the installed version (or
 * every one since, when a newer one is out) worth this person's while, as a fork of the
 * conversation picked them, then Read again and Back to the Hub.
 */
function renderNews($: EngineInterface, v: PaneView): RenderElement {
  const { Box, Text, Button } = v.ui
  const notes = v.release
  const isUpdate = notes.versions.includes('→')
  return (
    <Box flexDirection="column">
      <Text bold color={VERSION_HEX} wrap="wrap">
        {isUpdate ? `What an update to ${notes.versions.split('→ ')[1]} brings` : `What's new in ${notes.versions}`}
      </Text>
      <Text dimColor wrap="wrap">
        {isUpdate ? `Every release since ${notes.versions.split(' →')[0]}, ` : 'From the changelog, '}
        only what looks like it matters to you.
      </Text>
      {notes.status === 'reading' && (
        <Box marginTop={1}>
          <Text color="#d29922" wrap="wrap">Reading the release notes… (nothing is added to the conversation)</Text>
        </Box>
      )}
      {notes.status === 'error' && (
        <Box marginTop={1}>
          <Text color="#f85149" wrap="wrap">
            {notes.error}
          </Text>
        </Box>
      )}
      {notes.status === 'ready' && notes.sections.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">Nothing in these notes looks like it matters to you.</Text>
        </Box>
      )}
      {notes.sections.map(section => (
        <Box key={`v-${section.version}`} flexDirection="column" marginTop={1}>
          <Text bold color={LINE_HEX}>
            {section.version}
          </Text>
          {section.items.map((item, i) => (
            <Text key={`v-${section.version}-${i}`} wrap="wrap">
              <Text color={LINE_HEX}>• </Text>
              {item}
            </Text>
          ))}
        </Box>
      ))}
      <Box flexDirection="row" marginTop={1}>
        {notes.status !== 'reading' && (
          <Box marginRight={1}>
            <Button key="release-again" label="Read again" hotkey="r" onPress={() => showReleaseNotes($, true)} />
          </Box>
        )}
        <Button key="release-back" label="Back" hotkey="b" onPress={() => update($, tabAtom, (): HudTab => 'hub')} />
      </Box>
    </Box>
  )
}

/**
 * The CLAUDE station: its label, then the installed version, a button that opens what is new in
 * it, and, when npm has a newer one on this channel, that version in red, a button that opens
 * what an update to it brings. Nothing after the label while the version is unknown.
 */
function renderClaudeStation($: EngineInterface, v: PaneView): RenderElement {
  const { Box, Text, Button } = v.ui
  const { meta } = v
  const isOutdated = meta.version !== '' && meta.latest !== '' && compareVersions(meta.latest, meta.version) > 0
  return (
    <Box key="claude-station">
      <Text wrap="truncate-end">
        <Text color={LINE_HEX}> ○━ </Text>
        <Text bold>CLAUDE </Text>
      </Text>
      {meta.version !== '' && (
        <Button
          key="claude-version"
          label={meta.version}
          plain
          hover={{ color: VERSION_HEX, underline: true }}
          onPress={() => void showReleaseNotes($)}
        />
      )}
      {isOutdated && (
        <Button key="claude-latest" label={`→ ${meta.latest} out`} plain hover={{ underline: true }} onPress={() => void showReleaseNotes($)}>
          <Text color="#f85149">{` → ${meta.latest} out`}</Text>
        </Button>
      )}
    </Box>
  )
}

/** Puts the session id on the clipboard of the surface the click came from, and toasts whether it took. */
async function copySessionId($: EngineInterface, id: string, surface: RenderSurface): Promise<void> {
  const copied = await $.ui.copy({ text: id, surface })
  $.ui.toast(copied.isCopied ? 'Session id copied' : `Could not copy the session id (${copied.reason})`)
}

/**
 * Puts `command`, a space and `name` in the prompt box, the cursor after them, for the name to
 * be typed or changed before it is sent: `/rename` to rename the session, `/rc` to start Remote
 * Control under one. A draft already typed is kept: the toast says to clear it first, in
 * `purpose`'s words, rather than overwrite it.
 */
async function fillCommand($: EngineInterface, command: string, purpose: string, name = ''): Promise<void> {
  const { text } = await $.prompt.read()
  if (text.trim() !== '' && !text.startsWith(command)) {
    $.ui.toast(`Clear the prompt to ${purpose}`)
    return
  }
  const filled = await $.prompt.fill({ text: `${command} ${name}`, mode: 'replace' })
  if (!filled.isFilled) $.ui.toast(`Could not reach the prompt: type ${command} to ${purpose}`)
}

/**
 * The session's station: its name (or SESSION before it has one), which puts `/rename ` in the
 * prompt box when clicked.
 */
function renderSessionStation($: EngineInterface, v: PaneView): RenderElement {
  const { Box, Text, Button } = v.ui
  const name = v.meta.name || 'SESSION'
  // A button draws its label whole: a name too long for the row is cut here, as a station's would be.
  const room = v.width - RIGHT_PAD - TRACK_INDENT
  const label = name.length <= room ? name : `${name.slice(0, room - 1).trimEnd()}…`
  return (
    <Box key="session-station">
      <Text color={LINE_HEX}> ○━ </Text>
      <Button key="session-name" label={label} plain onPress={() => void fillCommand($, '/rename', 'rename the session')} />
    </Box>
  )
}

/**
 * The session's stop on the line, under its station (its name): its whole id, drawn as dim text
 * that copies it when clicked, for `claude --resume`; a green light for Remote Control when on
 * (the station is the name claude.ai lists it under), or a red one with a button that puts
 * `/rc <name>-RC` in the prompt box to start it, the name there to change; then time since it
 * started, prompts and cost.
 */
function renderSession($: EngineInterface, v: PaneView): RenderElement {
  const { Box, Text, Button } = v.ui
  const { meta, usage, now } = v
  const elapsed = meta.startedAt > 0 && now > 0 ? formatSpan(now - meta.startedAt) : '…'
  return (
    <Box flexDirection="column">
      {meta.id !== '' && (
        <Button key="session-id" label={meta.id} plain dimColor onPress={press => void copySessionId($, meta.id, press.surface)} />
      )}
      {(meta.remote ?? '') !== '' ? (
        <Text wrap="truncate-end">
          <Text color="#3fb950">● </Text>
          <Text>Remote Control</Text>
        </Text>
      ) : (
        <Box>
          <Text color="#f85149">● </Text>
          <Button key="start-remote" label="Start remote control" plain onPress={() => void fillCommand($, '/rc', 'start Remote Control', meta.name === '' ? '' : `${meta.name}-RC`)} />
        </Box>
      )}
      <Text wrap="truncate-end">
        <Text dimColor>
          {elapsed} · {meta.turns} prompts
        </Text>
        {usage.costUsd !== undefined && (
          <Text>
            <Text dimColor> · </Text>
            <Text color="#d29922">${usage.costUsd.toFixed(2)}</Text>
          </Text>
        )}
      </Text>
    </Box>
  )
}

/** The line's colour: its track, its stations' glyphs, its band and the departures board. */
const LINE_HEX = '#e3b341'

/** Columns from the pane's edge to what rides the track: the glyph's column, then the track and its margin. */
const TRACK_INDENT = 4

/** Columns kept clear at the pane's right edge by anything set flush right, so it never touches the border. */
const RIGHT_PAD = 2

/**
 * A station on the line, one row: its glyph on the track and a spur to its name (`spans`, bold
 * unless dim). Cut at the edge, not wrapped.
 */
function station(v: PaneView, glyph: string, spans: readonly RuleSpan[]): RenderElement {
  const { Text } = v.ui
  return (
    <Text wrap="truncate-end">
      <Text color={LINE_HEX}>{` ${glyph}━ `}</Text>
      {spans.map(s => (
        <Text key={s.text} bold={s.isDim !== true} dimColor={s.isDim === true} color={s.isDim === true ? undefined : s.color}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

/**
 * The track between two stations, with what rides it TRACK_INDENT columns in and a blank row
 * before the next station. Like a box's edge, the track is pinned to the segment and clipped by
 * it, so it is exactly as tall as what rides it.
 */
function segment(v: PaneView, content: RenderElement): RenderElement {
  const { Box, Text } = v.ui
  return (
    <Box position="relative" overflow="hidden" flexDirection="column" paddingLeft={TRACK_INDENT}>
      <Box position="absolute" top={0} left={1}>
        <Text color={LINE_HEX}>{'┃\n'.repeat(FRAME_ROWS)}</Text>
      </Box>
      {content}
      <Text> </Text>
    </Box>
  )
}

/** What the dispatcher weighs, read off the pane: the forecasts, the cache, git, the processes and the release. */
function dispatchInput(v: PaneView, assessment: Assessment): DispatchInput {
  const { usage, git, meta, cache, flight, liveNow } = v
  const { forecast } = assessment
  const five = usage.limits.find(l => l.kind === 'five_hour')
  const last = cache.at(-1)
  const leftMs = cacheWarmth(cache, liveNow) * CACHE_TTL_MS
  const stale = v.procs.list.filter(p => isStale(p, liveNow))
  return {
    limit: forecast.kind === 'hits' ? { ms: forecast.ms, resetsInMs: five?.resetsAt === undefined ? undefined : Date.parse(five.resetsAt) - v.now } : undefined,
    cache: last !== undefined && !isReplying(flight) && leftMs > 0 ? { leftMs, tokens: last.read + last.write } : undefined,
    advice: adviceFor(assessment.zone, atBreakpoint(v), usage.tokens ?? 0),
    uncommitted: git.isRepo ? { files: git.files.length, lines: git.linesAdded + git.linesRemoved } : { files: 0, lines: 0 },
    stale: { count: stale.length, memMb: stale.reduce((mb, p) => mb + p.memMb, 0) },
    update: meta.version !== '' && meta.latest !== '' && compareVersions(meta.latest, meta.version) > 0 ? meta.latest : '',
  }
}

/** The word on a dispatch's button, short enough to sit beside its words in a sidebar. */
const ACTION_LABEL: Record<DispatchAction, string> = { prep: '[Prep]', procs: '[Procs]', read: '[Read]' }

/** The button's key: Prep compact's is the one ARIA's advice button had. */
const ACTION_KEY: Record<DispatchAction, string> = { prep: 'prep-compact', procs: 'dispatch-procs', read: 'dispatch-read' }

/** Does what a dispatch's button says: drafts a compaction, shows the Procs tab, or opens what is new. */
function act($: EngineInterface, action: DispatchAction): void {
  if (action === 'prep') void startDraft($)
  else if (action === 'procs') void update($, tabAtom, (): HudTab => 'procs')
  else void showReleaseNotes($)
}

/**
 * The dispatcher, the band atop the line: the most urgent of the session's dispatches, cut to
 * the row with its button and, when more are waiting, `+N`, which steps to the next, flush
 * right RIGHT_PAD short of the edge.
 */
function renderBand($: EngineInterface, v: PaneView, assessment: Assessment): RenderElement {
  const { Box, Text, Button } = v.ui
  const list = dispatches(dispatchInput(v, assessment))
  const shown = list[v.dispatch % list.length]!
  const label = shown.action === undefined ? '' : ACTION_LABEL[shown.action]
  const count = list.length > 1 ? `+${list.length - 1}` : ''
  const tail = [label, count].filter(s => s !== '').join(' ')
  // The marker takes two columns; the tail keeps a space before it.
  const room = v.width - RIGHT_PAD - 2 - (tail === '' ? 0 : tail.length + 1)
  const text = shown.text.length <= room ? shown.text : `${shown.text.slice(0, Math.max(0, room - 1)).trimEnd()}…`
  const rule = '━'.repeat(v.width)
  return (
    <Box key="band" flexDirection="column" marginBottom={1}>
      <Text color={LINE_HEX}>{rule}</Text>
      <Box key="dispatch">
        <Text wrap="truncate-end">
          <Text color={LINE_HEX}>▸ </Text>
          <Text color={shown.hex}>{text}</Text>
          {tail === '' ? '' : ' '.repeat(Math.max(1, room - text.length + 1))}
        </Text>
        {shown.action !== undefined && (
          <Button key={ACTION_KEY[shown.action]} label={label} plain onPress={() => act($, shown.action!)} />
        )}
        {label !== '' && count !== '' && <Text> </Text>}
        {count !== '' && <Button key="dispatch-next" label={count} plain dimColor onPress={() => void update($, dispatchAtom, n => n + 1)} />}
      </Box>
      <Text color={LINE_HEX}>{rule}</Text>
    </Box>
  )
}

/**
 * Each rate limit on a row of its own: its short name, a 10-cell meter, its share, and when it
 * resets; or a word that there is no reading yet.
 */
function renderLimits(v: PaneView): RenderElement {
  const { Box, Text } = v.ui
  const { usage } = v
  if (usage.limits.length === 0) return <Text dimColor>No limit reading yet.</Text>
  return (
    <Box flexDirection="column">
      {usage.limits.map(l => {
        const b = bar(l.percentUsed, 10)
        return (
          <Text key={l.kind} wrap="truncate-end">
            {`${limitName(l.kind)} `}
            <Text color={limitColor(l.percentUsed)}>{'▰'.repeat(b.full.length)}</Text>
            <Text dimColor>{'▱'.repeat(b.empty.length)}</Text>
            <Text bold>{` ${String(l.percentUsed).padStart(3)}%`}</Text>
            {l.resetsAt !== undefined && <Text dimColor>{`  ↻ ${formatSpan(Date.parse(l.resetsAt) - v.now)}`}</Text>}
          </Text>
        )
      })}
    </Box>
  )
}

/**
 * The model and the effort it runs at, then the rate limits: what rides the track from the
 * CLAUDE station. Each is a button that puts `/model` or `/effort` in the prompt box to change
 * it; a button has no colour at rest, so the effort shows its rank's colour under the pointer.
 */
function renderClaude($: EngineInterface, v: PaneView): RenderElement {
  const { Box, Text, Button } = v.ui
  // A level without a rank of its own (default, or one this HUD does not know) stays plain.
  const effortHex = effortSpans(v.meta.effort)[0]!.hex
  return (
    <Box flexDirection="column">
      <Box key="claude-model-row">
        <Button
          key="claude-model"
          label={v.meta.model || '…'}
          plain
          hover={{ underline: true }}
          onPress={() => void fillCommand($, '/model', 'change the model')}
        />
        <Text dimColor> · </Text>
        <Button
          key="claude-effort"
          label={v.meta.effort || 'default'}
          plain
          hover={effortHex === undefined ? { underline: true } : { color: effortHex, underline: true }}
          onPress={() => void fillCommand($, '/effort', 'change the effort')}
        />
      </Box>
      {renderLimits(v)}
    </Box>
  )
}

/**
 * Git as a loop off the line: the branch a station on its own track, with its upstream and how
 * far apart, then the file counts (renames count as modified, untracked files as added) and the
 * lines; outside a repository, a station saying so.
 */
function renderGitLoop(v: PaneView): RenderElement {
  const { Box, Text } = v.ui
  const { git } = v
  if (!git.isRepo) return station(v, '○', [{ text: 'not a git repository', isDim: true }])
  const modified = git.files.filter(f => f.code === 'M' || f.code === 'R').length
  const added = git.files.filter(f => f.code === 'A' || f.code === '?').length
  const deleted = git.files.filter(f => f.code === 'D').length
  return (
    <Box flexDirection="column">
      <Text color={LINE_HEX}> ┣━━━━━━━╮</Text>
      <Text wrap="truncate-end">
        <Text color={LINE_HEX}> ┃       ○ </Text>
        <Text color="#58a6ff" bold>
          {git.branch}
        </Text>
        {git.upstream !== null && <Text dimColor> → {git.upstream}</Text>}
        {git.ahead > 0 && <Text color="#3fb950"> ↑{git.ahead}</Text>}
        {git.behind > 0 && <Text color="#f85149"> ↓{git.behind}</Text>}
      </Text>
      <Text wrap="truncate-end">
        <Text color={LINE_HEX}> ┃       ┃ </Text>
        <Text color={CODE_COLOR.M}>~{modified} </Text>
        <Text color={CODE_COLOR.A}>+{added} </Text>
        <Text color={CODE_COLOR.D}>-{deleted}</Text>
        <Text dimColor> · </Text>
        <Text color="#3fb950">+{git.linesAdded} </Text>
        <Text color="#f85149">-{git.linesRemoved}</Text>
      </Text>
      <Text color={LINE_HEX}> ┣━━━━━━━╯</Text>
    </Box>
  )
}

/** How a label on a row of the curled track is drawn. */
type LabelStyle = { color?: string; bold?: boolean; dimColor?: boolean }

/**
 * A row under or over the curled track: `lead` in its first two columns (the line, or blank),
 * then `labels` at their columns counted from the track's first cell, blanks between.
 */
function curlRow(v: PaneView, key: string, lead: RenderElement, labels: readonly RowLabel[], styleOf: (l: RowLabel) => LabelStyle): RenderElement {
  const { Box, Text } = v.ui
  const gaps = labels.map((l, i) => l.start - (i === 0 ? 0 : labels[i - 1]!.start + labels[i - 1]!.text.length))
  return (
    <Box key={key}>
      <Text wrap="truncate-end">
        {lead}
        {labels.flatMap((l, i) => [
          ' '.repeat(gaps[i]!),
          <Text key={l.key} {...styleOf(l)}>
            {l.text}
          </Text>,
        ])}
      </Text>
    </Box>
  )
}

/**
 * Where the curled track puts the context: the percent and the tokens it compacts at (`end`),
 * the cells the track spans (the corner sits under the line at column 1, the cells run from
 * column 2 to RIGHT_PAD short of the edge), and the cell the marker stands on.
 */
function curlPlace(v: PaneView): { compactAt: number; end: number; span: number; here: number } {
  const { usage } = v
  const compactAt = usage.compactAt ?? COMPACT_TARGET
  const end = usage.compactAtTokens ?? Math.round((compactAt / 100) * usage.window)
  const span = Math.max(2, v.width - RIGHT_PAD - 2)
  return { compactAt, end, span, here: trackCell(usage.tokens ?? 0, end, span) }
}

/**
 * The context's one colour, wherever it is drawn: the zone of the cell the marker stands on,
 * green, amber or red. Undefined before there is a reading.
 */
function contextTone(v: PaneView): string | undefined {
  if (v.usage.percent === undefined) return undefined
  const { span, here } = curlPlace(v)
  return zoneHex(here, span)
}

/**
 * The context's stretch, curled off the line under git and across the pane: a row naming
 * CONTEXT at its start and COMPACT over its end, a row with `▼` and the reading over YOU ARE
 * HERE, then the track from 0 by the corner to the terminus `◎` RIGHT_PAD short of the edge,
 * solid up to the marker `◆` and dotted after, the stops ticked on it where their tokens fall;
 * under it each stop's tokens, and how many turns off each stop ahead is once there is a
 * forecast. The marker slides right as the context fills, so nothing above or below it moves.
 * Under the track, where labels would touch, the terminus and 0 keep theirs over the stops'.
 */
function renderCurl(v: PaneView): RenderElement {
  const { Box, Text } = v.ui
  const { usage } = v
  const { compactAt, end, span, here } = curlPlace(v)
  const stops = trackStops(usage.tokens, end)
  const isPast = (usage.percent ?? 0) >= compactAt
  const reading = usage.tokens === undefined ? 'no reading' : `${formatTokens(usage.tokens)}/${formatTokens(usage.window)} · ${usage.percent ?? 0}%`
  // The marker and its reading take the colour of the zone the marker stands in.
  const tone = contextTone(v) ?? LINE_HEX
  const cellOf = (tokens: number) => trackCell(tokens, end, span)
  const passedAt = new Set(stops.passed.map(cellOf))
  const aheadAt = new Set(stops.ahead.map(cellOf))
  const cells = (from: number, to: number, line: string, tick: string, ticks: Set<number>) =>
    Array.from({ length: Math.max(0, to - from) }, (_, i) => (ticks.has(from + i) ? tick : line)).join('')

  // The marker's words read rightward from it until it is past the middle of the track, then
  // leftward, over the way travelled and clear of the terminus; either way where the other has
  // no room, or it is a bare ▼.
  const rightward: RowLabel = { key: 'here', start: here, text: `▼ ${reading}` }
  const leftward: RowLabel = { key: 'here', start: here - reading.length - 1, text: `${reading} ▼` }
  const marker = fitRow(span, [[...(here > (span - 1) / 2 ? [leftward, rightward] : [rightward, leftward]), { key: 'here', start: here, text: '▼' }]])

  // Labels under the track only once there is a window to put them on.
  const endLabel = formatTokens(end)
  const centred = (key: string, cell: number, text: string): RowLabel[] => [{ key, start: cell - Math.floor(text.length / 2), text }]
  const tokenRow =
    end > 0
      ? fitRow(span, [
          [{ key: 'end', start: span - endLabel.length, text: endLabel }],
          [{ key: 'zero', start: 0, text: '0' }],
          ...[...stops.passed, ...stops.ahead].map(s => centred(`stop-${s}`, cellOf(s), formatTokens(s))),
        ])
      : []
  const turnsTo = (tokens: number) => (usage.window > 0 ? turnsToCompact(v.history, (tokens / usage.window) * 100) : undefined)
  const endTurns = isPast ? undefined : turnsTo(end)
  const turnsRow =
    end > 0
      ? fitRow(span, [
          ...(endTurns === undefined || endTurns === 0 ? [] : [[{ key: 'end', start: span - `≈${endTurns}`.length, text: `≈${endTurns}` }]]),
          ...stops.ahead.flatMap(s => {
            const turns = turnsTo(s)
            return turns === undefined || turns === 0 ? [] : [centred(`stop-${s}`, cellOf(s), `≈${turns}`)]
          }),
        ])
      : []
  const passedStops = new Set(stops.passed.map(s => `stop-${s}`))
  const tokenStyle = (l: RowLabel): LabelStyle => ({ dimColor: l.key === 'zero' || passedStops.has(l.key) })
  const isOnTerminus = here === span - 1
  return (
    <Box key="curl" flexDirection="column">
      <Box key="curl-names">
        <Text wrap="truncate-end">
          <Text color={LINE_HEX}> ┃ </Text>
          <Text bold>CONTEXT</Text>
          {' '.repeat(Math.max(1, span - 1 - 2 * 'COMPACT'.length))}
          <Text bold color={isPast ? '#f85149' : undefined}>
            COMPACT
          </Text>
        </Text>
      </Box>
      {curlRow(v, 'curl-marker', <Text color={LINE_HEX}> ┃</Text>, marker, () => ({ bold: true, color: tone }))}
      <Box key="curl-track">
        <Text wrap="truncate-end">
          <Text color={LINE_HEX}> ╰</Text>
          {zoneRuns(0, here, span).map(r => (
            <Text key={`passed-${r.from}`} color={r.hex}>
              {cells(r.from, r.to, '━', '┯', passedAt)}
            </Text>
          ))}
          <Text color={isPast ? '#f85149' : tone}>◆</Text>
          {zoneRuns(here + 1, span - 1, span).map(r => (
            <Text key={`ahead-${r.from}`} color={r.hex} dimColor>
              {cells(r.from, r.to, '┄', '┬', aheadAt)}
            </Text>
          ))}
          {!isOnTerminus && <Text color="#f85149">◎</Text>}
        </Text>
      </Box>
      {tokenRow.length > 0 && curlRow(v, 'curl-tokens', <Text>{'  '}</Text>, tokenRow, tokenStyle)}
      {turnsRow.length > 0 && curlRow(v, 'curl-turns', <Text>{'  '}</Text>, turnsRow, () => ({ dimColor: true }))}
    </Box>
  )
}

/** The grey of the train's loaded walls, its floor and its wheels. */
const TRAIN_GREY = '#8b949e'

/** The engine's blocks: a red cab, a steel-grey boiler with its chimney rising off it, and an amber lamp at the nose. */
const ENGINE: ReadonlyArray<readonly [string, string]> = [
  ['▐', '#f85149'],
  ['█', '#f85149'],
  ['▄', TRAIN_GREY],
  ['▙', TRAIN_GREY],
  ['▖', LINE_HEX],
]

/**
 * The context as a train, the engine at its head on the right: each car an open bin, an equal
 * share of the window, loaded from the back in the categories' patterns in `tone` (the marker's
 * zone), a grey floor where nothing is loaded yet; a loaded car's walls grey, an
 * empty one's dim. The coupler in front of the car that holds the compaction point is red, but
 * never the engine's: when that car is the last, its walls are red instead. The wheels, hollow,
 * have the row under it to themselves, and the rail runs the row under them.
 */
function renderTrain(v: PaneView, tone: string, weights: readonly number[]): RenderElement {
  const { Box, Text } = v.ui
  const { usage } = v
  const train = trainCars(usage.percent ?? 0, v.inner, weights, usage.compactAt ?? COMPACT_TARGET)
  const lastCar = train.cars.length - 1
  // A wheel a cell in from each wall, and none under the coupler.
  const wheels = ` ○${' '.repeat(CAR_CARGO - 2)}○  `
  return (
    <Box key="context-bar" flexDirection="column">
      <Text wrap="truncate-end">
        {train.cars.map((cargo, i) => {
          const loaded = cargo.replaceAll('·', '')
          const isEmpty = loaded === ''
          const isMarked = i === train.compactCar
          const wall = { color: isMarked && i === lastCar ? '#f85149' : isEmpty ? LINE_HEX : TRAIN_GREY, dimColor: isEmpty && !(isMarked && i === lastCar) }
          return (
            <Text key={`car-${i}`}>
              <Text {...wall}>▐</Text>
              <Text color={tone}>{loaded}</Text>
              <Text color={TRAIN_GREY}>{'▁'.repeat(cargo.length - loaded.length)}</Text>
              <Text {...wall}>▌</Text>
              <Text color={isMarked && i < lastCar ? '#f85149' : LINE_HEX}>━</Text>
            </Text>
          )
        })}
        {ENGINE.map(([block, color], i) => (
          <Text key={`engine-${i}`} color={color}>
            {block}
          </Text>
        ))}
      </Text>
      <Text color={TRAIN_GREY}>{`${wheels.repeat(train.cars.length)} ○ ○`}</Text>
      {/* The rail: drawn at the very top of its row, so it runs just under the wheels. */}
      <Text color={TRAIN_GREY}>{'▔'.repeat(v.inner)}</Text>
    </Box>
  )
}

/**
 * Under the curled track, in one place however full the context is: the context as a train,
 * the categories' legend, and ARIA as conductor.
 */
function renderContext($: EngineInterface, v: PaneView, assessment: Assessment): RenderElement {
  const { Box, Text } = v.ui
  const { usage } = v
  // The train and the legend in the marker's colour, so the context reads in one scale.
  const tone = contextTone(v) ?? TRAIN_GREY
  const parts = legendParts(usage.parts ?? [])
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      {renderTrain(v, tone, parts.map(p => p.tokens))}
      {renderAria(v, assessment, columns => (
        // Flush right, ending under the train's engine; a blank row while there is nothing to name.
        <Box key="legend" width={columns} justifyContent="flex-end">
          <Text wrap="truncate-end">
            {legendLabels(parts, columns).map((label, i) => (
              <Text key={parts[i]!.name}>
                {i > 0 ? ' ' : ''}
                <Text color={tone}>{PART_PATTERNS[i]}</Text>
                {label}
              </Text>
            ))}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

/**
 * The operator's plate under the line, a row apart from ARIA: a framed badge, centred, with the
 * HUD's name in bold and its version in its own colour, so after an update it is plain which
 * HUD is drawing. When its marketplace lists a newer one, a row under it says
 * which, in red, with a button that upgrades to it.
 */
function renderPlate($: EngineInterface, v: PaneView): RenderElement {
  const { Box, Text, Button } = v.ui
  const hudVersion = v.meta.hudVersion ?? ''
  const hudLatest = v.meta.hudLatest ?? ''
  const isOutdated = hudVersion !== '' && hudLatest !== '' && compareVersions(hudLatest, hudVersion) > 0
  const name = `${$.plugin.name}${hudVersion === '' ? '' : ` ${hudVersion}`}`
  // ` ◆ name version · transit `, the word dropped where the frame would not fit the pane.
  const isWordy = name.length + 16 <= v.width
  const inside = 4 + name.length + (isWordy ? 10 : 0)
  const rule = '─'.repeat(inside)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box key="plate" width={v.width} flexDirection="column" alignItems="center">
        <Text dimColor>{`╭${rule}╮`}</Text>
        <Text wrap="truncate-end">
          <Text dimColor>│ </Text>
          <Text color={LINE_HEX}>◆ </Text>
          <Text bold>{$.plugin.name}</Text>
          {hudVersion !== '' && (
            <Text bold color={VERSION_HEX}>
              {` ${hudVersion}`}
            </Text>
          )}
          {isWordy && <Text dimColor> · transit</Text>}
          <Text dimColor> │</Text>
        </Text>
        <Text dimColor>{`╰${rule}╯`}</Text>
      </Box>
      {isOutdated && (
        <Box key="hud-newer" width={v.width} justifyContent="center">
          <Text color="#f85149">{`${hudLatest} out `}</Text>
          <Button key="hud-upgrade" label="[Upgrade]" plain onPress={() => void upgradeHud($)} />
        </Box>
      )}
    </Box>
  )
}

/**
 * The Hub tab, a transit line: a band with the runway, then stations down one track from the
 * working dir (its origin), Claude (its version, model and limits), the session, git as a loop
 * off the line, then the context's stretch curling off under it and across the pane, from 0 to
 * the COMPACT terminus, YOU ARE HERE sliding along it as the context fills. Under the curl, in a
 * place of their own, the context bar and ARIA, the conductor.
 * The operator's plate closes the line, when there is a name to show.
 */
function renderHub($: EngineInterface, v: PaneView): RenderElement {
  const { Box, Text } = v.ui
  const { meta, usage } = v
  // Whatever rides the track has the columns the track leaves.
  const hv: PaneView = { ...v, inner: v.width - TRACK_INDENT }
  // Under the curl the bar spans the track, from its corner to its terminus.
  const cv: PaneView = { ...v, inner: v.width - RIGHT_PAD - 1 }
  const assessment = assess(usage, v.history, v.now)
  const { head, tail } = dirParts(tildePath(meta.cwd, meta.home ?? ''))
  return (
    <Box flexDirection="column">
      {renderBand($, v, assessment)}
      {station(v, '◉', [{ text: tail || '…' }])}
      {head !== '' &&
        segment(
          hv,
          <Text dimColor wrap="truncate-start">
            {head}
          </Text>,
        )}
      {renderClaudeStation($, v)}
      {segment(hv, renderClaude($, hv))}
      {renderSessionStation($, v)}
      {segment(hv, renderSession($, hv))}
      {renderGitLoop(v)}
      {renderCurl(v)}
      {renderContext($, cv, assessment)}
      {$.plugin.name !== '' && renderPlate($, v)}
    </Box>
  )
}

/** The color of the cache's warm/cold line: grey once lapsed, amber in the cache's last quarter, blue while warm. */
function warmthLineHex(warmth: number): string {
  if (warmth === 0) return '#8b949e'
  return warmth < 0.25 ? '#d29922' : '#79c0ff'
}

/**
 * What the last reply took from the cache: its share of the reply's input, of how much; red
 * when a large input was served nothing (the cache had lapsed, or the prompt above it changed).
 */
function renderCacheLastTurn(v: PaneView, lastTurn: HudCacheTurn): RenderElement {
  const { Text } = v.ui
  if (lastTurn.read === 0 && lastTurn.total > 20_000) {
    return (
      <Text color="#f85149" wrap="wrap">
        last reply · nothing from cache: it had lapsed, or the prompt changed
      </Text>
    )
  }
  return (
    <Text wrap="truncate-end">
      <Text dimColor>last reply · </Text>
      <Text bold>{Math.round(lastTurn.hit * 100)}%</Text>
      <Text dimColor>{` of ${formatTokens(lastTurn.total)} from cache`}</Text>
    </Text>
  )
}

/**
 * The Turn tab's cache, three rows: how long it stays warm (beside the ice block, on the
 * terminal), what the last reply took from it, and what it took off the session's input bill;
 * then, while one is due, the re-cache a change forced on the next reply.
 */
function renderCache(v: PaneView): RenderElement {
  const { Box, Text } = v.ui
  const { cache, prefix, usage, Raster } = v
  const lastTurn = cache.at(-1)
  const warmth = liveWarmth(cache, v.flight, v.liveNow)
  const totals = cacheTotals(cache)
  return (
    <Box flexDirection="column">
      {paneHeading(v, 'CACHE')}
      {paneSection(
        v,
        <Box flexDirection="column">
          <Box flexDirection="row">
            {Raster !== undefined && (
              <Raster key="ice" columns={ICE_COLUMNS} rows={ICE_ROWS} cells={iceCells(lastTurn === undefined ? 1 : warmth)} />
            )}
            <Box flexDirection="column" marginLeft={Raster !== undefined ? 2 : 0} justifyContent="center">
              {lastTurn === undefined ? (
                <Text dimColor>No reply measured yet</Text>
              ) : (
                <Text bold color={warmthLineHex(warmth)}>
                  {isReplying(v.flight)
                    ? 'warm · kept warm by the reply'
                    : warmth > 0
                      ? `warm · cold in ${formatSpan(warmth * CACHE_TTL_MS)}`
                      : `cold since ${paneAgo(v, lastTurn.at + CACHE_TTL_MS)}`}
                </Text>
              )}
              {lastTurn !== undefined && renderCacheLastTurn(v, lastTurn)}
              {cache.length > 1 && (
                <Text dimColor wrap="wrap">
                  {totals.ratio < 1
                    ? `session · ${Math.round((1 - totals.ratio) * 100)}% off the input bill`
                    : 'session · still paying to fill it'}
                </Text>
              )}
            </Box>
          </Box>
          {prefix.isPending && (
            <Box marginTop={1}>
              <Text color="#d29922" wrap="wrap">
                {`${prefix.reason}: next reply re-caches ${formatTokens(usage.tokens ?? 0)} at ×${CACHE_WRITE_RATE}`}
              </Text>
            </Box>
          )}
        </Box>,
      )}
    </Box>
  )
}

/**
 * Where the branch left its base, atop the Commits tab: how many commits it has made since, in
 * the line's colour, then how many the base has gained since, when it has.
 */
function renderFork(v: PaneView, fork: HudFork): RenderElement {
  const { Box, Text } = v.ui
  return (
    <Box key="fork" flexDirection="column" marginBottom={1}>
      <Text wrap="truncate-end">
        <Text color={LINE_HEX}>⑂ </Text>
        <Text bold>{fork.ahead}</Text>
        {` commit${fork.ahead === 1 ? '' : 's'} since branching from `}
        <Text bold>{fork.base}</Text>
      </Text>
      {fork.behind > 0 && (
        <Text dimColor wrap="truncate-end">
          {`  ${fork.base} has ${fork.behind} new since`}
        </Text>
      )}
    </Box>
  )
}

/**
 * The Commits tab: where the branch left its base, then its last commits, newest first, two
 * rows each: the short hash with the files and lines it changed, then its subject, cut to fit.
 */
function renderCommits(v: PaneView): RenderElement {
  const { Box, Text } = v.ui
  const { git, commits } = v
  const heading = git.isRepo && git.branch !== '' ? `COMMITS · ${git.branch}` : 'COMMITS'
  let body: RenderElement
  if (!git.isRepo) body = <Text dimColor>Not a git repository.</Text>
  else if (commits.list.length === 0) body = <Text dimColor>No commits yet.</Text>
  else
    body = (
      <Box flexDirection="column">
        {commits.fork !== undefined && renderFork(v, commits.fork)}
        {commits.list.map(c => (
          <Box key={c.hash} flexDirection="column">
            <Text wrap="truncate-end">
              <Text bold color="#e3b341">
                {c.hash}
              </Text>
              <Text dimColor>{`  ${c.files} file${c.files === 1 ? '' : 's'}  `}</Text>
              <Text color="#3fb950">+{c.added}</Text>
              <Text dimColor>/</Text>
              <Text color="#f85149">-{c.removed}</Text>
            </Text>
            <Text wrap="truncate-end">{`  ${c.subject}`}</Text>
          </Box>
        ))}
      </Box>
    )
  return (
    <Box flexDirection="column">
      {paneHeading(v, heading)}
      {paneSection(v, body)}
    </Box>
  )
}

/** Each departure's status in its color: boarding amber, arrived green, delayed orange, cancelled red. */
const DEPARTURE_HEX: Record<Departure, string> = {
  BOARDING: '#d29922',
  ARRIVED: '#3fb950',
  DELAYED: '#f0883e',
  CANCELLED: '#f85149',
}

/** A destination cut to fit its column, a column short of it so one space always follows. */
function destination(label: string, columns: number): string {
  return label.length < columns ? label : `${label.slice(0, columns - 2).trimEnd()}…`
}

/**
 * The Turn tab's departures board: the reply's time at the right of its title (running, or
 * the last reply's), then one row per tool call, oldest first: how long it took (so far, while
 * boarding), the tool, what it ran on, and its status. Then how many left and how many failed.
 */
function renderFlight(v: PaneView): RenderElement {
  const { Box, Text } = v.ui
  const { flight } = v
  const rule = <Text color={LINE_HEX}>{'━'.repeat(v.width)}</Text>
  if (flight.startedAt === 0) {
    return (
      <Box flexDirection="column">
        <Text bold color={LINE_HEX}>
          DEPARTURES
        </Text>
        {rule}
        <Text dimColor>No departures yet.</Text>
      </Box>
    )
  }
  const spanEnd = flight.endedAt ?? v.liveNow
  const isRunning = flight.endedAt === undefined
  const clock = `${isRunning ? '▶' : 'last reply'} ${formatSeconds(spanEnd - flight.startedAt)}`
  // Time 7, tool 6 and status 9 columns, the destination the rest, short of the edge by RIGHT_PAD.
  const destColumns = Math.max(8, v.width - RIGHT_PAD - 22)
  const row = (time: string, tool: string, dest: string) => `${time.padEnd(7)}${tool.padEnd(6)}${dest.padEnd(destColumns)}`
  const cancelled = flight.calls.filter(c => c.isError && c.end !== undefined).length
  const count = flight.calls.length
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color={LINE_HEX}>
          DEPARTURES
        </Text>
        <Text bold={isRunning} color={isRunning ? '#f0883e' : undefined} dimColor={!isRunning}>
          {clock.padStart(Math.max(clock.length + 1, v.width - RIGHT_PAD - 10))}
        </Text>
      </Text>
      {rule}
      <Text dimColor wrap="truncate-end">
        {`${row('TIME', 'TOOL', 'DESTINATION')}${'STATUS'.padStart(9)}`}
      </Text>
      {count > MAX_FLIGHT_ROWS && <Text dimColor>… {count - MAX_FLIGHT_ROWS} earlier departures</Text>}
      {flight.calls.slice(-MAX_FLIGHT_ROWS).map(c => {
        const status = departureStatus(c)
        return (
          <Text key={c.id} wrap="truncate-end">
            <Text bold>{formatSeconds((c.end ?? v.liveNow) - c.start).padEnd(7)}</Text>
            <Text color={hex(toolColor(c.tool))}>{shortTool(c.tool).slice(0, 5).padEnd(6)}</Text>
            <Text>{destination(c.label, destColumns).padEnd(destColumns)}</Text>
            <Text color={DEPARTURE_HEX[status]}>{status.padStart(9)}</Text>
          </Text>
        )
      })}
      <Box marginTop={1}>
        <Text dimColor>
          {`${count} departure${count === 1 ? '' : 's'}${cancelled > 0 ? ` · ${cancelled} cancelled` : ''}`}
        </Text>
      </Box>
      {(flight.touched ?? []).length > 0 && renderTouched(v, flight.touched ?? [])}
    </Box>
  )
}

/** Files listed under TOUCHED THIS REPLY; the rest are counted in "… more". */
const MAX_TOUCHED_ROWS = 8

/**
 * What the reply changed in the working tree, by any tool, under the departures board, the most
 * lines changed first (ties in the order they were touched): each file's path (cut from its
 * start to fit), then its lines added and removed flush right, or `new` for a file git does not
 * track yet.
 */
function renderTouched(v: PaneView, touched: readonly HudTouched[]): RenderElement {
  const { Box, Text } = v.ui
  const byLines = [...touched].sort((a, b) => b.added + b.removed - (a.added + a.removed))
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={LINE_HEX}>
        TOUCHED THIS REPLY
      </Text>
      {byLines.slice(0, MAX_TOUCHED_ROWS).map(t => {
        const isNewOnly = t.isNew === true && t.added === 0 && t.removed === 0
        const lines = isNewOnly ? 'new' : `+${t.added} -${t.removed}`
        // The pencil and its space take 2 columns, a space keeps the path off the lines.
        const room = Math.max(4, v.width - RIGHT_PAD - 2 - lines.length - 1)
        return (
          <Text key={t.path} wrap="truncate-end">
            <Text color="#d29922">✎ </Text>
            {`${fitStart(t.path, room).padEnd(room)} `}
            {isNewOnly ? (
              <Text color="#3fb950">new</Text>
            ) : (
              <Text>
                <Text color="#3fb950">+{t.added} </Text>
                <Text color="#f85149">-{t.removed}</Text>
              </Text>
            )}
          </Text>
        )
      })}
      {touched.length > MAX_TOUCHED_ROWS && <Text dimColor>… {touched.length - MAX_TOUCHED_ROWS} more</Text>}
    </Box>
  )
}

/** The Turn tab: the reply's departures board, then what its input cost and what the cache took off. */
function renderTurn(v: PaneView): RenderElement {
  const { Box } = v.ui
  return (
    <Box flexDirection="column">
      {renderFlight(v)}
      {renderCache(v)}
    </Box>
  )
}

/** Groups the Skills tab lists under who pays for the listing; the rest are counted. */
const MAX_SKILL_GROUPS = 5

/** Quiet skills the Skills tab names; the rest are counted. */
const MAX_QUIET = 12

/**
 * The listing's box: what it costs every turn, and how many skills fell past its budget, which
 * Claude never sees and so can only fire when you type them.
 */
function renderListing(v: PaneView): RenderElement {
  const { Box, Text } = v.ui
  const listing = v.usage.skills
  if (listing === undefined) return <Text dimColor>No skill listing yet.</Text>
  const hidden = listing.total - listing.included
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text dimColor>listing </Text>
        <Text bold>{formatTokens(listing.tokens)}</Text>
        <Text dimColor> tokens every turn</Text>
      </Text>
      {hidden > 0 && (
        <Text wrap="wrap">
          <Text color="#d29922">
            ⚠ {hidden} past the budget:
          </Text>
          <Text dimColor> Claude can't pick {hidden === 1 ? 'it' : 'them'} unless you type /name</Text>
        </Text>
      )}
    </Box>
  )
}

/**
 * The skills fired this session, in the order they first fired: the latest marked, who fired
 * it, how often and the tokens its prompts brought in; then the chain of fires.
 */
function renderFired(v: PaneView): RenderElement {
  const { Box, Text } = v.ui
  const { fired, chain } = v.skills
  if (fired.length === 0) return <Text dimColor>None yet.</Text>
  const latest = chain.at(-1)
  // Mark 2, who 7, count 4 and tokens 5 columns, the name the rest, short of the edge by RIGHT_PAD.
  const nameColumns = Math.max(8, v.inner - RIGHT_PAD - 18)
  return (
    <Box flexDirection="column">
      {fired.map(f => {
        const short = skillShortName(f.name)
        const name = short.length > nameColumns - 1 ? `${short.slice(0, nameColumns - 2)}…` : short
        return (
          <Text key={f.name} wrap="truncate-end">
            <Text color={f.name === latest ? '#3fb950' : undefined} dimColor={f.name !== latest}>
              {f.name === latest ? '◉ ' : '● '}
            </Text>
            <Text bold={f.name === latest}>{name.padEnd(nameColumns)}</Text>
            <Text dimColor>{f.by.padEnd(7)}</Text>
            <Text>{`×${f.count}`.padEnd(4)}</Text>
            {/* No prompt seen (an organization keeps skill.prompt from this plugin): its size is unknown, not 0. */}
            <Text dimColor>{(f.tokens === 0 ? '—' : formatTokens(f.tokens)).padStart(5)}</Text>
          </Text>
        )
      })}
      {chain.length >= 2 && (
        <Text dimColor wrap="wrap">
          chain: {chain.map(skillShortName).join(' → ')}
        </Text>
      )}
    </Box>
  )
}

/** Who pays for the listing: each plugin or source, how many skills it lists, a bar of its tokens against the largest, and the tokens. */
function renderPayers(v: PaneView): RenderElement {
  const { Box, Text } = v.ui
  const groups = skillGroups(v.usage.skills?.list ?? [])
  if (groups.length === 0) return <Text dimColor>Nothing listed.</Text>
  const most = groups[0]!.tokens
  // Count 4, bar 10 and tokens 6 columns with their spaces, the name the rest.
  const nameColumns = Math.max(8, v.inner - 22)
  return (
    <Box flexDirection="column">
      {groups.slice(0, MAX_SKILL_GROUPS).map(g => {
        const cells = most > 0 ? Math.max(1, Math.round((g.tokens / most) * 10)) : 1
        const name = g.name.length > nameColumns - 1 ? `${g.name.slice(0, nameColumns - 2)}…` : g.name
        return (
          <Text key={g.name} wrap="truncate-end">
            {name.padEnd(nameColumns)}
            <Text dimColor>{String(g.count).padStart(3)} </Text>
            <Text color={LINE_HEX}>{'█'.repeat(cells)}</Text>
            {' '.repeat(11 - cells)}
            <Text dimColor>{formatTokens(g.tokens).padStart(5)}</Text>
          </Text>
        )
      })}
      {groups.length > MAX_SKILL_GROUPS && <Text dimColor>+ {groups.length - MAX_SKILL_GROUPS} more</Text>}
    </Box>
  )
}

/** The listed skills that have not fired in a while, by name: what the listing pays for and gets nothing back. */
function renderQuiet(v: PaneView, quiet: readonly string[]): RenderElement {
  const { Text } = v.ui
  if (quiet.length === 0) return <Text dimColor>Every listed skill has fired.</Text>
  const named = quiet.slice(0, MAX_QUIET).map(skillShortName).join(' · ')
  return (
    <Text dimColor wrap="wrap">
      {named}
      {quiet.length > MAX_QUIET && ` · +${quiet.length - MAX_QUIET} more`}
    </Text>
  )
}

/**
 * The Skills tab: the listing (what it costs, and how many skills fell past its budget), the
 * skills fired this session, who pays for the listing, and the listed skills that never fire.
 */
function renderSkills(v: PaneView): RenderElement {
  const { Box } = v.ui
  const listing = v.usage.skills
  const quiet = quietSkills(listing?.list ?? [], v.skills, v.now)
  const counted: RuleSpan[] = listing === undefined ? [] : [{ text: `· ${listing.included} of ${listing.total} listed`, isDim: true }]
  return (
    <Box flexDirection="column">
      {paneHeading(v, 'SKILLS', counted)}
      {paneSection(v, renderListing(v))}
      {paneHeading(v, 'FIRED THIS SESSION')}
      {paneSection(v, renderFired(v))}
      {listing !== undefined && paneHeading(v, 'WHO PAYS FOR THE LISTING')}
      {listing !== undefined && paneSection(v, renderPayers(v))}
      {listing !== undefined && paneHeading(v, 'QUIET', [{ text: `· not fired ${quietSpan(v.skills.since, v.now)}`, isDim: true }])}
      {listing !== undefined && paneSection(v, renderQuiet(v, quiet))}
    </Box>
  )
}

/**
 * A process's status words: idle for how long, else its CPU share (just "active" when no
 * share is known), prefixed by whose it is: this session, a terminal tab, or unowned.
 */
function procStatus(p: HudProc, liveNow: number): string {
  let activity: string
  if (isIdle(p, liveNow)) activity = `idle ${formatSpan(liveNow - p.activeAt)}`
  else if (p.cpuPct === undefined) activity = 'active'
  else activity = `${p.cpuPct}% cpu`
  if (p.state === 'mine') return `this session · ${activity}`
  if (p.state === 'protected') return `terminal tab · ${activity}`
  if (p.state === 'unowned') return `unowned · ${activity}`
  return activity
}

/**
 * One process: a summary row with an "End" button for the ones that may be ended, which
 * becomes a confirm row for that pid (`confirmAtom`); then its command line indented two.
 */
function renderProcRow($: EngineInterface, v: PaneView, p: HudProc): RenderElement {
  const { Box, Text, Button } = v.ui
  const { liveNow, confirmPid, procs } = v
  const endsWhat = procs.endsTree === true ? ' and its children' : ''
  return (
    <Box key={String(p.pid)} flexDirection="column">
      <Box flexDirection="row">
        <Box flexGrow={1}>
          <Text wrap="truncate-end">
            <Text color={procHex(p, liveNow)}>● </Text>
            <Text bold>{p.name}</Text>
            <Text dimColor> {p.pid} </Text>
            {formatMb(p.memMb)}
            <Text dimColor> · {formatSpan(liveNow - p.startedAt)} · </Text>
            <Text color={procHex(p, liveNow)}>{procStatus(p, liveNow)}</Text>
            {p.kind !== '' && <Text dimColor> · {p.kind}</Text>}
          </Text>
        </Box>
        {canEnd(p) && confirmPid !== p.pid && (
          <Button key={`end-${p.pid}`} label="End" plain dimColor onPress={() => update($, confirmAtom, () => p.pid)} />
        )}
      </Box>
      {confirmPid === p.pid && (
        <Box flexDirection="row">
          <Text color="#f85149">End {p.pid}{endsWhat}? </Text>
          <Button key={`yes-${p.pid}`} label="Yes, end it" variant="primary" onPress={() => endProcesses($, [p], false)} />
          <Text> </Text>
          <Button key={`no-${p.pid}`} label="Cancel" onPress={() => update($, confirmAtom, () => 0)} />
        </Box>
      )}
      <Text dimColor wrap="truncate-end">
        {'  '}
        {p.command}
      </Text>
    </Box>
  )
}

/** The stale processes' line: how many and their memory, with "End all stale" or, once pressed, its confirmation; or "Nothing stale". */
function renderStaleRow($: EngineInterface, v: PaneView, stale: HudProc[]): RenderElement {
  const { Box, Text, Button } = v.ui
  if (stale.length === 0) {
    return (
      <Box marginTop={1}>
        <Text color="#3fb950">Nothing stale</Text>
      </Box>
    )
  }
  const staleMb = stale.reduce((sum, p) => sum + p.memMb, 0)
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text bold color="#f85149">
        {stale.length} stale · {formatMb(staleMb)}{' '}
      </Text>
      {v.confirmPid === -1 ? (
        <Box flexDirection="row">
          <Button key="yes-all" label="Yes, end all" variant="primary" onPress={() => endProcesses($, stale, true)} />
          <Text> </Text>
          <Button key="no-all" label="Cancel" onPress={() => update($, confirmAtom, () => 0)} />
        </Box>
      ) : (
        <Button key="end-all" label="End all stale" onPress={() => update($, confirmAtom, () => -1)} />
      )}
    </Box>
  )
}

/** The Procs tab's legend: what each light's color means, and which processes are never ended. */
function renderProcsLegend(v: PaneView): RenderElement {
  const { Text } = v.ui
  return (
    <Text wrap="wrap">
      <Text color="#58a6ff">●</Text>
      <Text dimColor> this session </Text>
      <Text color="#3fb950">●</Text>
      <Text dimColor> active </Text>
      <Text color="#8b949e">●</Text>
      <Text dimColor> idle 30m+ </Text>
      <Text color="#d29922">●</Text>
      <Text dimColor> unowned </Text>
      <Text color="#f85149">●</Text>
      <Text dimColor> stale (unowned + idle). Terminal tabs and this session are never ended.</Text>
    </Text>
  )
}

/**
 * The Procs tab after its first scan: the claude and node counts and their memory, the memory
 * strip (terminal only), the stale line, the last error, the processes, and when it scanned.
 */
function renderProcsList($: EngineInterface, v: PaneView): RenderElement {
  const { Box, Text, Button } = v.ui
  const { procs, liveNow, Raster } = v
  const claudes = procs.list.filter(p => p.name === 'claude').length
  const nodes = procs.list.length - claudes
  const totalMb = procs.list.reduce((sum, p) => sum + p.memMb, 0)
  const stale = procs.list.filter(p => isStale(p, liveNow))
  const memColumns = Math.max(8, v.inner)
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>claude {claudes}</Text>
        <Text dimColor> · </Text>
        <Text bold>node {nodes}</Text>
        <Text dimColor> · {formatMb(totalMb)}</Text>
      </Text>
      {Raster !== undefined && procs.list.length > 0 && (
        <Raster key="mem" columns={memColumns} rows={1} cells={memoryCells(procs.list, memColumns, liveNow)} />
      )}
      {renderStaleRow($, v, stale)}
      {procs.error !== undefined && <Text color="#f85149">{procs.error}</Text>}
      <Box flexDirection="column" marginTop={1}>
        {procs.list.slice(0, MAX_PROC_ROWS).map(p => renderProcRow($, v, p))}
        {procs.list.length > MAX_PROC_ROWS && <Text dimColor>… {procs.list.length - MAX_PROC_ROWS} more</Text>}
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <Text dimColor>scanned {paneAgo(v, procs.at)} </Text>
        <Button key="rescan" label="Rescan" plain dimColor onPress={() => refreshProcs($, 0)} />
      </Box>
      {renderProcsLegend(v)}
    </Box>
  )
}

/** The Procs tab: every claude and node process, the stale ones first; "Scanning…" until the first scan. */
function renderProcs($: EngineInterface, v: PaneView): RenderElement {
  const { Box, Text } = v.ui
  return (
    <Box flexDirection="column">
      {paneHeading(v, 'PROCS')}
      {paneSection(v, v.procs.at === 0 ? <Text dimColor>Scanning…</Text> : renderProcsList($, v))}
    </Box>
  )
}

/**
 * The plugin's entry point: registers every hook the HUD needs with `on`. The engine calls it
 * on load and on every hot reload; hooks hold no state of their own beyond the atoms and the
 * module `let`s documented above, so registering again is safe.
 */
export const register: Register = on => {
  // Session start: register /hud, take a first reading of everything, start the timers, and
  // open the sidebar for an interactive session. Passes on so the engine's own start proceeds.
  on('session.start', async ($, e, next) => {
    isEnding = false
    await $.command.register({ name: 'hud', description: 'Open the session sidebar' })

    const settings = (await $.settings.read()) as Record<string, unknown>
    const usage = await $.session.usage()
    await patchMeta($, {
      cwd: e.cwd,
      home: (await homeDir($)) ?? '',
      id: await $.session.id(),
      model: await $.session.model(),
      effort: typeof settings.effortLevel === 'string' ? settings.effortLevel : '',
      version: (await $.session.version()).version,
      hudVersion: await manifestVersion($.plugin.root, path => $.fs.read(path)),
      startedAt: usage.startedAt,
    })
    // The breakdown is an estimate the engine may not have yet; without it the bar still draws.
    await setUsage($, { ...toUsage(usage), ...(await readBreakdown($).catch(() => ({}))) })
    // One seed sample so ARIA has a reading; a history kept across a reload is not doubled.
    if ((await read($, historyAtom)).length === 0) await recordSample($, toUsage(usage), false)
    // Fire and forget from here on: none of this may hold up the session's start, and each
    // swallows its own failures. A hot reload cancels these timers with the old module.
    void tick($)
    void refreshGit($)
    $.clock.every(META_EVERY_MS, () => void tick($))
    $.clock.every(GIT_EVERY_MS, () => void gitTick($))
    $.clock.every(BLINK_EVERY_MS, () => void blink($))
    void checkRelease($)
    void checkHudRelease($)
    void loadSkillsSeen($)
    $.clock.every(RELEASE_EVERY_MS, () => void checkRelease($))
    $.clock.every(HUD_RELEASE_EVERY_MS, () => void checkHudRelease($))
    // A shared scan up to a minute old is good enough to fill the digest's count at start.
    void refreshProcs($, 60_000)
    $.clock.every(PROCS_EVERY_MS, () => void procsTick($))

    // 40 columns wide. Opened unasked (session.start is no person's action), the engine seats it
    // only from 144 terminal columns (110 if the person opened it before); narrower, it waits
    // undrawn until /hud asks or the terminal widens, and the band stands in meanwhile.
    if (e.isInteractive) void $.ui.open({ id: PANE, title: TITLE, columns: 40 })

    return next(e)
  })

  // `/clear` (and a resume) ends the conversation but not the process, and no session.start
  // follows. session.end runs under a short bound, so it only brings the next tick forward;
  // the tick sees the new id and starts the HUD's picture over. Any other reason ends the
  // process: from here no git refresh starts (`isEnding`), so none outlives the session.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') $.clock.after(1_000, () => void tick($))
    else isEnding = true

    return next(e)
  })

  // `/hud [tab|compact]`: the HUD's own command, so it answers for itself and never calls next.
  // `compact` starts the Prep compact draft without waiting on it; anything else selects the
  // named tab (if one), refreshes meta and git so the sidebar opens current, and opens it, which
  // as the person's own command seats it at any width.
  on('command.run', { command: 'hud' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    if (asked === 'compact') {
      void startDraft($)
      return { text: 'Drafting a keep-list for compaction…' }
    }
    const alias = TAB_ALIASES[asked]
    const wanted = TABS.find(([id, label]) => asked === id || asked === label.toLowerCase() || id === alias)
    if (wanted !== undefined) await update($, tabAtom, () => wanted[0])
    await tick($)
    await refreshGit($)
    if (wanted?.[0] === 'commits') await readCommits($)
    await $.ui.open({ id: PANE, title: TITLE, columns: 40 })

    return { text: 'Session sidebar opened.' }
  })

  // After the engine opens any pane: for the sidebar, wake the band (it hides while the sidebar
  // shows) and refresh git without waiting. Runs next first, so it observes the open, never blocks it.
  on('ui.open', async ($, e, next) => {
    const opened = await next(e)
    if (e.id === PANE) {
      await bumpPanes($)
      void refreshGit($)
    }

    return opened
  })

  // After the sidebar closes, wake the band so it takes the sidebar's place.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) await bumpPanes($)

    return closed
  })

  // Raised as the system prompt is rendered, before the request goes out: the one place the
  // model, the tool roster and the prompt are all known in time to say what a turn will cost.
  on('prompt.compose', async ($, e, next) => {
    // Composed first: the sections to compare are the final ones, after every plugin's changes.
    const composed = await next(e)
    // Analysis calls and teammates have prompts of their own; comparing them with the main
    // conversation's would report a break on every alternation.
    const isReal = !e.traits.includes('analysis') && !e.traits.includes('teammate')
    // Awaited: the warning is only worth anything if it lands before the request goes out.
    if (isReal) await notePrefix($, prefixOf(e.model, e.tools, composed.sections)).catch(() => undefined)

    return composed
  })

  // A reply begins: start its Flight, and append a re-check note still owed from a compaction
  // (normally session.append has already done so). No agentId filter: a subagent's run raises
  // no turn.start. Then passes on: the HUD only watches turns.
  on('turn.start', async ($, e, next) => {
    await startFlight($, e.turnId)
    // The reading the reply's touched files are measured from: taken before its first edit lands.
    void refreshGit($)
    if (isRecheckPending) {
      isRecheckPending = false
      await appendRecheck($)
    }

    return next(e)
  })

  // A reply ends: close its Flight, record its cache split, settle a pending re-cache warning and
  // re-read git. Subagent turns (an `agentId`) are skipped: their cache and timings are not the
  // conversation's. Always passes on.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // Every report of this reply's skill fires is in: what the other report never matched goes.
      promptNoted.clear()
      callNoted.clear()
      // No usage, or a reply with no input tokens, records no cache turn rather than a 0% one.
      const hit = e.usage === undefined ? undefined : cacheHit(e.usage)
      const turn = hit === undefined || hit.total === 0 ? undefined : { at: await $.clock.now(), ...hit }
      await endFlight($, e.durationMs, turn)
      // The re-cache a change forced has now been paid; the reason stays, as the record of why.
      await update($, prefixAtom, (p): HudPrefix => (p.isPending ? { ...p, isPending: false } : p))
      void refreshGit($)
    }

    return next(e)
  })

  // Every compaction, manual or automatic, gets the keep-list; the person's own /compact text leads it.
  on('session.compact', async ($, e, next) => {
    isCompactHookSeen = true
    const result = await next({ ...e, instructions: compactInstructions(e.instructions) })
    // A precomputed summary is not installed yet, and a skipped one never is: no note is owed.
    // A subagent's compaction is its own transcript's, so the main conversation gets no note.
    const isInstalled = e.trigger !== 'precompute' && !('skip' in result && result.skip !== undefined)
    if (isInstalled && e.agentId === undefined) isRecheckPending = true

    return result
  })

  // A typed /compact: its words lead the standing brief, as the session.compact hook would put
  // them (which, seeing the brief already there, leaves them be). Where an organization manages
  // Claude Code that hook never reaches this plugin, so this is how a typed compaction gets the
  // brief, and its re-check note is armed here once the transcript has shrunk, which a
  // compaction does and one that was skipped does not. An automatic compaction raises no
  // command: there it goes unbriefed.
  on('command.run', { command: 'compact' }, async ($, e, next) => {
    isCompactHookSeen = false
    const before = await $.session.messages().catch(() => undefined)
    const result = await next({ ...e, args: compactInstructions(e.args) })
    if (!isCompactHookSeen && before !== undefined) {
      const after = await $.session.messages().catch(() => before)
      if (after.length < before.length) isRecheckPending = true
    }

    return result
  })

  // The re-check note goes in right after the engine stores the compaction summary: added any
  // earlier, it would sit before the compaction boundary, where the model no longer looks.
  on('session.append', { door: 'compaction' }, async ($, e, next) => {
    const stored = await next(e)
    // The summary is stored as a user message; anything else on this door is not the cue.
    if (isRecheckPending && e.agentId === undefined && e.message.type === 'user') {
      isRecheckPending = false
      // Not awaited: appending from inside this append's own hook must not hold it up.
      void appendRecheck($)
    }

    return stored
  })

  // A skill's prompt expanding, typed or called: recorded for the Skills tab once the prompt is
  // computed, and never in its way, since a failure here changes nothing the model reads. Where
  // an organization manages Claude Code this never fires here: the Skill call and the typed
  // command below count the fire instead.
  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    await noteSkillPrompt($, e.skill, result.text).catch(() => undefined)
    return result
  })

  // A slash command run: a skill typed as `/name` is counted as yours once it has run, unless
  // its prompt's expansion already counted it. Every other command passes by untouched.
  on('command.run', async ($, e, next) => {
    const result = await next(e)
    if (await isSkillCommand($, e.command).catch(() => false)) await noteSkillCall($, e.command, 'you').catch(() => undefined)
    return result
  })

  // New usage figures: store them and add a history sample. The breakdown (a local estimate) is
  // re-read only when the context changed, else the previous one is carried; a failed re-read
  // keeps the previous one too. Always passes on.
  on('session.measure', async ($, e, next) => {
    const previous = await read($, usageAtom)
    const kept = { parts: previous.parts, compactAt: previous.compactAt, compactAtTokens: previous.compactAtTokens, skills: previous.skills }
    const breakdown = e.changed.includes('context') ? await readBreakdown($).catch(() => kept) : kept
    await setUsage($, { ...toUsage(e), ...breakdown })
    await recordSample($, toUsage(e), e.changed.includes('context'))

    return next(e)
  })

  // Each model step carries the effort actually used: the Hub shows the main conversation's,
  // not a subagent's. A streaming hook, so it yields the step through untouched.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.effort !== undefined) {
      // Not awaited, so the stream never waits on the HUD; a failed write only leaves the old effort.
      void patchMeta($, { effort: String(e.effort) }).catch(() => undefined)
    }

    return yield* next(e)
  })

  // Every tool call: time it for Flight (main conversation only), and re-read git after anything
  // that may change a file. Always runs the tool via next and returns its result unchanged.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    // The tool's input fields sit on the event itself (`command`, `run_in_background`, paths).
    const input = e as unknown as Record<string, unknown>
    const isMain = e.agentId === undefined
    const start = await $.clock.now()
    // A call without a tool_use_id gets a made-up one, unique enough for replacing its own row.
    const id = e.tool_use_id ?? `${tool}-${start}`
    const call: HudCall = { id, tool, label: callLabel(input), start, isError: false }
    // Claude calling a skill: its prompt expands inside this call, and `noteSkill` credits Claude.
    const skill = tool === 'Skill' && typeof input.skill === 'string' ? input.skill : undefined
    if (skill !== undefined) pendingSkills.add(skill)
    // Recorded alongside the call, not before it: the tool never waits on the flight log.
    const recorded = isMain ? flightCall($, call).catch(() => undefined) : undefined

    const ran = await next(e)
    // Awaited only now, so the start row is written before the end row replaces it.
    await recorded

    const end = await $.clock.now()
    // Whatever the call did, its prompt has expanded by now, or never will: a call the
    // expansion did not count (none reached this plugin) is counted here, if it ran.
    if (skill !== undefined) {
      pendingSkills.delete(skill)
      if (ran.deny === undefined && ran.isError !== true) await noteSkillCall($, skill, 'claude').catch(() => undefined)
    }
    // A refused call counts as failed in Flight, though it never ran.
    const isError = ran.isError === true || ran.deny !== undefined
    if (isMain) await flightCall($, { ...call, end, isError })
    // Fire and forget: the model's next step never waits on git. Subagents' edits count too,
    // since they change the same tree.
    if (MUTATING_TOOLS.has(tool)) void refreshGit($)

    return ran
  })

  // The band above the prompt: one line of cache, the reply in flight and processes,
  // drawn only while the sidebar is not on screen. Whenever it has nothing to add (a survey owns
  // the space, the sidebar shows, or nothing has happened yet) it defers to the engine via next.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // Read only to subscribe: an open or close bumps it, which redraws this band.
    await read($, paneEpochAtom)
    const panes = await $.ui.panes()
    if (panes.some(p => p.id === PANE && p.isPlaced && p.isShown)) return next(e)

    const [cache, flight, procs, clock, meta] = await Promise.all([
      read($, cacheAtom),
      read($, flightAtom),
      read($, procsAtom),
      read($, nowAtom),
      read($, metaAtom),
    ])
    if (cache.length === 0 && flight.startedAt === 0 && procs.at === 0) return next(e)
    // `nowAtom` moves every second during a reply, the minute otherwise: the later of the two.
    const sum = summarize(cache, flight, procs, Math.max(clock, meta.minute * 60_000))
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text wrap="truncate-end">
          <Text color={sum.cacheHex}>cache {sum.cache}</Text>
          <Text dimColor> │ </Text>
          <Text color={sum.flightHex}>{sum.flight}</Text>
          <Text dimColor> │ </Text>
          <Text color={sum.procsHex}>{sum.procs}</Text>
          <Text dimColor> │ /hud</Text>
        </Text>
      </Box>
    )
  })

  // "Prep compact": the drafted keep-list, ticked and edited by the person, then compacted with.
  // This hook owns its pane outright, so it draws and never calls next.
  on('ui.render', { component: 'Pane', requestId: DRAFT_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // No free-text Input on mobile: the dialog there is ticks and buttons only.
    const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input
    const draft = await read($, draftAtom)
    const isBusy = draft.status === 'drafting' || draft.status === 'compacting'
    const kept = draft.items.filter(i => i.keep).length

    const toggle = (index: number) =>
      update($, draftAtom, d => ({ ...d, items: d.items.map((it, j) => (j === index ? { ...it, keep: !it.keep } : it)) }))
    /** Drops the draft (steer included) and closes the dialog; offered only while nothing runs. */
    const cancel = async () => {
      await update($, draftAtom, (): HudDraft => ({ status: 'idle', items: [] }))
      await $.ui.close({ id: DRAFT_PANE })
    }
    const hasSteer = draft.steer !== undefined && draft.steer !== ''
    const rows = keyedItems(draft.items)

    return (
      <Box flexDirection="column">
        <Text bold color="#58a6ff">
          What should survive?
        </Text>
        <Text dimColor wrap="wrap">
          Untick anything you do not need. Type below to say what matters most: your words are kept exactly, and the
          list is drafted again around them.
        </Text>
        {draft.status === 'drafting' && (
          <Box marginTop={1}>
            <Text color="#d29922">Reading the conversation… (nothing is added to it)</Text>
          </Box>
        )}
        {draft.status === 'compacting' && (
          <Box marginTop={1}>
            <Text color="#d29922">Compacting…</Text>
          </Box>
        )}
        {draft.error !== undefined && (
          <Box marginTop={1}>
            <Text color="#f85149" wrap="wrap">
              {draft.error}
            </Text>
          </Box>
        )}
        {hasSteer && (
          <Box marginTop={1}>
            <Text wrap="wrap">
              <Text color="#3fb950">{'★ '}</Text>
              <Text bold>{draft.steer}</Text>
              <Text dimColor> — your words, kept exactly</Text>
            </Text>
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          {rows.map(({ item, index, key }) => (
            <Box key={key} flexDirection="row">
              {/* The tick keeps its positional `item-<n>` key: presses (and tests) address it by place. */}
              <Button key={`item-${index}`} plain label={item.keep ? '[x]' : '[ ]'} onPress={() => toggle(index)} />
              <Text wrap="wrap" dimColor={!item.keep} strikethrough={!item.keep}>
                {' '}
                {item.text}
              </Text>
            </Box>
          ))}
        </Box>
        {Input !== undefined && !isBusy && (
          <Box marginTop={1}>
            <Input
              key="steer"
              placeholder={hasSteer ? 'Say it differently, then Enter' : 'What matters most? Enter to redraft'}
              submitLabel="Redraft"
              onSubmit={value => startDraft($, value)}
            />
          </Box>
        )}
        <Box flexDirection="row" marginTop={1}>
          {!isBusy && (kept > 0 || hasSteer) && (
            <Box marginRight={1}>
              <Button key="compact-now" label="Compact now" hotkey="c" variant="primary" onPress={() => runCompact($)} />
            </Box>
          )}
          {!isBusy && <Button key="cancel" label="Cancel" role="dismiss" onPress={cancel} />}
        </Box>
      </Box>
    )
  })

  // The sidebar: tab buttons, the digest, then the chosen tab's body. Every atom is read up front
  // so any change redraws it. It owns its pane outright, so it draws and never calls next.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [git, usage, meta, history, saved, cache, flight, clock, procs, confirmPid, dispatch, prefix, commits, skills, release] = await Promise.all([
      read($, gitAtom),
      read($, usageAtom),
      read($, metaAtom),
      read($, historyAtom),
      read($, tabAtom),
      read($, cacheAtom),
      read($, flightAtom),
      read($, nowAtom),
      read($, procsAtom),
      read($, confirmAtom),
      read($, dispatchAtom),
      read($, prefixAtom),
      read($, commitsAtom),
      read($, skillsAtom),
      read($, releaseAtom),
    ])
    // A tab saved by an older HUD (Gates, Cache, Flight) may no longer be one: the Hub stands in.
    const tab: HudTab = saved === 'news' || TABS.some(([id]) => id === saved) ? saved : 'hub'
    const width = Math.max(24, e.props.bodyColumns)
    const now = meta.minute * 60_000
    const v: PaneView = {
      ui: { Box, Text, Button },
      Raster: e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined,
      isTerminal: e.surface === 'terminal',
      width,
      inner: width - INDENT,
      now,
      liveNow: Math.max(clock, now, procs.at),
      git,
      usage,
      meta,
      history,
      tab,
      cache,
      flight,
      procs,
      confirmPid,
      dispatch,
      prefix,
      commits,
      skills,
      release,
    }

    return (
      <Box flexDirection="column" width={v.width}>
        {renderTabBar($, v)}
        {renderDigest(v)}
        <Box marginTop={1} flexDirection="column">
          {tab === 'hub' && renderHub($, v)}
          {tab === 'turn' && renderTurn(v)}
          {tab === 'procs' && renderProcs($, v)}
          {tab === 'commits' && renderCommits(v)}
          {tab === 'skills' && renderSkills(v)}
          {tab === 'news' && renderNews($, v)}
        </Box>
      </Box>
    )
  })
}
