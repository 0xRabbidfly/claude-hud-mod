/**
 * Compaction support: what every summary must keep, what the model is told
 * right after one, and when ARIA calls a good moment to compact.
 *
 * Three pieces, all pure text and arithmetic. The standing brief (`COMPACT_BRIEF`,
 * `compactInstructions`) is added to every compaction by `register.tsx`'s `session.compact`
 * hook, and the re-check note (`recheckNote`) goes in right after one. Prep compact drafts a
 * short keep-list on a fork of the conversation (`draftPrompt`, `parseKeepList`), and the
 * ticked items become the instructions and a saved file (`keepListInstructions`,
 * `keepListFile`). The token zones (`zoneOf`, `isBreakpoint`, `adviceFor`, `zoneLabel`) drive
 * ARIA's advice button and the Hub's context label.
 */

/** Given to the summarizer on every compaction, manual or automatic. */
export const COMPACT_BRIEF = [
  'Write the summary so work can continue without the original transcript. Keep, verbatim where it matters:',
  '- Decisions made and WHY, including options considered and rejected.',
  '- Exact file paths, function names, commands, error messages and line numbers that are still relevant.',
  '- What was tried and ruled out, so it is not retried.',
  '- The current task, its state, and the concrete next step.',
  '- Open questions, unfinished to-dos and known risks.',
  "- Every explicit instruction, preference or correction the user gave in this session, in the user's words.",
  'Drop: raw tool output, file contents that can be re-read, exploration that led nowhere, and pleasantries.',
  'If something is uncertain, say so in the summary rather than stating a guess as fact.',
].join('\n')

/** Added to the conversation right after a compaction; the model reads it, the person does not see it as typed. */
export const RECHECK_NOTE = [
  'The conversation was just compacted; the summary above is lossy.',
  'Before editing or making claims about code, re-read the files involved instead of relying on the summary.',
  'If the summary is unclear about a decision or the user\'s intent, ask rather than guess.',
].join(' ')

/** The re-check note, pointing at the saved keep-list when the compaction had one. */
export function recheckNote(keepListPath?: string): string {
  return keepListPath === undefined
    ? RECHECK_NOTE
    : `${RECHECK_NOTE} The keep-list the user approved for this compaction is saved at ${keepListPath}; read it when unsure.`
}

/** How many drafted items the person is asked to look at. Few enough to read in one glance. */
export const MAX_KEEP_ITEMS = 5

/**
 * Asked of a fork of the conversation (nothing is added to it): a short, plain-language
 * draft of what must survive, which the person then unticks or steers.
 *
 * The brief the summarizer gets (COMPACT_BRIEF) is the exhaustive, technical one. This list
 * is the opposite: it is for a person to read in a few seconds and say yes or no to, so it
 * asks for whole sentences about the work rather than paths, symbols and ids.
 */
const DRAFT_RULES = [
  'This conversation is about to be squeezed into a shorter summary, and detail will be lost.',
  'Say what must survive, as you would tell a colleague taking the work over.',
  'One line each, covering only the big things: what was decided and why, what is half-done,',
  'what was ruled out, and anything the user told you to do or not do.',
  'Write plain sentences. No file paths, symbol names, ids or jargon unless the point makes no sense without them.',
  `Output ONLY the list: at most ${MAX_KEEP_ITEMS} lines, each starting with "- " and under 120 characters.`,
  'Merge related points into one line rather than splitting them. No headings, no preamble.',
].join(' ')

/** The draft prompt, with the person's own steer leading it when they gave one. */
export function draftPrompt(steer?: string): string {
  const asked = steer?.trim()
  return asked === undefined || asked === '' ? DRAFT_RULES : `The user says this matters most: ${asked}\n\n${DRAFT_RULES}`
}

/** One drafted keep-list line, and whether the person still has it ticked. */
export type KeepItem = { text: string; keep: boolean }

