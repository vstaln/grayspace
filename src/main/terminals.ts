import { EventEmitter } from 'events'
import * as os from 'os'
import * as fs from 'fs'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import { OUTPUT_BUFFER_LIMIT, MAX_TERMINAL_WRITE_BYTES, defaultShell } from './config.ts'
import { killProcessTree } from './procTree.ts'
import { orcTerminalEnv } from './orcCli.ts'
import { TerminalRingBuffer } from './terminalBuffer.ts'

/**
 * Drops every spelling of PATH before the shim directory is prepended.
 *
 * Windows environment blocks are case-insensitive but a plain object is not:
 * inheriting `Path` and then setting `PATH` hands the shell two variables and
 * lets it pick, which silently loses the `orc` entry about half the time.
 */
function withoutPath(env: Record<string, string>): Record<string, string> {
  const copy: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === 'PATH') continue
    copy[key] = value
  }
  return copy
}

export interface TerminalInfo {
  id: string
  title: string
  cwd: string
  alive: boolean
}

export interface SpawnResult {
  ok: boolean
  error?: string
  /** True when the widget reattached to a process that never died. */
  reconnected?: boolean
}

interface TerminalRecord {
  pty: IPty | null
  title: string
  cwd: string
  /**
   * Scrollback, chunked so an append never copies the whole buffer. See
   * TerminalRingBuffer — this is the hot path for every byte every pty prints.
   */
  output: TerminalRingBuffer
  /**
   * Byte position up to which agents have already read the buffer, counted in
   * bytes since the pty started (not an index into the retained window, which
   * moves as old chunks are dropped). Agent reads (`read_output?clear=1`)
   * advance this pointer instead of wiping the user's scrollback — the widget
   * and restart snapshots keep the full buffer while agents only ever see new
   * output (P6).
   */
  readOffset: number
  /** PID of the process node-pty started; the ancestor for the survivor sweep. */
  rootPid?: number
  /** When the pty last emitted anything — how "is this shell idle?" is answered. */
  lastDataAt: number
  /** True when the underlying process has exited. */
  exited?: boolean
}

/**
 * Owns every pty in the app. A terminal is first *reserved* (which allocates an
 * id and remembers its title/cwd) and only later *spawned*, once the renderer
 * has mounted the matching widget and can report its real cols/rows. Spawning
 * with the true size up front matters: a resize sent before the pty exists is
 * silently dropped and full-screen TUIs then render against the wrong geometry.
 */
export class TerminalManager extends EventEmitter {
  private readonly terminals = new Map<string, TerminalRecord>()
  // Ids never repeat (the counter only increments), so a disposed id can be
  // remembered; this blocks the P3-012 resurrection race. The list is capped
  // so a long session that opens and closes hundreds of shells cannot grow it
  // without bound — old ids are safe to forget because the counter never
  // reissues them.
  private readonly disposed = new Set<string>()
  private readonly disposedOrder: string[] = []
  private static readonly DISPOSED_CAP = 4_096
  private counter = 0
  /**
   * Last shell the user focused (or we just spawned). The assistant uses this
   * when the model says "the terminal" / `terminal:new` without a real id.
   */
  private preferredId: string | null = null

  /**
   * The lowest `Agent Terminal N` not currently open. Numbers are reused once
   * a terminal is closed, matching how the canvas names the ones the user
   * opens by hand — otherwise a single agent terminal on an empty canvas ends
   * up called "Agent Terminal 9", which says nothing useful.
   */
  private nextAgentNumber(): number {
    const taken = new Set<number>()
    for (const record of this.terminals.values()) {
      const match = /^Agent Terminal (\d+)$/.exec(record.title)
      if (match) taken.add(Number(match[1]))
    }
    let n = 1
    while (taken.has(n)) n += 1
    return n
  }

  private nextId(prefix: string): string {
    this.counter += 1
    return `${prefix}-${Date.now()}-${this.counter}`
  }

