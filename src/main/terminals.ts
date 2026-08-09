import { EventEmitter } from 'events'
import * as os from 'os'
import * as fs from 'fs'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import { OUTPUT_BUFFER_LIMIT, MAX_TERMINAL_WRITE_BYTES, defaultShell } from './config'
import { killProcessTree } from './procTree'

export interface TerminalInfo {
  id: string
  title: string
  cwd: string
  alive: boolean
}

export interface SpawnResult {
  ok: boolean
  error?: string
}

interface TerminalRecord {
  pty: IPty | null
  title: string
  cwd: string
  output: string
  /** PID of the process node-pty started; the ancestor for the survivor sweep. */
  rootPid?: number
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
  // remembered forever; this blocks the P3-012 resurrection race.
  private readonly disposed = new Set<string>()
  private counter = 0

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
    const title = prefix === 'agent' ? `Agent Terminal ${this.nextAgentNumber()}` : options.title?.trim() || id
    const record: TerminalRecord = {
      pty: null,
      title,
      cwd: this.resolveCwd(options.cwd),
      output: ''
    }
    this.terminals.set(id, record)
    return this.toInfo(id, record)
  }

  private resolveCwd(cwd?: string): string {
    if (cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) return cwd
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
   * (a reconnecting widget after a reload) — the renderer only needs to know
   * whether the pty is live.
   */
  spawn(id: string, cols?: number, rows?: number, cwd?: string): SpawnResult {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id))
      return { ok: false, error: 'invalid terminal id' }
    // A widget racing a slow renderer mount (control-server creation timed out
    // and disposed the reservation first) must not resurrect the id as a fresh
    // auto-reserved record — that leaves a pty that no widget backs.
    if (this.disposed.has(id)) return { ok: false, error: 'terminal was closed' }
    let record = this.terminals.get(id)
    if (record?.pty) return { ok: true }
    if (!record) {
      record = { pty: null, title: id, cwd: this.resolveCwd(cwd), output: '' }
      this.terminals.set(id, record)
    }

    try {
      const child = pty.spawn(defaultShell(), [], {
        name: 'xterm-256color',
        cols: isPositiveInt(cols) ? cols : 80,
        rows: isPositiveInt(rows) ? rows : 24,
        cwd: record.cwd,
        env: process.env as Record<string, string>
      })
      record.pty = child
      record.rootPid = child.pid

      child.onData((chunk) => {
        const current = this.terminals.get(id)
        if (current) current.output = (current.output + chunk).slice(-OUTPUT_BUFFER_LIMIT)
        this.emit('data', id, chunk)
      })
      child.onExit(({ exitCode }) => {
        const current = this.terminals.get(id)
        if (current) current.pty = null
        this.emit('exit', id, exitCode)
      })
      return { ok: true }
    } catch (err) {
      console.error(`failed to spawn terminal ${id}`, err)
      return { ok: false, error: String(err) }
    }
  }

  write(id: string, data: string): void {
    // A non-string write would throw inside the pty handler; drop it instead.
    if (typeof data !== 'string' || typeof id !== 'string') return
    // A cap keeps an oversized write from growing the pty buffer unboundedly (SEC-010).
    if (data.length > MAX_TERMINAL_WRITE_BYTES) data = data.slice(0, MAX_TERMINAL_WRITE_BYTES)
    this.terminals.get(id)?.pty?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (!isPositiveInt(cols) || !isPositiveInt(rows)) return
    this.terminals.get(id)?.pty?.resize(cols, rows)
  }

  readOutput(id: string, clear = false): string | null {
    const record = this.terminals.get(id)
    if (!record) return null
    const output = record.output
    if (clear) record.output = ''
    return output
  }

  /** Kills the process and forgets the terminal entirely. */
  dispose(id: string): void {
    const record = this.terminals.get(id)
    if (!record) return
    try {
      record.pty?.kill()
    } catch {
      /* the process may already be gone */
    }
    this.disposed.add(id)
    this.terminals.delete(id)
    // DI-009: a detached child (Start-Process -WindowStyle Hidden, a new
    // console session) escapes the pty tree-kill and keeps running unseen.
    // On Windows its WMI ancestry still chains to the pty's root, so every
    // surviving descendant is swept after the tree kill settles.
    killProcessTree(record.rootPid)
  }

  disposeAll(): void {
    for (const id of Array.from(this.terminals.keys())) this.dispose(id)
  }

  /** Resolves once the pty for `id` is actually running, or times out. */
  async waitUntilRunning(id: string, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
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
const TERMINAL_ID = /^[A-Za-z0-9_-]{1,128}$/
