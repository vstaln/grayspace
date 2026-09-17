import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Keep synchronized TUI frames intact, including their final cursor position.
// The system host rewrites the VT stream; the bundled host supports passthrough.
export const windowsPtyOptions = { useConpty: true, useConptyDll: true } as const
export const systemWindowsPtyOptions = { useConpty: true, useConptyDll: false } as const

/**
 * Every answer a ConPTY host can be waiting on before it releases the shell.
 *
 * The bundled host does not accept xterm's own VT100 primary answer
 * (`\x1b[?1;2c`): measured against cmd.exe it keeps withholding the shell for
 * ~3.1s, exactly as if nothing had replied, while a DA advertising more than
 * VT100 releases it in ~60ms. The rest are what a terminal would report at a
 * fresh prompt, and they are here so no startup question can go unanswered.
 */
const STARTUP_ANSWERS: Record<string, string> = {
  // Primary/secondary/tertiary device attributes.
  'c': '\x1b[?61;6;22c',
  '0c': '\x1b[?61;6;22c',
  '>c': '\x1b[>0;10;1c',
  '>0c': '\x1b[>0;10;1c',
  '=c': '\x1bP!|00000000\x1b\\',
  '=0c': '\x1bP!|00000000\x1b\\',
  // Cursor position, plain and extended. Nothing has been printed yet while
  // this filter is armed, so home is the true answer, not a guess.
  '6n': '\x1b[1;1R',
  '?6n': '\x1b[?1;1;1R'
}

/**
 * How much host preamble is scanned for startup queries before giving up, and
 * how large a single unterminated sequence may grow while it is held back.
 * Both bound the window in which this filter can touch the stream at all.
 */
const STARTUP_SCAN_LIMIT = 4096
const MAX_HELD_SEQUENCE = 512

interface SequenceMatch {
  end: number
  complete: boolean
  csiFinal?: string
  csiParams?: string
}

/**
 * Matches the escape sequence starting at `start` (which must be an ESC).
 * `complete: false` means the sequence runs past the end of the buffer, so the
 * caller has to wait for the rest of it rather than judging what it sees.
 */
function matchSequence(data: string, start: number): SequenceMatch {
  const next = data[start + 1]
  if (next === undefined) return { end: data.length, complete: false }
  if (next === '[') {
    let i = start + 2
    while (i < data.length && data.charCodeAt(i) >= 0x30 && data.charCodeAt(i) <= 0x3f) i += 1
    const paramsEnd = i
    while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) <= 0x2f) i += 1
    if (i >= data.length) return { end: data.length, complete: false }
    return { end: i + 1, complete: true, csiFinal: data[i], csiParams: data.slice(start + 2, paramsEnd) }
  }
  // OSC/DCS/SOS/PM/APC carry a payload terminated by BEL or ST. The window
  // title ConPTY emits on startup is one of these, and its text must not be
  // mistaken for the shell having printed something.
  if (next === ']' || next === 'P' || next === '^' || next === '_' || next === 'X') {
    const bel = data.indexOf('\x07', start + 2)
    const st = data.indexOf('\x1b\\', start + 2)
    if (bel < 0 && st < 0) return { end: data.length, complete: false }
    if (bel < 0) return { end: st + 2, complete: true }
    if (st < 0) return { end: bel + 1, complete: true }
    return { end: Math.min(bel + 1, st + 2), complete: true }
  }
  let i = start + 1
  while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) <= 0x2f) i += 1
  if (i >= data.length) return { end: data.length, complete: false }
  return { end: i + 1, complete: true }
}

/**
 * Answers the host's startup queries; does not replay them into the renderer.
 *
 * The bundled ConPTY host asks the terminal who it is and withholds the shell
 * until someone answers. The renderer's xterm would answer, but only once the
 * widget has attached — which is the multi-second startup pause the bundled
 * host was avoided for, and an indefinite one for a pty nobody opens.
 *
 * Answering here is what makes that wait bounded rather than a hang, so the
 * filter answers *every* query class a host can block on and keeps listening
 * until the shell speaks, instead of assuming a host asks exactly once. A
 * question nobody answers is the only way this path can stall, so it leaves
 * none.
 *
 * It disarms the moment the shell prints real text, so an application's own
 * device queries always reach the renderer and are answered by xterm itself.
 */
export function conptyStartupOutput(reply: (data: string) => void): (chunk: string) => string {
  let active = true
  let pending = ''
  let scanned = 0
  return (chunk) => {
    if (!active) return chunk
    const data = pending + chunk
    pending = ''
    let output = ''
    let copied = 0
    let i = 0
    while (i < data.length) {
      const code = data.charCodeAt(i)
      if (code === 0x1b) {
        const sequence = matchSequence(data, i)
        if (!sequence.complete) {
          // A query can straddle a transport boundary, so an unfinished
          // sequence is held rather than judged. A sequence that never ends is
          // not a handshake: release it and stop filtering.
          if (data.length - i > MAX_HELD_SEQUENCE) {
            active = false
            return output + data.slice(copied)
          }
          pending = data.slice(i)
          return output + data.slice(copied, i)
        }
        const answer = sequence.csiFinal
          ? STARTUP_ANSWERS[`${sequence.csiParams ?? ''}${sequence.csiFinal}`]
          : undefined
        if (answer !== undefined) {
          reply(answer)
          output += data.slice(copied, i)
          copied = sequence.end
        }
        i = sequence.end
        continue
      }
      // Whitespace and C0 controls are host framing, not shell output.
      if (code > 0x20 && code !== 0x7f) {
        active = false
        return output + data.slice(copied)
      }
      i += 1
    }
    scanned += data.length
    // A host that never asks must not leave this filter armed for the life of
    // the session, where it would swallow an application's own queries.
    if (scanned >= STARTUP_SCAN_LIMIT) active = false
    return output + data.slice(copied)
  }
}

/** portable-pty supports a sideloaded conpty.dll via LoadLibrary. */
export function rustPtyWorkingDirectory(): string {
  if (process.platform !== 'win32') return process.cwd()
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('@homebridge/node-pty-prebuilt-multiarch/package.json'))
    .replace(/\.asar([\\/])/, '.asar.unpacked$1')
  for (const build of ['Release', 'Debug']) {
    const directory = join(root, 'build', build, 'conpty')
    if (existsSync(join(directory, 'conpty.dll')) && existsSync(join(directory, 'OpenConsole.exe'))) return directory
  }
  throw new Error('Bundled conpty.dll and OpenConsole.exe are missing')
}

// node-pty is deliberately not primed the way the Rust engine is (see
// prime_conpty_handshake in native/orcspace-app/src/engine.rs): it creates its
// pseudoconsole without PSEUDOCONSOLE_INHERIT_CURSOR, so conhost never asks
// the terminal where the cursor is. The cursor answer above is kept anyway,
// because a host that does ask would otherwise wait forever, and answering a
// question that was asked is free.
