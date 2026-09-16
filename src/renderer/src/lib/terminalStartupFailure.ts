/**
 * Why a freshly launched agent left its card blank.
 *
 * A code session types its agent command into a shell and then shows whatever
 * the agent paints. When the agent dies during startup it has usually already
 * cleared the screen, so the card goes black and stays that way — the pty is
 * still alive at a prompt, nothing has "crashed" as far as OrcSpace is
 * concerned, and the only trace is a line or two the TUI scrolled away.
 *
 * Two things are read out of the launch window, because a dying agent does not
 * reliably say anything at all:
 *
 *  - the failures that *do* print, above all the system running out of memory
 *    (a Bun/JSC agent such as opencode reserves ~1GB per instance and aborts
 *    when the commit limit is reached — with several sessions open on a
 *    machine without a page file that is the common case), and a command that
 *    is not installed;
 *  - the console title, which cmd.exe sets to `<shell> - <child>` while a
 *    child runs and puts back to the bare shell when it exits. A title that
 *    names the agent followed by one that names only the shell means the agent
 *    is gone, whether or not it managed to print a reason.
 */

/** How long after the command is typed a failure still counts as a launch failure. */
export const STARTUP_WATCH_MS = 30_000

/** Enough tail to hold a multi-line abort message, and nothing more. */
export const STARTUP_TAIL_LIMIT = 4000

const ESCAPES =
  // eslint-disable-next-line no-control-regex
  /\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/**
 * ConPTY interleaves cursor moves with the text it repaints, so the readable
 * form is the escape-free one with runs of whitespace collapsed.
 */
export function plainTerminalText(text: string): string {
  return text.replace(ESCAPES, ' ').replace(/\s+/g, ' ')
}

// eslint-disable-next-line no-control-regex
const TITLE_SEQUENCE = /\u001b\]0;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g

/** The console titles set in `text`, oldest first. */
export function terminalTitles(text: string): string[] {
  const titles: string[] = []
  for (const match of text.matchAll(TITLE_SEQUENCE)) titles.push(match[1])
  return titles
}

const MEMORY_MARKERS = [
  'memory full',
  'memoryexhaustion',
  'memory is exhausted',
  'out of memory',
  'not enough memory',
  'insufficient memory',
  'cannot allocate memory'
]

const MISSING_MARKERS = [
  'is not recognized as an internal or external command',
  'is not recognized as the name of a cmdlet',
  'не является внутренней или внешней командой',
  'command not found',
  'commandnotfoundexception'
]

/** A title that names a shell and nothing else — the child is gone. */
function isBareShellTitle(title: string): boolean {
  const value = title.trim().toLowerCase()
  if (!value) return false
  return /(?:^|[\\/])(?:cmd|powershell|pwsh|bash|zsh|sh)(?:\.exe)?$/.test(value)
}

export function executableName(command: string): string {
  return /^\s*["']?([^\s"']+)/.exec(command)?.[1] ?? command.trim()
}

/**
 * A one-line explanation for the card, or `null` when the output says nothing
 * about a failed launch.
 *
 * A marker anywhere in the launch window is what decides, because the crash
 * text of an agent that already repainted the screen rarely sits next to the
 * command line that started it.
 */
export function startupFailureMessage(output: string, command: string): string | null {
  const text = plainTerminalText(output).toLowerCase()
  const name = executableName(command) || 'The command'
  if (MEMORY_MARKERS.some((marker) => text.includes(marker))) {
    return `${name} could not start: the system ran out of memory. Close other sessions or free memory, then launch it again.`
  }
  if (MISSING_MARKERS.some((marker) => text.includes(marker))) {
    return `${name} could not start: the command was not found on PATH.`
  }
  return null
}

export interface StartupProbe {
  command: string
  /** Output seen so far in this launch window, capped at STARTUP_TAIL_LIMIT. */
  tail: string
  /** A console title has named the agent, so it did get as far as running. */
  started: boolean
  /** Titles can straddle two chunks; this is the unmatched remainder. */
  carry: string
}

export function createStartupProbe(command: string): StartupProbe {
  return { command, tail: '', started: false, carry: '' }
}

/**
 * Feed one chunk of terminal output; returns the failure message the chunk
 * completed the case for, or `null` while nothing is wrong.
 */
export function readStartupOutput(probe: StartupProbe, chunk: string): string | null {
  probe.tail = `${probe.tail}${chunk}`.slice(-STARTUP_TAIL_LIMIT)
  const spoken = startupFailureMessage(probe.tail, probe.command)
  if (spoken) return spoken

  const name = executableName(probe.command).toLowerCase()
  const scanned = `${probe.carry}${chunk}`
  for (const title of terminalTitles(scanned)) {
    if (title.toLowerCase().includes(name)) probe.started = true
    else if (probe.started && isBareShellTitle(title)) {
      return `${executableName(probe.command)} exited right after starting — the terminal is back at its shell prompt.`
    }
  }
  // Carry only what follows the last terminated sequence, so no title is ever
  // scanned twice, and cap it because a console title is short.
  const lastTerminator = Math.max(scanned.lastIndexOf('\u0007'), scanned.lastIndexOf('\u001b\\'))
  probe.carry = (lastTerminator >= 0 ? scanned.slice(lastTerminator + 1) : scanned).slice(-256)
  return null
}
