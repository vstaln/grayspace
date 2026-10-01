/**
 * Getting a terminal back out of modes a dead application left it in.
 *
 * A full-screen agent turns on mouse reporting (and bracketed paste, and the
 * alternate buffer) on its way up, and turns them off again on its way out.
 * An agent that *crashes* never runs that second half, so the shell it drops
 * back to inherits every one of them without having asked for any. The mode
 * that makes the terminal unusable is mouse tracking: the emulator keeps
 * reporting pointer movement, and with no application left to read the
 * reports the shell echoes each one into the prompt —
 *
 *   ^[[<35;36;37M^[[<35;37;37M^[[<35;38;36M…
 *
 * — which is what a crashed opencode leaves behind, hundreds of lines of it
 * for a single pass of the pointer over the widget.
 *
 * There is no process exit to hook here: the pty is alive and well, it is the
 * thing that was *running inside it* that died. So the state is read back out
 * of the output instead, by the two independent signals below. Either one is
 * enough to justify re-asserting the modes a bare shell actually wants; both
 * are needed because neither covers every shell.
 *
 * Everything here runs on every byte the pty produces, so each signal is
 * gated by a substring test before any regex is allowed near the chunk.
 */

import { isShellOwnTitle, mayCarryTitle, terminalTitles } from './terminalStartupFailure.ts'

/**
 * Escape sequences, removed rather than replaced.
 *
 * The reports have to be read out of what the shell *drew*, not out of the
 * bytes it drew it with, and for PowerShell those are very different things.
 * PSReadLine repaints the input line with syntax highlighting, so a single
 * echoed report reaches the terminal as
 *
 *   [555 ESC[0m ESC[37m ; ESC[0m ESC[97m 87 ESC[0m ESC[37m ; … 30M
 *
 * — measured from a real ConPTY. Colour codes sit between every token. Taking
 * them out with no replacement leaves exactly the text on screen, which is
 * both what the pattern below matches and what makes two echoed reports
 * adjacent to each other again.
 */
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE =
  /\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_]/g

export function stripEscapes(text: string): string {
  return text.includes('\u001b') ? text.replace(ESCAPE_SEQUENCE, '') : text
}

/**
 * A mouse report appearing in *output*, as the shell rendered it.
 *
 * Mouse reports only ever travel towards the application, so one coming back
 * the other way was echoed by a shell that received it as ordinary typing.
 * How it is rendered is the shell's business and differs between them: cmd
 * keeps the caret notation and the `<` of the SGR form (`^[[<35;36;37M`),
 * while PowerShell drops both and draws `[555;87;30M`. The leading marker is
 * optional so one pattern covers what either of them puts on screen.
 */
