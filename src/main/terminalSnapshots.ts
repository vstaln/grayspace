import * as fs from 'fs'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { readStoreJson, sanitizeScrollbackNative, writeJsonAtomic, writeJsonAtomicAsync, writeTextAtomic, writeTextAtomicAsync } from './storage.ts'
import { getUserDataDir } from './userData.ts'

export const TERMINAL_SCHEMA_VERSION = 1

/** Scrollback kept per terminal. Build logs reach megabytes; this is the budget. */
const MAX_SCROLLBACK_BYTES = 64 * 1024

export interface TerminalSnapshot {
  id: string
  title: string
  cwd: string
  /** Byte length of the saved scrollback; the text lives in its own file. */
  bytes: number
  savedAt: number
}

/**
 * Terminals across a restart, the honest way.
 *
 * A PTY is an OS child of this process and dies with it — there is no saving
 * that, short of a detached broker process, which on Windows means writing one
 * over ConPTY and named pipes. So what is restored is the *context*: the
 * working directory, the title, and the text that was on screen. Reopening a
 * terminal renders the saved scrollback as static text and starts a fresh
 * shell in the same directory, and a `npm run dev` that was running is simply
 * gone — visibly, rather than pretending otherwise.
 *
 * Scrollback lives in one file per terminal, never in the layout JSON: opening
 * a workspace must not block on parsing megabytes of build output before it
 * can draw a single widget.
 */
export class TerminalSnapshots {
  private index: Record<string, TerminalSnapshot> = {}
  private loaded = false
  /** Set once before-quit has durably saved everything; blocks late saveAsync. */
  private shuttingDown = false
  /** Debounce for the index file on the non-durable path. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Per-id write generations. `forget()` invalidates any in-flight `saveAsync`
   * so a slow scrollback write cannot resurrect a .log file that was already
   * deleted (and whose index entry no longer exists — an orphan nobody's
   * prune() would ever see again).
   */
  private readonly generations = new Map<string, number>()

  private get dir(): string {
    return join(getUserDataDir(), 'terminals')
  }

  private get indexFile(): string {
    return join(this.dir, 'index.json')
  }

  private ensure(): void {
    if (this.loaded) return
    // Loaded only after the read succeeded — a transient EBUSY/EACCES on the
    // index must not leave snapshots invisible for the whole session.
    const raw = readStoreJson<{ schemaVersion?: number; terminals?: Record<string, TerminalSnapshot> }>(
      this.indexFile,
      {}
    )
    this.loaded = true
    this.index = raw.terminals && typeof raw.terminals === 'object' ? raw.terminals : {}
  }

  /** Marks the store as shutting down: saveAsync becomes a no-op. */
  beginShutdown(): void {
    this.shuttingDown = true
  }

  list(): TerminalSnapshot[] {
    this.ensure()
    return Object.values(this.index)
  }

  get(id: string): TerminalSnapshot | undefined {
    this.ensure()
    return this.index[id]
  }

  /** The saved screen for a terminal, or an empty string when there is none. */
  scrollback(id: string): string {
    this.ensure()
    if (!this.index[id]) return ''
    try {
      return fs.readFileSync(this.scrollbackFile(id), 'utf8')
    } catch {
      return ''
    }
  }