/** The fork's reply as items: bullet or numbered lines, deduplicated, each kept by default. */
export function parseKeepList(reply: string): KeepItem[] {
  const seen = new Set<string>()
  const items: KeepItem[] = []
  for (const line of reply.split(/\r?\n/)) {
    // A list marker ("-", "*", "•", "1." or "1)") then the text; preamble lines without one, and a
    // marker with nothing after it, are skipped. The text runs from its first non-space to the line's
    // end, trailing spaces trimmed after: a lazy `(.+?)\s*$` retried the spaces at every step. `.`
    // stops at a lone `\r` or U+2028/U+2029, so one of those, and spaces, may end the line too
    // ("- foo\r" is `foo`); any text after it means the line is not an item.
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(\S.*)(?:[\r\u2028\u2029]\s*)?$/.exec(line)
    // Bold markers are dropped so "use **REST**" and "use REST" count as one; 200 characters
    // caps a runaway line at well over the 120 the prompt asks for.
    const text = m?.[1]?.trimEnd().replaceAll('**', '').slice(0, 200)
    if (text === undefined || text === '' || seen.has(text.toLowerCase())) continue
    seen.add(text.toLowerCase())
    items.push({ text, keep: true })
    if (items.length === MAX_KEEP_ITEMS) break
  }
  return items
}

/**
 * What /compact is told: the person's own words first, then the ticked items (the standing
 * brief follows). Their words lead because they are the one instruction that is certainly theirs.
 */
export function keepListInstructions(items: readonly string[], path?: string, steer?: string): string {
  const asked = steer?.trim()
  const lead = asked === undefined || asked === '' ? '' : `In the user's own words, this matters most: ${asked}\n`
  const list = items.map(t => `- ${t}`).join('\n')
  const saved = path === undefined ? '' : `\nThe full list is also saved at ${path}.`
  // Nothing ticked: the person's words alone (or nothing at all) are enough to compact on.
  if (items.length === 0) return `${lead}${saved}`.trim()

  return `${lead}Keep these, verbatim where possible:\n${list}${saved}`
}

/**
 * The keep-list as a Markdown file, so it survives the compaction whole: a heading, the session
 * id and `whenIso` (an ISO timestamp of approval), the person's own words when given, then one
 * bullet per item. Prep compact writes it under `~/.claude/session-hud/keep/` and points the
 * instructions and the re-check note at it.
 */
export function keepListFile(items: readonly string[], sessionId: string, whenIso: string, steer?: string): string {
  const asked = steer?.trim()
  return [
    `# Keep-list for compaction`,
    ``,
    `Session \`${sessionId}\`, approved ${whenIso}.`,
    ``,
    ...(asked === undefined || asked === '' ? [] : [`**In the user's words:** ${asked}`, ``]),
    ...items.map(t => `- ${t}`),
    ``,
  ].join('\n')
}

/**
 * The instructions for any compaction: `userText` (what the person typed after /compact, or the
 * keep-list instructions from Prep compact) leads, then `COMPACT_BRIEF`. With no text, or only
 * whitespace, the brief alone. Text that already holds the brief is returned trimmed and as is,
 * so the call is idempotent: Prep compact wraps its instructions here, and the `session.compact`
 * hook then wraps them again without doubling the brief.
 * `compactInstructions('  keep the auth plan ')` → `The user asked specifically: keep the auth
 * plan`, a blank line, then the brief.
 */
export function compactInstructions(userText: string | undefined): string {
  const asked = userText?.trim()
  if (asked?.includes(COMPACT_BRIEF)) return asked
  return asked ? `The user asked specifically: ${asked}\n\n${COMPACT_BRIEF}` : COMPACT_BRIEF
}

/** Context pressure by tokens: `green` is sharp, `amber` compact at a break, `red` compact now. */
export type Zone = 'green' | 'amber' | 'red'

/**
 * Context pressure by absolute tokens, not percent: on a 1M window, 40% is
 * already 400k tokens. Amber from 200k (compact at the next break), red from
 * 400k (compact now). Smaller windows, and an earlier auto-compact point,
 * pull both lines in.
 *
 * Red starts at the lowest of 400k, three quarters of `window` (ignored when it is 0 or less,
 * that is unknown) and 90% of `compactAtTokens`, the auto-compact point in tokens when known.
 * Amber starts at half of red, and never later than 200k. `tokens` undefined is green. Both
 * lines come back with the zone, rounded to whole tokens.
 * `zoneOf(120_000, 200_000)` → amber from 75k, red from 150k.
 */
