/**
 * ARIA, the Hub's mascot: her pixel-art face, the mood that picks it, the line she says, and
 * the two runway forecasts drawn beside her (turns until the context reaches the compaction
 * point, and when the 5-hour rate-limit window runs out).
 *
 * Everything here is pure. `register.tsx` feeds it the session's `HudSample` history in
 * `assess()`, then draws `ariaCells` and `trendCells` as terminal Raster cells and shows
 * `moodLine` and the forecasts as text. Token-based compaction advice lives in `compact.ts`;
 * `assess()` lets its zone raise the mood chosen here.
 */
import type { HudSample } from '../types'
import { base64, formatSpan, gradient } from './lib'

/** ARIA's four faces, from no reading at all (`sleep`) to act now (`alarm`). */
export type Mood = 'sleep' | 'happy' | 'focus' | 'alarm'

/**
 * Context percent (0-100) the runway counts towards when the session reports no
 * auto-compact point of its own (`usage.compactAt`).
 */
export const COMPACT_TARGET = 90

/** Raster colour word meaning "the terminal's own default colour" rather than an RGB value. */
const DEFAULT_COLOR = 0x01000000

/** The mood colour as 0xRRGGBB for Raster cells: the antenna tip and the eyes take it. */
const MOOD_COLOR: Record<Mood, number> = {
  sleep: 0x6e7681,
  happy: 0x3fb950,
  focus: 0xd29922,
  alarm: 0xf85149,
}

/**
 * The same mood colours as CSS hex, for text: the mood line, and the 5-hour pace when it hits.
 * Keep in step with `MOOD_COLOR`.
 */
export const MOOD_HEX: Record<Mood, string> = {
  sleep: '#6e7681',
  happy: '#3fb950',
  focus: '#d29922',
  alarm: '#f85149',
}

/** The fixed colours of the sprite, by the letter that stands for them in the pixel maps below. */
const PALETTE: Record<string, number> = {
  a: 0x6e7681, // antenna stem
  H: 0xc9d1d9, // head
  M: 0x30363d, // mouth
  S: 0x58a6ff, // tears: one beside the face, one on the cheek under the eye
  C: 0xf778ba, // cheeks
}

/** The antenna, the sprite's top two pixel rows: tip 'A' in the mood colour over stem 'a'. */
const TOP = ['.....AA.....', '.....aa.....']

/**
 * The eight pixel rows of the head for each mood, under `TOP`: 12x10 pixels, two per terminal
 * cell vertically, the last a narrower chin so a smile at the foot of the face never stands in
 * for it. She is a head alone, to fit in as few rows as she can. '.' is empty, 'A' and 'E' take the mood
 * colour, and every other letter is in `PALETTE`. Eyes sit on face rows 2 and 3, which is what
 * the blink in `ariaCells` relies on; the sleeping face has its closed eyes on row 3 only.
 */
const FACES: Record<Mood, string[]> = {
  happy: [
    '..HHHHHHHH..',
    '.HHHHHHHHHH.',
    '.HHEEHHEEHH.',
    '.HHEEHHEEHH.',
    '.HCHHHHHHCH.',
    '.HHMHHHHMHH.',
    '..HHMMMMHH..',
    '...HHHHHH...',
  ],
  focus: [
    '..HHHHHHHH..',
    '.HHHHHHHHHH.',
    '.HHEEHHEEHH.',
    '.HHEEHHEEHH.',
    '.HHHHHHHHHH.',
    '.HHHMMMMHHH.',
    '..HHHHHHHH..',
    '...HHHHHH...',
  ],
  alarm: [
    '..HHHHHHHH..',
    '.HHHHHHHHHHS',
    '.HEEEHHEEEHS',
    '.HEEEHHEEEH.',
    '.HHSHHHHHHH.',
    '.HHSHMMHHHH.',
    '..HHHMMHHH..',
    '...HHHHHH...',
  ],
  sleep: [
    '..HHHHHHHH..',
    '.HHHHHHHHHH.',
    '.HHHHHHHHHH.',
    '.HHEEHHEEHH.',
    '.HHHHHHHHHH.',
    '.HHHHMMHHHH.',
    '..HHHHHHHH..',
    '...HHHHHH...',
  ],
}

/** The sprite's width in terminal columns: one column per pixel. */
export const ARIA_COLUMNS = 12
/** The sprite's height in terminal rows: 10 pixel rows at two per cell. */
export const ARIA_ROWS = 5

/**
 * The mascot for `mood` as Raster cells: `ARIA_COLUMNS` x `ARIA_ROWS` cells, row-major, each
 * three little-endian uint32 words (glyph code point, foreground 0xRRGGBB, background), the
 * whole buffer base64-encoded for the Raster's `cells`. Each cell shows two pixels with a half
 * block: the top pixel as foreground, the bottom as background. The sleeping face adds a "z Z"
 * above her head.
 *
 * `isBlinking` closes the eyes for one frame: the Hub draws it with `true`, then again with
 * `false` 160 ms later. It has no visible effect on the sleeping face, whose eyes are already
 * shut, and the blink is never scheduled for it.
 */
