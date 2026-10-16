/**
 * The HUD's type contract: every value it keeps in `$.state` and the records inside them.
 *
 * `plugin.json` names this file as `"types"`, so `claude plugin validate` holds each
 * `$.state` key that `hooks/register.tsx` reads or writes to the `PluginState` entry at the
 * bottom. The values are the session's (they survive a hot reload of the module, unlike
 * its own variables) and are plain data, so they can be drawn on any surface.
 *
 * Units, unless a field says otherwise: times are epoch milliseconds, durations are
 * milliseconds, `percent` fields run 0 to 100, and token counts are whole tokens.
 */

/** How git's porcelain status marks a changed file: modified, added, deleted, renamed or untracked. */
export type HudFileCode = 'M' | 'A' | 'D' | 'R' | '?'

/** One changed file in the working tree; `path` is relative to the tree's top, the new one for a rename. */
export type HudFile = { code: HudFileCode; path: string }

/** The Hub's git section: where the session's folder stands against its upstream, and what changed. */
export type HudGit = {
  /** False outside a repository, and every other field then keeps its empty value. */
  isRepo: boolean
  /** The local branch; `detached HEAD` when none is checked out. */
  branch: string
  /** The tracked branch (`origin/main`), or null when the branch tracks none. */
  upstream: string | null
  /** Commits on the branch that the upstream does not have. */
  ahead: number
  /** Commits on the upstream that the branch does not have. */
  behind: number
  files: HudFile[]
  /** Lines added across the uncommitted diff against HEAD; binary files count as none. */
  linesAdded: number
  /** Lines removed across the uncommitted diff against HEAD. */
  linesRemoved: number
  /** The last commit as `<short hash> <subject>`, '' before the first. */
  lastCommit: string
}

/** One commit on the Commits tab: its short hash, its subject, and the files and lines it changed. */
export type HudCommit = { hash: string; subject: string; files: number; added: number; removed: number }

/** The Commits tab: the branch's last commits, newest first, as `git log` last listed them. */
export type HudCommits = { list: HudCommit[]; fork?: HudFork }

/**
 * Where the branch left the one it came from (`base`, as `origin/main`): the commits made on it
 * since (`ahead`), and those the base has gained since (`behind`).
 */
export type HudFork = { base: string; ahead: number; behind: number }

/** One version's notes as picked for the person: the version, and a line for each change worth knowing. */
export type HudReleaseSection = { version: string; items: string[] }

/**
 * The release notes screen: `reading` while the changelog is fetched and the picks drafted,
 * `ready` with the picks (none when nothing in them mattered), `error` with why. `versions` is
 * what was asked for: the installed version, or `<installed> → <latest>` when a newer one is out.
 */
export type HudReleaseNotes = {
  status: 'idle' | 'reading' | 'ready' | 'error'
  versions: string
  sections: HudReleaseSection[]
  error?: string
}

/**
 * One plan rate limit as the engine reports it. `kind` is the engine's name for the window
 * (`five_hour`, `seven_day`, ...); `resetsAt` is an ISO 8601 time, absent when unknown.
 */
export type HudLimit = { kind: string; percentUsed: number; resetsAt?: string }

/** One used category of the context window, as /context names it. */
export type HudPart = { name: string; tokens: number }

/** The context window and the plan's limits, as of the engine's last measurement. */
export type HudUsage = {
  /** Tokens in the context window now; absent before the first measurement. */
  tokens?: number
  /** The model's context window, in tokens. */
  window: number
  /** `tokens` as a percent of `window`. */
  percent?: number
  limits: HudLimit[]
  /** What the session has cost so far, in US dollars, when the engine knows. */
  costUsd?: number
  /** Used categories, largest first (local estimate). */
  parts?: HudPart[]
  /** Where auto-compaction runs, as a percent of the model's window (the same base as `percent`). */
  compactAt?: number
  /** Where auto-compaction runs, in tokens. */
  compactAtTokens?: number
  /** The skill listing the context carries, as the breakdown counts it (local estimate). */
  skills?: HudSkillListing
}

/** One skill whose listing the context carries: where it came from (`pluginName` when a plugin's) and its listing's tokens. */
export type HudListedSkill = { name: string; source: string; plugin?: string; tokens: number }