export function zoneOf(tokens: number | undefined, window: number, compactAtTokens?: number): { zone: Zone; amberAt: number; redAt: number } {
  const ceiling = Math.min(400_000, window > 0 ? window * 0.75 : 400_000, compactAtTokens !== undefined ? compactAtTokens * 0.9 : Infinity)
  const redAt = Math.round(ceiling)
  const amberAt = Math.round(Math.min(200_000, redAt / 2))
  let zone: Zone = 'red'
  if (tokens === undefined || tokens < amberAt) zone = 'green'
  else if (tokens < redAt) zone = 'amber'
  return { zone, amberAt, redAt }
}

/** The parts of the engine's context breakdown that say where auto-compaction runs. */
export type CompactBreakdown = {
  isAutoCompactEnabled: boolean
  autoCompactThreshold?: number
  rawMaxTokens: number
  autocompactSource: string
}

/**
 * Where auto-compaction runs, in tokens, by the session's own rules. The engine's threshold
 * when the breakdown has one; failing that, the compaction window the breakdown measured
 * against, when one was set (by the variable, the settings, the account; `auto` is only the
 * model's own limit); failing that, the window configured for the model (`configured`, from
 * `configuredCompactWindow`). Undefined when the breakdown says auto-compaction is off, or
 * nothing says where it runs.
 * `compactPoint(undefined, 400_000)` → 400_000.
 */
export function compactPoint(breakdown: CompactBreakdown | undefined, configured: number | undefined): number | undefined {
  if (breakdown?.isAutoCompactEnabled === false) return undefined
  if (breakdown?.autoCompactThreshold !== undefined) return breakdown.autoCompactThreshold
  if (breakdown !== undefined && breakdown.autocompactSource !== 'auto' && breakdown.rawMaxTokens > 0) return breakdown.rawMaxTokens
  return configured
}

/** A setting's value as a compaction window: a whole number of tokens above 0, from a number or its digits. */
function asWindow(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * The compaction window the person configured for `model`, in tokens: the
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` variable (`env`) first, then the model's own
 * `modelSettings` entry, then the settings' `autoCompactWindow`. A model id's bracketed suffix
 * (`[1m]`) is ignored, so `claude-opus-5-5[1m]` reads `modelSettings['claude-opus-5-5']`.
 * Undefined when none is set to a whole number of tokens.
 */
export function configuredCompactWindow(settings: Record<string, unknown>, model: string, env: string | undefined): number | undefined {
  const models = settings.modelSettings
  const own = typeof models === 'object' && models !== null ? (models as Record<string, unknown>)[model.replace(/\[.*\]$/, '')] : undefined
  const ownWindow = typeof own === 'object' && own !== null ? (own as Record<string, unknown>).autoCompactWindow : undefined
  return asWindow(env) ?? asWindow(ownWindow) ?? asWindow(settings.autoCompactWindow)
}

/**
 * What `isBreakpoint` reads, gathered by the Hub: whether a reply is running, whether the last
 * one had a failed tool call, whether the git tree is clean, and whether a commit landed in the
 * last 15 minutes.
 */
export type BreakSignals = {
  isRunning: boolean
  hadErrors: boolean
  isTreeClean: boolean
  committedRecently: boolean
}

/** A natural break: no reply running, the last one ended cleanly, and the work is in a settled state. */
export function isBreakpoint(s: BreakSignals): boolean {
  return !s.isRunning && !s.hadErrors && (s.isTreeClean || s.committedRecently)
}

/**
 * ARIA's advice line, and its dot colour as CSS hex, for a `zone`: red always says compact now,
 * amber says either that this is a good moment (at a break) or to wait for one. `tokens` is only
 * shown, rounded to thousands. Green returns undefined and the Hub shows the runway line
 * instead. The text is a button that opens Prep compact.
 */
export function adviceFor(zone: Zone, atBreak: boolean, tokens: number): { text: string; color: string } | undefined {
  const k = `${Math.round(tokens / 1000)}k`
  if (zone === 'red') return { text: `Compact now · ${k}`, color: '#f85149' }
  if (zone === 'amber' && atBreak) return { text: 'Good moment to /compact', color: '#3fb950' }
  if (zone === 'amber') return { text: `Compact at break · ${k}`, color: '#d29922' }
  return undefined
}

/** The zone in words, shown above the token count beside the Hub's context ring. */
export function zoneLabel(zone: Zone): string {
  if (zone === 'red') return 'compact now'
  if (zone === 'amber') return 'compact at a break'
  return 'sharp'
}