export function ariaCells(mood: Mood, isBlinking = false): string {
  // Painting the upper eye row in head colour leaves a thin lower lid: a half-closed blink.
  const face = FACES[mood].map((row, i) => (isBlinking && i === 2 ? row.replaceAll('E', 'H') : row))
  const grid = [...TOP, ...face]
  // The grid is 12x10 and every letter in it is '.', 'A', 'E' or in PALETTE: a test draws every face to hold that.
  /** The 0xRRGGBB colour of pixel (`x`, `y`), or null where the sprite is transparent. */
  const color = (x: number, y: number): number | null => {
    const ch = grid[y]![x]!
    if (ch === '.') return null
    if (ch === 'A' || ch === 'E') return MOOD_COLOR[mood]
    return PALETTE[ch]!
  }

  const words = new Uint32Array(ARIA_COLUMNS * ARIA_ROWS * 3)
  for (let row = 0; row < ARIA_ROWS; row++) {
    for (let col = 0; col < ARIA_COLUMNS; col++) {
      // Word index of this cell's glyph; its foreground and background follow.
      const at = (row * ARIA_COLUMNS + col) * 3
      // Cell row `row` covers pixel rows 2*row and 2*row+1.
      const top = color(col, row * 2)
      const bottom = color(col, row * 2 + 1)
      if (top === null && bottom === null) {
        // A space on the default background, so the pane shows through.
        words.set([0x20, DEFAULT_COLOR, DEFAULT_COLOR], at)
      } else if (top === null) {
        // U+2584 lower half block: only the bottom pixel is painted.
        words.set([0x2584, bottom!, DEFAULT_COLOR], at)
      } else {
        // U+2580 upper half block: foreground is the top pixel, background the bottom one.
        words.set([0x2580, top, bottom ?? DEFAULT_COLOR], at)
      }
    }
  }
  // The snore letters land on cells that are blank in the sleeping sprite:
  // cell row 0 column 9, and cell row 1 column 11.
  if (mood === 'sleep') {
    words.set([0x7a, 0x8b949e, DEFAULT_COLOR], (0 * ARIA_COLUMNS + 9) * 3) // z
    words.set([0x5a, 0x8b949e, DEFAULT_COLOR], (1 * ARIA_COLUMNS + 11) * 3) // Z
  }
  return base64(new Uint8Array(words.buffer))
}

/**
 * Turns until the context reaches `target` percent (0-100) at the recent per-turn growth: the
 * Hub's "Runway" line. Only end-of-turn samples with a context reading count. Growth is the
 * average of the positive steps among the last seven readings, so a compaction (a drop) neither
 * counts as negative growth nor stalls the forecast. Returns 0 once the context is at or past
 * `target`, and undefined with no reading yet or no growth to extrapolate from (one reading, or
 * a flat or falling context). The result is rounded up.
 * Turn readings of 10, 20 and 30 give `6`: 60 points to go at 10 per turn.
 */
export function turnsToCompact(samples: readonly HudSample[], target = COMPACT_TARGET): number | undefined {
  const ctx = samples.filter(s => s.isTurn && s.ctx !== undefined).map(s => s.ctx!)
  const current = ctx.at(-1)
  if (current === undefined) return undefined
  if (current >= target) return 0
  // Seven readings give up to six steps: recent enough to follow the work,
  // enough to average out one big turn.
  // The first reading has no predecessor, so its 0 is dropped by the filter with the drops.
  const growth = ctx
    .slice(-7)
    .map((v, i, all) => (i === 0 ? 0 : v - all[i - 1]!))
    .filter(d => d > 0)
  if (growth.length === 0) return undefined
  const avg = growth.reduce((a, b) => a + b, 0) / growth.length
  return Math.ceil((target - current) / avg)
}

/**
 * When the 5-hour rate-limit window runs out: `learning` until there are three minutes of
 * readings, `steady` when usage is not rising, `safe` when the window resets before the
 * pace would reach 100%, and `hits` with `ms`, the milliseconds from now until it does.
 */
export type LimitForecast =
  | { kind: 'learning' }
  | { kind: 'steady' }
  | { kind: 'safe' }
  | { kind: 'hits'; ms: number }

/**
 * When the 5-hour window runs out at the pace of the last 90 minutes: the Hub's "5h pace" line.
 * The pace is the straight line from the first to the last 5-hour reading in that span (percent
 * per ms), not a fit through every sample. `now` and `resetsAt` are epoch ms; `resetsAt` is when
 * the window resets, if known. See `LimitForecast` for the four outcomes.
 * At 40% an hour ago and 70% now, `limitForecast` → `{ kind: 'hits', ms: 3_600_000 }`, or
 * `safe` when the window resets within that hour.
 */