/**
 * The skills the context lists for the model: how many the session has (`total`), how many fit
 * the listing's token budget (`included`; the rest Claude never sees), the listing's tokens, and
 * one entry per listed skill.
 */
export type HudSkillListing = { total: number; included: number; tokens: number; list: HudListedSkill[] }

/**
 * One skill fired this session: how often, the tokens its prompts brought into the context
 * (estimated), who fired it (`you` typed it, `claude` called it through the Skill tool, `both`
 * once each has) and when it last fired.
 */
export type HudSkillFire = { name: string; count: number; tokens: number; by: 'you' | 'claude' | 'both'; at: number }

/**
 * The Skills tab's record: the skills fired this session in the order they first fired, the
 * chain of fires (a repeat in a row counted once, the last eight kept), and from the store kept
 * across sessions, when each skill last fired anywhere and since when that has been kept.
 */
export type HudSkills = { fired: HudSkillFire[]; chain: string[]; seen: Record<string, number>; since: number }

/** The Hub's session rows: what this conversation is and where it runs. Refreshed by a 15-second timer. */
export type HudMeta = {
  /** The session's working folder. */
  cwd: string
  /** The home folder, shown as `~` at the start of `cwd`; '' when unknown, absent in state from before 0.10.3. */
  home?: string
  /** The session's own id, for resuming it or finding its transcript. */
  id: string
  /** The title the engine gives the session, '' until it has one. */
  name: string
  /** The Remote Control session id (`session_...`) while Remote Control (`/rc`) is on, '' when off; absent in state from before 0.9.2. */
  remote?: string
  model: string
  /** The reasoning effort from settings (`high`, ...), '' when none is set. */
  effort: string
  /** Claude Code's own version. */
  version: string
  /** This plugin's own version, from its plugin.json; '' until read, or when it states none. */
  hudVersion: string
  /** The version this plugin's own marketplace lists now; '' until asked, or outside a marketplace. */
  hudLatest?: string
  /** The newest release on the update channel, '' until known. */
  latest: string
  /** When git's last commit last changed while the HUD watched; 0 for never. */
  committedAt: number
  /** When the conversation started. */
  startedAt: number
  /** Prompts the person has sent in this conversation. */
  turns: number
  /** The current minute since the epoch: a change of minute redraws the rows that show elapsed time. */
  minute: number
}

/** One measurement: when, context fill and 5-hour use (percent), and whether a turn produced it. */
export type HudSample = { t: number; ctx?: number; five?: number; isTurn: boolean }

/**
 * The sidebar's tabs: the Hub (git, model, context, ARIA), Turn (its departures and the cache),
 * Processes, Commits and Skills; and What's new, which has no tab button: a click on Claude's
 * version opens it.
 */
export type HudTab = 'hub' | 'turn' | 'procs' | 'commits' | 'skills' | 'news'

/** The "Prep compact" dialog: a short drafted keep-list the person unticks, steers and approves. */
export type HudDraft = {
  /**
   * `idle` before a draft; `drafting` while a forked model call writes one; `ready` to review;
   * `compacting` once approved; `error` when the draft failed, with `error` saying why.
   */
  status: 'idle' | 'drafting' | 'ready' | 'compacting' | 'error'
  /** The drafted points, each kept unless the person unticks it. */
  items: { text: string; keep: boolean }[]
  /** What the person typed: it redraws the list and is kept word for word. */
  steer?: string
  /** Why the last step failed, in words for the person; also used for a nudge while `ready`. */
  error?: string
}

/** `mine`: this session; `protected`: a terminal tab (herdr, Windows Terminal); `owned`: daemon, desktop app or system; `unowned`: its chain breaks. */
export type HudProcState = 'mine' | 'protected' | 'owned' | 'unowned'

/** One node or claude process on the Processes tab. */
export type HudProc = {
  pid: number
  /** The executable, without `.exe`. */
  name: 'claude' | 'node'
  /** When the process started: with `pid`, what tells it from a later process that reuses the pid. */
  startedAt: number
  /** Resident memory, in megabytes. */
  memMb: number
  /** CPU time used since it started, in seconds. */
  cpuSec: number
  /** CPU over the last sample interval, percent of one core. */
  cpuPct?: number
  /** When its CPU time last moved. */
  activeAt: number
  state: HudProcState
  /** What it is, read from its command line (`session`, `daemon`, `vitest`, `mcp server`, ...), '' when unknown. */
  kind: string
  /** Its command line with paths shortened and anything like a credential hidden. */
  command: string
}