  /** Reserves an id and its metadata without starting a process yet. */
  reserve(options: { title?: string; cwd?: string; prefix?: string } = {}): TerminalInfo {
    const prefix = options.prefix || 'term'
    const id = this.nextId(prefix)
    // Agent-opened terminals always get this label, on purpose — whatever title
    // the agent asked for is not used. Without a fixed, predictable name the
    // user can't tell an agent's terminal apart from one they opened themselves
    // at a glance, which is the entire point of naming it differently.
    const title = options.title?.trim() || (prefix === 'agent' ? `Agent Terminal ${this.nextAgentNumber()}` : id)
    const record: TerminalRecord = {
      pty: null,
      title,
      cwd: this.resolveCwd(options.cwd),
      output: new TerminalRingBuffer({ maxBytes: OUTPUT_BUFFER_LIMIT }),
      readOffset: 0,
      lastDataAt: 0
    }
    this.terminals.set(id, record)
    return this.toInfo(id, record)
  }

  private resolveCwd(cwd?: string): string {
    if (cwd) {
      try {
        // The path can disappear between exists/stat (or be inaccessible),
        // especially when an agent points at a removable/network drive.
        if (fs.statSync(cwd).isDirectory()) return cwd
      } catch {
        /* fall back to a known-good directory */
      }
    }
    return os.homedir()
  }

  private toInfo(id: string, record: TerminalRecord): TerminalInfo {
    return { id, title: record.title, cwd: record.cwd, alive: record.pty !== null }
  }

  has(id: string): boolean {
    return this.terminals.has(id)
  }

  isRunning(id: string): boolean {
    return this.terminals.get(id)?.pty != null
  }

  list(): TerminalInfo[] {
    return Array.from(this.terminals, ([id, record]) => this.toInfo(id, record))
  }