const ECHOED_MOUSE_REPORT = /(?:\^\[)?\[<?\d{1,4};\d{1,5};\d{1,5}[Mm]/g

/**
 * How many *adjacent* echoed reports have to be seen before the terminal is
 * reset.
 *
 * A count on its own is not enough, because an agent is perfectly entitled to
 * *print* an escape sequence: a terminal emulator's own test output, or this
 * very file, contains several, and resetting the session underneath an agent
 * that merely displayed them would be a worse bug than the one being fixed.
 *
 * Adjacency is what separates the two. A pointer left reporting produces
 * reports back to back with nothing between them, because nothing else is
 * being typed; a report that got *printed* sits in prose. So only reports that
 * touch another report count, which makes displayed examples invisible to this
 * regardless of how many of them there are.
 */
const MOUSE_ECHO_THRESHOLD = 3

/**
 * How far apart two reports may sit and still count as back to back.
 *
 * Not zero: a shell that wraps the line inserts a CRLF between two echoed
 * reports, which is still one uninterrupted burst.
 */
const ADJACENT_GAP = 2

/** Longest echoed report, so a match split across two chunks is still seen. */
const CARRY_LIMIT = 24

/** A console title is short; this bounds what an unterminated one can hold. */
const TITLE_CARRY_LIMIT = 512

/**
 * The start of a report that has not arrived in full yet.
 *
 * Held-back text like `^[[<35;` or `[555;87` is the front of the next report,
 * between two of them, so a burst split across a transport boundary has to
 * stay one burst. Anything else separating two reports breaks the burst.
 */
const PARTIAL_REPORT = /^(?:\^\[)?\[?<?[\d;]*$/

export interface ModeRecoveryProbe {
  /** Tail of the previous chunk, re-scanned so no report straddles a boundary. */
  carry: string
  /** The carry continues a burst rather than interrupting it. */
  contiguous: boolean
  /** Reports counted in the current uninterrupted burst. */
  hits: number
  /** A console title has named a child, so there is an exit to wait for. */
  sawChild: boolean
  /** Unterminated tail of the previous chunk; a title can straddle two. */
  titleCarry: string
}

export function createModeRecoveryProbe(): ModeRecoveryProbe {
  return { carry: '', contiguous: false, hits: 0, sawChild: false, titleCarry: '' }
}

/**
 * Feed one chunk of terminal output; `true` means the shell is echoing mouse
 * reports and the emulator has to be taken out of mouse tracking.
 *
 * The probe resets its count on a positive verdict, so a caller that resets
 * the terminal and keeps feeding gets one verdict per burst rather than one
 * per chunk.
 */
export function readEchoedMouseReports(probe: ModeRecoveryProbe, chunk: string): boolean {
  // Stripped first: what the shell drew is what gets matched, and taking the
  // colour codes out is also what puts two echoed reports back next to each
  // other after PSReadLine has interleaved them.
  const scanned = stripEscapes(probe.carry ? `${probe.carry}${chunk}` : chunk)
  if (!scanned.includes('[')) {
    probe.carry = ''
    probe.contiguous = false
    probe.hits = 0
    return false
  }
  // A contiguous carry stands in for the report that ended just before it, so
  // a burst interrupted only by a transport boundary keeps its count.
  let previousEnd = probe.contiguous ? 0 : -1
  let consumed = 0
  let found = false
  for (const match of scanned.matchAll(ECHOED_MOUSE_REPORT)) {
    const start = match.index ?? 0
    // A report that touches the previous one continues the burst; one that
    // stands alone in other text starts a new burst of length 1.
    probe.hits = previousEnd >= 0 && start - previousEnd <= ADJACENT_GAP ? probe.hits + 1 : 1
    previousEnd = start + match[0].length
    consumed = previousEnd
    if (probe.hits >= MOUSE_ECHO_THRESHOLD) {
      probe.hits = 0
      previousEnd = -1
      found = true
    }
  }
  // Carry only what follows the last complete report, so a report counted in
  // this call can never be counted again in the next one, and cap it because
  // an unfinished report is short.
  const trailing = scanned.slice(consumed)
  probe.carry = trailing.slice(-CARRY_LIMIT)
  probe.contiguous =
    previousEnd >= 0 && (trailing.length <= ADJACENT_GAP || PARTIAL_REPORT.test(trailing))
  if (!probe.contiguous) probe.hits = 0
  return found
}

/** What the console titles in one chunk say about the shell's foreground child. */
export type ChildTitleEvent = 'started' | 'exited'

/**
 * What this chunk's console titles say about the shell's foreground child, or
 * `null` when they say nothing new.
 *
 * The *transition* is what counts, not the title on its own. A shell that
 * names itself and never renames (PowerShell does this) would otherwise read
 * as a child exiting on every repaint that re-emits the title, and would reset
 * a terminal belonging to an application that is still running.
 *
 * Unlike the launch-failure probe this runs for the life of the widget, not
 * for a window after a command is typed: an agent can crash at any point, and
 * the mode it leaves behind is just as unusable an hour in as it is at
 * startup. The same is true the other way round — an agent started by hand,
 * long after the launch window closed, is still news.
 */
export function readChildTitle(probe: ModeRecoveryProbe, chunk: string): ChildTitleEvent | null {
  // Joined with the carry first. A title sequence is not delivered atomically
  // — the pty splits wherever it likes — and a chunk holding only half of one
  // used to be dropped by both halves, so the exit it announced was never
  // seen. Measured on a real PowerShell that was exactly what happened: the
  // two titles of a whole agent run produced no events at all.
  const scanned = probe.titleCarry ? `${probe.titleCarry}${chunk}` : chunk
  // Keep only what follows the last terminated sequence, so no title is read
  // twice, and cap it because a console title is short.
  const lastEnd = Math.max(scanned.lastIndexOf('\u0007'), scanned.lastIndexOf('\u001b\\'))
  probe.titleCarry = (lastEnd >= 0 ? scanned.slice(lastEnd + 1) : scanned).slice(-TITLE_CARRY_LIMIT)
  // A tail with no escape and no BEL can never start or finish a title, so it
  // is not kept: holding 512 chars of plain prompt output forever would defeat
  // the widget's no-escape fast path below on every chunk. A split title
  // always carries its ESC through the carry, so nothing real is dropped.
  if (!probe.titleCarry.includes('\u001b') && !probe.titleCarry.includes('\u0007')) {
    probe.titleCarry = ''
  }
  if (!mayCarryTitle(scanned)) return null
  let event: ChildTitleEvent | null = null
  for (const title of terminalTitles(scanned)) {
    if (!isShellOwnTitle(title)) {
      // Titles inside one chunk are already in order, so a later one wins: a
      // launcher shim that restores the shell title on its way to starting the
      // agent must not read as an exit.
      event = probe.sawChild ? event : 'started'
      probe.sawChild = true
    } else if (probe.sawChild) {
      probe.sawChild = false
      event = 'exited'
    }
  }
  return event
}

/** Which signal is asking for the recovery. Kept for the caller's own logging. */
export type RecoveryReason =
  /** The shell echoed mouse reports, so a line editor is reading input. */
  | 'echo'
  /** A console title says the shell's foreground child is gone. */
  | 'child-exited'

/**
 * Whether the emulator is holding modes that no longer belong to anything.
 *
 * Both signals mean the same thing — nothing owns this terminal — so both get
 * the same answer, and the alternate buffer counts as evidence rather than as
 * a reason to stand down.
 *
 * It read the buffer the other way round at first: on the alternate screen an
 * application must still be up, so the echo signal was vetoed there. Measuring
 * a real PowerShell disproved the premise. An opencode killed the way a Bun
 * panic kills it leaves `1049h` with no `1049l`, so the terminal sits on the
 * alternate buffer *and* a shell line editor is echoing mouse reports into it
 * — the veto fired exactly when the recovery was needed, on the one signal
 * that works in that shell.
 *
 * A shell never asks for the alternate buffer. Being on it with nothing
 * running means whoever did ask never switched back.
 */
export function hasOrphanedModes(input: {
  bufferType: 'normal' | 'alternate'
  mouseTracking?: string
  /** Origin mode (DECOM `?6h`): a shell prompt never uses it; a dead TUI leaves it with its scroll region. */
  originMode?: boolean
  /** Synchronized output (`?2026h`) stuck on looks like a hung terminal: output buffers until `?2026l`. */
  synchronizedOutputMode?: boolean
  /** Insert mode (`IRM`): shells don't leave it on at a prompt. */
  insertMode?: boolean
  /** Auto-wrap (`?7`) is on at a healthy prompt; a TUI that turned it off and died leaves it off. */
  wraparoundMode?: boolean
}): boolean {
  if ((input.mouseTracking ?? 'none') !== 'none') return true
  if (input.bufferType === 'alternate') return true
  // After a clean `1049l` the cursor can still be trapped in the TUI's scroll
  // region (origin mode) or inside an unclosed synchronized-output frame.
  // This is the "Ctrl-C closed Codex, now I type at the very top" state:
  // mouse is off and the buffer is normal, so the two checks above say the
  // terminal is clean — but the shell prompt is constrained to row 1.
  if (input.originMode === true) return true
  if (input.synchronizedOutputMode === true) return true
  if (input.insertMode === true) return true
  if (input.wraparoundMode === false) return true
  return false
}