/**
 * The Processes tab's list: when it was scanned, and why the last scan failed, if it did.
 * `endsTree`: ending a process here also ends its children (Windows' `taskkill /T`); elsewhere
 * `kill -TERM` signals the one process, and the End prompt says only that.
 */
export type HudProcs = { at: number; list: HudProc[]; error?: string; endsTree?: boolean }

/**
 * One main-thread turn's input side: when it ended, the three kinds of input token it was
 * answered over, and `read` as a share of `total` (`hit`). A turn makes one request per
 * round of tool calls and these are summed over all of them, so `total` is not a prompt size.
 */
export type HudCacheTurn = {
  at: number
  /** `read` over `total`, from 0 to 1. */
  hit: number
  /** `read + write + fresh`. */
  total: number
  /** Tokens the prompt cache served, at a tenth of the input rate. */
  read: number
  /** Tokens written into the cache, at twice the input rate. */
  write: number
  /** Tokens neither read nor written: full price, and gone after the reply. */
  fresh: number
}

/** The three things above the prompt cache's boundary, each fingerprinted (the model by name). */
export type HudPrefixParts = { model: string; tools: string; prompt: string }

/**
 * What the next request will send above the cache boundary, and whether it still matches
 * what the last one sent. `reason` names what changed; while `isPending` the re-cache it
 * forces has not been paid yet, so the next turn is the expensive one.
 */
export type HudPrefix = {
  parts?: HudPrefixParts
  reason: string
  at: number
  isPending: boolean
}

/**
 * One tool call on the Flight chart: the tool, a few words of what it did (`label`), when it
 * started, and when it ended (absent while it still runs, which draws as a growing bar).
 */
export type HudCall = { id: string; tool: string; label: string; start: number; end?: number; isError: boolean }

/** One file's uncommitted lines against HEAD at a git reading; `isNew` when git does not track it yet (no line counts). */
export type HudTreeFile = { added: number; removed: number; isNew?: boolean }

/** The working tree at one git reading: HEAD's short hash and each changed file's lines. What a reply's touched files are measured by. */
export type HudTree = { head: string; files: Record<string, HudTreeFile> }

/** A file a reply changed, by any tool: the lines it added and removed, and whether git does not track it yet. */
export type HudTouched = { path: string; added: number; removed: number; isNew?: boolean }

/**
 * The tool calls of the reply now running, or of the last one: `endedAt` is absent until it
 * finishes. `base` is the working tree at the last git reading during it, and `touched` the
 * files changed since it began.
 */
export type HudFlight = { turnId: string; startedAt: number; endedAt?: number; calls: HudCall[]; base?: HudTree; touched?: HudTouched[] }

declare module 'claude-code' {
  /** The session-scoped state the HUD keeps, by key: `claude plugin validate` checks every key the module names against this. */
  interface PluginState {
    'session-hud': {
      git: HudGit
      usage: HudUsage
      meta: HudMeta
      /** Context and 5-hour readings over time, for the trend and ARIA's forecasts. */
      history: HudSample[]
      /** The tab the sidebar shows. */
      tab: HudTab
      compactDraft: HudDraft
      /** Recent turns' input tokens, oldest first, for the Turn tab's cache. */
      cache: HudCacheTurn[]
      prefix: HudPrefix
      flight: HudFlight
      /** The engine clock as of the last event that moved it, so drawing never reads the clock. */
      now: number
      /**
       * Bumped when the sidebar opens or closes: the band above the prompt reads it, so it redraws
       * and steps aside while the sidebar shows. Whether a pane is shown is the engine's, not state.
       */
      paneEpoch: number
      procs: HudProcs
      /** The pid an End press is waiting to have confirmed; -1 for all stale; 0 for none. */
      confirmPid: number
      /** How many times the dispatcher's +N has been pressed: which of its dispatches the band shows. */
      dispatch: number
      commits: HudCommits
      skills: HudSkills
      releaseNotes: HudReleaseNotes
    }
  }
}