  /**
   * Starts the shell for a reserved id (or auto-reserves one for UI-created
   * terminals). Emits `data` and `exit` events keyed by terminal id.
   * `{ ok: true }` covers both a fresh spawn and an already-running terminal
   * (workspace switch / remount) — the renderer only needs to know the pty is
   * live. Reconnects set `reconnected: true` so the UI can paint the live
   * buffer without claiming the process was restarted.
   */
  spawn(id: string, cols?: number, rows?: number, cwd?: string): SpawnResult {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id))
      return { ok: false, error: 'invalid terminal id' }
    // A widget racing a slow renderer mount (control-server creation timed out
    // and disposed the reservation first) must not resurrect the id as a fresh
    // auto-reserved record — that leaves a pty that no widget backs.
    if (this.disposed.has(id)) return { ok: false, error: 'terminal was closed' }
    let record = this.terminals.get(id)
    if (record?.pty) {
      // Widget came back (other project folder, redraw). Same process — Claude,
      // npm run dev, whatever — is still running; only re-sync geometry.
      if (isPositiveInt(cols) && isPositiveInt(rows)) {
        try {
          record.pty.resize(cols, rows)
        } catch (err) {
          console.warn(`failed to resize reconnected terminal ${id}`, err)
        }
      }
      this.preferredId = id
      return { ok: true, reconnected: true }
    }
    if (!record) {
      record = {
        pty: null,
        title: id,
        cwd: this.resolveCwd(cwd),
        output: new TerminalRingBuffer({ maxBytes: OUTPUT_BUFFER_LIMIT }),
        readOffset: 0,
        lastDataAt: 0
      }
      this.terminals.set(id, record)
    }

    try {
      const child = pty.spawn(defaultShell(), [], {
        name: 'xterm-256color',
        cols: isPositiveInt(cols) ? cols : 80,
        rows: isPositiveInt(rows) ? rows : 24,
        cwd: record.cwd,
        // Lets anything started in this shell — a CLI agent asked to "create
        // a terminal" or otherwise act on its surroundings — tell it's
        // running inside an OrcSpace-managed terminal rather than a bare one,
        // without having to guess from the process tree.
        env: {
          ...withoutPath(process.env as Record<string, string>),
          // Puts `orc` on the agent's PATH and tells it which app, which token
          // and which actor it is. This is the whole of the integration: a CLI
          // agent coordinates by typing a command, not by speaking a protocol.
          ...orcTerminalEnv(id),
          ORCSPACE: '1',
          ORCSPACE_TERMINAL_ID: id,
          // "light foreground on black background", the conventional way a
          // terminal tells a TUI it is dark. Belt to the OSC 11 answer's braces:
          // programs that never ask, or that ask before the theme is applied,
          // would otherwise guess light and paint a white pane in a dark widget.
          COLORFGBG: '15;0'
        }
      })
      record.pty = child
      record.rootPid = child.pid
      this.preferredId = id

      child.onData((chunk) => {
        const current = this.terminals.get(id)
        if (!current || current.pty !== child) return
        current.output.append(chunk)
        current.lastDataAt = Date.now()
        this.emit('data', id, chunk)
      })
      child.onExit(({ exitCode }) => {
        this.handlePtyExit(id, child, exitCode)
      })
      return { ok: true }
    } catch (err) {
      console.error(`failed to spawn terminal ${id}`, err)
      return { ok: false, error: String(err) }
    }
  }

  /**
   * Writes into a live pty. Returns whether bytes were actually delivered —
   * callers must not claim "typed into the shell" on a silent no-op.
   */
  write(id: string, data: string): { ok: true } | { ok: false; error: string } {
    if (typeof data !== 'string' || typeof id !== 'string') {
      return { ok: false, error: 'invalid write' }
    }
    // A cap keeps an oversized write from growing the pty buffer unboundedly (SEC-010).
    if (data.length > MAX_TERMINAL_WRITE_BYTES) {
      return { ok: false, error: `write exceeds ${MAX_TERMINAL_WRITE_BYTES} characters` }
    }
    const record = this.terminals.get(id)
    if (!record) return { ok: false, error: `terminal ${id} not found` }
    if (!record.pty) return { ok: false, error: `terminal ${id} is not running` }
    try {
      record.pty.write(data)
      this.preferredId = id
      return { ok: true }
    } catch (err) {
      // node-pty may throw if the native handle closed between the lookup and
      // write.  A lost keystroke is recoverable; crashing Electron is not.
      console.warn(`failed to write to terminal ${id}`, err)
      return { ok: false, error: String((err as Error)?.message ?? err) }
    }
  }

  /** Remember which shell the user is looking at (for "type into the terminal"). */
  markPreferred(id: string): void {
    if (typeof id === 'string' && this.terminals.has(id)) this.preferredId = id
  }

  /** Keeps the shell list label in sync when the canvas widget is renamed. */
  setTitle(id: string, title: string): void {
    const record = this.terminals.get(id)
    if (!record) return
    const next = title.trim()
    if (next) record.title = next
  }

  /**
   * Best terminal for an agent write when the plan used `terminal:new` or a
   * stale/wrong id: preferred (focused) first, else the only alive shell, else
   * the most recently reserved alive one.
   */
  resolveWriteTarget(requestedId: string): string | null {
    if (requestedId && this.isRunning(requestedId)) return requestedId
    if (this.preferredId && this.isRunning(this.preferredId)) return this.preferredId
    const alive = this.list().filter((t) => t.alive)
    if (alive.length === 1) return alive[0].id
    if (alive.length > 1) return alive[alive.length - 1].id
    return null
  }

  resize(id: string, cols: number, rows: number): void {
    if (!isPositiveInt(cols) || !isPositiveInt(rows)) return
    try {
      this.terminals.get(id)?.pty?.resize(cols, rows)
    } catch (err) {
      // Resize events can arrive after a shell exits or while its native pty
      // is being torn down.  Treat that race as a no-op.
      console.warn(`failed to resize terminal ${id}`, err)
    }
  }

  /**
   * Agent-facing read of the buffer: everything the agent has not read yet.
   * `clear=1` advances the read pointer only — the user's scrollback is left
   * intact so an agent draining output can never erase what the user sees or
   * what a restart snapshot will keep (P6).
   */
  readOutput(id: string, clear = false): string | null {
    const record = this.terminals.get(id)
    if (!record) return null
    // A reader whose pointer fell off the retained window resumes at the
    // oldest byte still held rather than re-reading the whole scrollback.
    const since = Math.max(record.readOffset, record.output.startOffset)
    const { data, newOffset } = record.output.read(since, OUTPUT_BUFFER_LIMIT)
    if (clear) record.readOffset = newOffset
    return data
  }

  /** Feeds the scrollback directly. Used by tests and by restore paths that
   *  have output to seed without a live pty behind it. */
  appendOutput(id: string, chunk: string): void {
    this.terminals.get(id)?.output.append(chunk)
  }

  /** The full scrollback for the widget/restart — never affected by agent reads. */
  fullOutput(id: string): string | null {
    const record = this.terminals.get(id)
    if (!record) return null
    return record.output.toString()
  }

  /**
   * When this pty last printed something, or 0 if it never has. The usage
   * watcher uses it to tell a shell sitting at an idle prompt from one that is
   * mid-generation, so an automatic `/usage` never lands in the middle of a
   * running turn.
   */
  lastDataAt(id: string): number {
    return this.terminals.get(id)?.lastDataAt ?? 0
  }

  /**
   * Intentional close (user X, agent dispose, create timeout). The id is
   * banned so a late remount cannot resurrect an orphaned pty (P3-012).
   */
  /**
   * A late `onExit` from a previous process must not wipe or tree-kill a
   * shell that already replaced it on the same widget id (remount / restart).
   */
  handlePtyExit(id: string, child: IPty, exitCode: number): void {
    const current = this.terminals.get(id)
    if (!current || current.pty !== child) return
    current.pty = null
    current.exited = true
    this.emit('exit', id, exitCode)
    // The shell is gone, but anything it spawned detached (Start-Process,
    // a new console session) survives unseen. Sweep survivors exactly like
    // an explicit close does, best-effort and after a settle delay (P5).
    killProcessTree(current.rootPid)
    // Do not keep the stale pid around: Windows recycles pids quickly, and a
    // later release()/disposeAll() would then taskkill an innocent process.
    current.rootPid = undefined
  }

  dispose(id: string): void {
    this.release(id)
    this.banId(id)
  }

  private banId(id: string): void {
    if (this.disposed.has(id)) return
    this.disposed.add(id)
    this.disposedOrder.push(id)
    if (this.disposedOrder.length <= TerminalManager.DISPOSED_CAP) return
    const drop = this.disposedOrder.splice(0, 1_024)
    for (const old of drop) this.disposed.delete(old)
  }

  /**
   * Kill the shell and free the slot without permanently banning the id.
   * Used for app quit / crash teardown where the canvas may remount later in
   * a new process (ids must stay spawnable). Emits `release` so callers can
   * persist scrollback before the buffer is gone.
   */
  release(id: string): { id: string; title: string; cwd: string; scrollback: string } | null {
    const record = this.terminals.get(id)
    if (!record) return null
    const scrollback = record.output.toString()
    // Only a shell that is still alive owns a valid rootPid. Killing the tree
    // of an already-exited terminal would taskkill a recycled pid.
    const wasRunning = record.pty !== null
    try {
      record.pty?.kill()
    } catch {
      /* the process may already be gone */
    }
    this.terminals.delete(id)
    if (this.preferredId === id) this.preferredId = null
    // DI-009: a detached child (Start-Process -WindowStyle Hidden, a new
    // console session) escapes the pty tree-kill and keeps running unseen.
    // On Windows its WMI ancestry still chains to the pty's root, so every
    // surviving descendant is swept after the tree kill settles.
    if (wasRunning) killProcessTree(record.rootPid)
    const info = { id, title: record.title, cwd: record.cwd, scrollback }
    this.emit('release', info)
    return info
  }

  /**
   * Widget unmounted without an intentional close (workspace switch, canvas
   * hydrate, React redraw). Keep the shell alive — Claude Code, long builds,
   * and agent sessions must survive switching project folders. spawn() on
   * remount reconnects to the same pty and paints the live buffer.
   */
  disposeWhenDetached(id: string, _graceMs = 750): void {
    // Intentionally a no-op: parking the pty is the whole design here. The
    // legacy kill-timer this used to arm was never scheduled after the
    // park-on-detach rework and only ever confused the code around it (P10).
    void id
    void _graceMs
  }

  disposeAll(): void {
    // Soft-release: a renderer crash/reload must be able to re-spawn the same
    // canvas widget ids. Intentional closes already banned those ids via dispose.
    for (const id of Array.from(this.terminals.keys())) this.release(id)
  }

  /**
   * Resolves once the pty for `id` is actually running, or times out.
   * Bails out early when the id was disposed while waiting: another actor's
   * close means no widget will ever mount it, and polling out the whole
   * timeout would only delay the create/write command's honest failure.
   */
  async waitUntilRunning(id: string, timeoutMs = 3000, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.disposed.has(id)) return false
      if (signal?.aborted) return false
      if (this.isRunning(id)) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return this.isRunning(id)
  }
}

function isPositiveInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0
}

/** Ids are generated by the app (`term-…`/`agent-…`) or by the canvas (`terminal-…`). */
export const TERMINAL_ID = /^[A-Za-z0-9_-]{1,128}$/