  /**
   * Persists one terminal's screen, blocking until the bytes are on disk.
   * Used at shutdown, where Electron is about to tear the process down and
   * there is no "later" for an async write to land in. For the interactive
   * close path — where the user is waiting on the UI, not the process exiting
   * — use `saveAsync` instead.
   */
  save(input: { id: string; title: string; cwd: string; scrollback: string }): void {
    this.ensure()
    const { text, entry } = this.prepare(input)
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      writeTextAtomic(this.scrollbackFile(input.id), text)
    } catch (err) {
      console.error(`failed to persist scrollback for ${input.id}`, err)
      return
    }
    this.index[input.id] = entry
    this.flush()
  }

  /**
   * Same contract as `save`, but the write never blocks the caller.
   *
   * This is the hot path: it runs every time a terminal is closed, which used
   * to mean two synchronous fsyncs (the scrollback file and the index) on the
   * Electron main thread — the same thread serving every IPC call, every pty
   * chunk and the window itself. An fsync on a disk busy running the user's
   * own builds costs tens of milliseconds; closing three shells in a row
   * stalled the window each time. Nothing here waits on the result, and a
   * snapshot lost to a crash in that window is a screen the user had just
   * closed anyway.
   */
  saveAsync(input: { id: string; title: string; cwd: string; scrollback: string }): void {
    this.ensure()
    // Shutdown saves durably via `save()` first, then disposeAll() re-emits
    // `release` for every terminal — re-running here would asynchronously
    // truncate the just-flushed scrollback while Electron is tearing down.
    if (this.shuttingDown) return
    const { text, entry } = this.prepare(input)
    const gen = this.generations.get(input.id) ?? 0
    this.index[input.id] = entry
    void (async () => {
      try {
        await fsp.mkdir(this.dir, { recursive: true })
        if ((this.generations.get(input.id) ?? 0) !== gen) return
        // Temp + fsync + rename, not a bare truncating writeFile: a cutoff
        // mid-write must never leave a zero-length .log behind an index entry
        // that claims bytes > 0.
        await writeTextAtomicAsync(this.scrollbackFile(input.id), text)
        // The write raced a forget(): delete the file it just recreated,
        // otherwise it is orphaned on disk forever (prune only walks index keys).
        if ((this.generations.get(input.id) ?? 0) !== gen) {
          if (this.index[input.id] === entry) delete this.index[input.id]
          this.scheduleFlush()
          await fsp.rm(this.scrollbackFile(input.id), { force: true }).catch(() => {})
        }
      } catch (err) {
        // The index must not claim a screen that never reached disk, or the
        // next open would restore an empty pane as if it were the saved one.
        console.error(`failed to persist scrollback for ${input.id}`, err)
        if (this.index[input.id] === entry) {
          delete this.index[input.id]
          // The debounced flush may already have written this entry to disk;
          // without a rewrite the stale record survives restarts.
          this.scheduleFlush()
        }
      }
    })()
    this.scheduleFlush()
  }

  private prepare(input: { id: string; title: string; cwd: string; scrollback: string }): {
    text: string
    entry: TerminalSnapshot
  } {
    // Strip escape sequences before persisting: a saved scrollback is later
    // replayed into xterm via term.write(), and raw OSC/CSI sequences would
    // re-run their effects then (OSC 52 sets the clipboard, CSI repaints
    // cursor state). Only the text that was on screen is kept (P5).
    // Rust path first (one zero-copy scan instead of two per-char JS passes);
    // `tail(sanitizeAnsi(...))` below is the byte-identical TS fallback.
    const text = sanitizeScrollbackNative(input.scrollback, MAX_SCROLLBACK_BYTES) ?? tail(sanitizeAnsi(input.scrollback), MAX_SCROLLBACK_BYTES)
    return {
      text,
      entry: {
        id: input.id,
        title: input.title,
        cwd: input.cwd,
        bytes: Buffer.byteLength(text),
        savedAt: Date.now()
      }
    }
  }

  forget(id: string): void {
    this.ensure()
    // Invalidate an in-flight saveAsync before removing anything.
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    if (!this.index[id]) return
    delete this.index[id]
    // Same reasoning as `save`: this runs when the user closes a terminal, and
    // an unlink plus a synchronous index rewrite do not belong on the UI thread.
    void fsp.rm(this.scrollbackFile(id), { force: true }).catch(() => {
      /* a leftover file is harmless */
    })
    this.scheduleFlush()
  }

  /** Drops snapshots for terminals no widget refers to any more. */
  prune(liveIds: Iterable<string>): void {
    this.ensure()
    const keep = new Set(liveIds)
    for (const id of Object.keys(this.index)) if (!keep.has(id)) this.forget(id)
  }

  private scrollbackFile(id: string): string {
    // Ids are app-generated (`term-…`, `agent-…`, `terminal-…`), but this is a
    // filename, so anything outside the safe set is replaced rather than
    // trusted to stay inside the directory.
    return join(this.dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.log`)
  }

  /** Blocking index write. Shutdown and `prune` on teardown only. */
  private flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    try {
      writeJsonAtomic(this.indexFile, { schemaVersion: TERMINAL_SCHEMA_VERSION, terminals: this.index })
    } catch (err) {
      console.error('failed to persist the terminal index', err)
    }
  }

  /** Coalesces the index rewrite; closing several terminals in a row writes it once. */
  private scheduleFlush(): void {
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const snapshot = { schemaVersion: TERMINAL_SCHEMA_VERSION, terminals: { ...this.index } }
      void writeJsonAtomicAsync(this.indexFile, snapshot).catch((err) => {
        console.error('failed to persist the terminal index', err)
      })
    }, 400)
    this.flushTimer.unref?.()
  }

  /** Forces a debounced index write out synchronously. Called on shutdown. */
  flushNow(): void {
    if (this.flushTimer === null) return
    this.flush()
  }
}

/**
 * Last `limit` bytes, cut at a line boundary so the top is not half a line.
 *
 * The slice has to happen on bytes, not characters: `String.slice` counts
 * UTF-16 units, so a scrollback of Cyrillic or box-drawing output kept two to
 * three times the byte budget it was supposed to.
 */
function tail(text: string, limit: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= limit) return text
  // Starting mid-character decodes to U+FFFD; the newline cut normally removes
  // it along with the rest of the partial first line.
  const cut = buf.subarray(buf.length - limit).toString('utf8')
  const newline = cut.indexOf('\n')
  return newline >= 0 ? cut.slice(newline + 1) : cut.replace(/^�+/, '')
}

/**
 * Removes ANSI escape sequences, keeping only the visible text. Covers CSI
 * (`ESC [ … final-byte`), OSC (`ESC ] … BEL|ST`) and the character-set
 * selectors (`ESC ( X`), because a scrollback that is later fed back into a
 * terminal must not re-execute side effects such as clipboard writes (OSC 52).
 */
function sanitizeAnsi(text: string): string {
  // Runs of plain text are collected as slices, not built one character at a
  // time: this walks the whole scrollback (up to OUTPUT_BUFFER_LIMIT) on every
  // terminal close, and a `out += ch` loop meant tens of thousands of string
  // concatenations on the Electron main thread each time.
  const parts: string[] = []
  let plainFrom = 0
  let i = 0
  const n = text.length
  const isFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e
  const cut = (upTo: number, resumeAt: number): void => {
    if (upTo > plainFrom) parts.push(text.slice(plainFrom, upTo))
    plainFrom = resumeAt
  }
  while (i < n) {
    const ch = text[i]
    if (ch === '\x1b' && i + 1 < n) {
      const next = text[i + 1]
      if (next === '[') {
        const start = i
        i += 2
        while (i < n && !isFinal(text.charCodeAt(i))) i += 1
        i += i < n ? 1 : 0
        cut(start, i)
        continue
      }
      if (next === ']') {
        const start = i
        i += 2
        while (i < n && text[i] !== '\x07' && !(text[i] === '\x1b' && text[i + 1] === '\\')) i += 1
        if (i >= n) {
          cut(start, i)
          continue
        }
        i += text[i] === '\x07' ? 1 : 2
        cut(start, i)
        continue
      }
      if (next === '(' || next === ')' || next === '*' || next === '+') {
        const start = i
        i += Math.min(3, n - i)
        cut(start, i)
        continue
      }
      // DCS / SOS / PM / APC: ESC P / X / ^ / _ … ST
      if (next === 'P' || next === 'X' || next === '^' || next === '_') {
        const start = i
        i += 2
        while (i < n && !(text[i] === '\x1b' && text[i + 1] === '\\')) i += 1
        i += i < n ? 2 : 0
        cut(start, i)
        continue
      }
    }
    const code = text.charCodeAt(i)
    if (code === 0x9b || code === 0x9d || code === 0x90 || code === 0x9e || code === 0x9f) {
      cut(i, i + 1)
      i += 1
      continue
    }
    i += 1
  }
  if (i > plainFrom) parts.push(text.slice(plainFrom, i))
  return parts.join('')
}