export function limitForecast(samples: readonly HudSample[], now: number, resetsAt?: number): LimitForecast {
  // Ninety minutes, not the whole window: the forecast follows the current pace of work.
  const recent = samples.filter(s => s.five !== undefined && s.t >= now - 90 * 60_000)
  const first = recent[0]
  const last = recent.at(-1)
  // Under three minutes of readings the slope is mostly noise from a single turn.
  if (first === undefined || last === undefined || last.t - first.t < 3 * 60_000) return { kind: 'learning' }
  const slope = (last.five! - first.five!) / (last.t - first.t)
  if (slope <= 0) return { kind: 'steady' }
  // A reading already over 100% would give a negative span: that means now.
  const ms = Math.max(0, (100 - last.five!) / slope)
  if (resetsAt !== undefined && now + ms >= resetsAt) return { kind: 'safe' }
  return { kind: 'hits', ms }
}

/**
 * ARIA's mood from the worst of the session's signals. `ctx` is the context percent and `five`
 * the 5-hour window's percent used (both 0-100, undefined without a reading), `turnsLeft` comes
 * from `turnsToCompact` and `forecast` from `limitForecast`.
 *
 * `sleep` when neither percent has a reading yet. `alarm` at 80% or more, two turns or fewer
 * of runway, or the 5-hour limit due within 30 minutes. `focus` at 50% or more, eight turns or
 * fewer, or the limit due at all at this pace. `happy` otherwise. A missing percent counts as
 * 0, so one reading alone is enough to wake her. `register.tsx` then raises the mood by the
 * token zone from `zoneOf`, because a large window can be heavy at a small percent.
 */
export function moodOf(
  ctx: number | undefined,
  five: number | undefined,
  turnsLeft: number | undefined,
  forecast: LimitForecast,
): Mood {
  if (ctx === undefined && five === undefined) return 'sleep'
  const worst = Math.max(ctx ?? 0, five ?? 0)
  const isUrgent =
    (turnsLeft !== undefined && turnsLeft <= 2) || (forecast.kind === 'hits' && forecast.ms < 30 * 60_000)
  if (worst >= 80 || isUrgent) return 'alarm'
  const isWatch = (turnsLeft !== undefined && turnsLeft <= 8) || forecast.kind === 'hits'
  if (worst >= 50 || isWatch) return 'focus'
  return 'happy'
}

/**
 * What ARIA says for `mood`, in the mood colour after her name: short enough that `ARIA · ` and
 * it fit the 23 columns beside her head in a 40-column sidebar.
 */
export function moodLine(mood: Mood): string {
  if (mood === 'sleep') return 'Napping'
  if (mood === 'happy') return 'Cruising'
  if (mood === 'focus') return 'Watch the pace'
  return 'Time to /compact'
}

/**
 * The 5-hour window's forecast in words, ARIA's second row: `5h out in ~1h 20m` when the pace
 * runs it out, `5h safe till reset` when it resets first, `5h pace steady` when usage is not
 * rising, and `5h learning the pace` before there are readings enough. When it resets is the
 * limit's own row; each fits the 23 columns beside her head in a 40-column sidebar.
 * `forecastLine({ kind: 'hits', ms: 4_800_000 })` → `'5h out in ~1h 20m'`.
 */
export function forecastLine(forecast: LimitForecast): string {
  if (forecast.kind === 'hits') return `5h out in ~${formatSpan(forecast.ms)}`
  if (forecast.kind === 'safe') return '5h safe till reset'
  if (forecast.kind === 'steady') return '5h pace steady'
  return '5h learning the pace'
}

/**
 * Two rows of eighth-blocks, newest on the right: context fill on top, the
 * 5-hour window below, each column colored by its own level.
 *
 * One column per sample, the last `columns` samples, right-aligned so a short history leaves
 * blanks on the left. A sample missing one reading repeats the last value seen in this span, so
 * the row has no gaps; a row stays blank until its first reading. Even 0% draws the lowest
 * eighth, so a present reading never looks like a missing one. Returns base64 Raster cells,
 * `columns` x 2, laid out as in `ariaCells`. Drawn beside ARIA under the labels "ctx" and "5h".
 */
export function trendCells(samples: readonly HudSample[], columns: number): string {
  const words = new Uint32Array(columns * 2 * 3)
  const recent = samples.slice(-columns)
  // Columns left blank on the left while the history is shorter than the strip.
  const offset = columns - recent.length
  let ctx: number | undefined
  let five: number | undefined
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < columns; col++) {
      words.set([0x20, DEFAULT_COLOR, DEFAULT_COLOR], (row * columns + col) * 3)
    }
  }
  recent.forEach((s, i) => {
    ctx = s.ctx ?? ctx
    five = s.five ?? five
    const col = offset + i
    for (const [row, value] of [
      [0, ctx],
      [1, five],
    ] as const) {
      if (value === undefined) continue
      // Eight glyphs U+2581..U+2588 (one to eight eighths); 100% would be a ninth step,
      // so it is capped at the full block.
      const level = Math.min(7, Math.floor((Math.min(100, Math.max(0, value)) / 100) * 8))
      words.set([0x2581 + level, gradient(value / 100), DEFAULT_COLOR], (row * columns + col) * 3)
    }
  })
  return base64(new Uint8Array(words.buffer))
}
