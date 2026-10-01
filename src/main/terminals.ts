import { EventEmitter } from 'events'
import * as os from 'os'
import * as fs from 'fs'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import { conptyStartupOutput, systemWindowsPtyOptions, windowsPtyOptions } from './conpty.ts'
import { OUTPUT_BUFFER_LIMIT, MAX_TERMINAL_WRITE_BYTES, defaultShell } from './config.ts'
import { CommandError } from './core/index.ts'
import { getAppVersion } from './linkSnapshot.ts'
import { killProcessTree } from './procTree.ts'
import { TerminalRingBuffer } from './terminalBuffer.ts'
import {
  isAutomaticTerminalName,
  isDefaultTerminalTitle,
  isLegacyNumberedAutomaticTerminalName,
  makeUniqueTitle,
  pickTerminalName
} from './terminalNames.ts'
import type { RustPtySpawnOptions, RustPtySidecar } from './rustPtySidecar.ts'
import {
  codeTerminalColorEnv as resolveCodeTerminalColorEnv,
  isPositiveInt as isPositiveTerminalInt,
  safeOrcTerminalEnv as resolveOrcTerminalEnv,
  terminalBaseEnv as resolveTerminalBaseEnv,
  unixShellArgs as resolveUnixShellArgs,
  windowsShellArgs as resolveWindowsShellArgs
} from './terminal/terminalEnvironment.ts'
import {
  compactDeliveryText as compactTerminalDeliveryText,
  deliveryDelay as waitForDelivery,
  isDeadSessionError as isDeadTerminalSessionError,
  isStalledInputError as isStalledTerminalInputError,
  normalizeDeliveryText as normalizeTerminalDeliveryText,
  pasteMarkerMatches as matchesPasteMarker,
  takeInputTurn as awaitInputTurn,
  SUBMIT_BURST_GAP_MS as TERMINAL_SUBMIT_BURST_GAP_MS,
  SUBMIT_SETTLE_MAX_MS as TERMINAL_SUBMIT_SETTLE_MAX_MS,
  SUBMIT_SETTLE_QUIET_MS as TERMINAL_SUBMIT_SETTLE_QUIET_MS
} from './terminal/terminalDelivery.ts'
export const MAX_TERMINALS = 32

// PTY sizes come from renderer layout math and must fit the Rust engine's
// u16 PtySize. Clamp absurd values (e.g. a zoomed ultrawide reporting 1e9)
// instead of failing spawn with a deserialization error.
const MAX_PTY_DIMENSION = 1000
const RENDERER_OUTPUT_PAUSE_AT = 256 * 1024
const RENDERER_OUTPUT_RESUME_AT = 64 * 1024
function clampPtyDimension(value: unknown, fallback: number): number {
  return isPositiveTerminalInt(value) ? Math.min(value, MAX_PTY_DIMENSION) : fallback
}








export { windowsShellArgs, unixShellArgs } from './terminal/terminalEnvironment.ts'
export { isDeadSessionError, isStalledInputError } from './terminal/terminalDelivery.ts'

export interface TerminalInfo {
  id: string
  title: string
  cwd: string
  alive: boolean
  lastPrompt?: string
}

export interface SpawnResult {
  ok: boolean
  error?: string

  reconnected?: boolean
}

export interface TerminalDeliveryReceipt {
  ok: true
  id: string
  terminalId: string
  confirmedAt: number
  evidence: 'terminal-output'
}

export interface TerminalDeliveryFailure {
  ok: false
  id: string
  terminalId: string
  error: string
}

export type TerminalDeliveryResult = TerminalDeliveryReceipt | TerminalDeliveryFailure

export interface ReleaseOptions {





  killDescendants?: boolean
}

interface TerminalRecord {
  startupOutput?: (chunk: string) => string
  pty: IPty | null
  nativeAlive: boolean







  ptyDisposers: { dispose(): void }[]
  title: string
  cwd: string

  lastPrompt?: string




  output: TerminalRingBuffer








  readOffset: number

  rootPid?: number

  /** Last known geometry, reused when the backend has to respawn the shell. */
  cols?: number
  rows?: number

  lastDataAt: number

  /** Text handed to the renderer that xterm has not confirmed parsing yet. */
  rendererPendingChars: number
  rendererPendingBatches: Map<number, number>
  outputPaused: boolean

  exited?: boolean

  /** When the shell exited, used to reclaim the oldest dead slot at the cap. */
  exitedAt?: number
}








export class TerminalManager extends EventEmitter {
  private readonly getWindowsShell: () => 'cmd' | 'powershell'
  private readonly getFavoriteNames: () => string[]
  private readonly rustPty: RustPtySidecar | null
  private readonly terminals = new Map<string, TerminalRecord>()





  private readonly disposed = new Set<string>()
  private readonly disposedOrder: string[] = []
  private static readonly DISPOSED_CAP = 4_096
  private counter = 0




  /** Set once teardown starts; blocks any respawn from racing the shutdown. */
  private shuttingDown = false

  private preferredId: string | null = null
  private deliveryCounter = 0







  private readonly inputTails = new Map<string, Promise<void>>()
  private readonly inputEpochs = new Map<string, symbol>()

  constructor(
    options: {
      getWindowsShell?: () => 'cmd' | 'powershell'
      getFavoriteNames?: () => string[]
      rustPty?: RustPtySidecar | null
    } = {}
  ) {
    super()
    // Delivery confirmations and spawn waits each attach a handful of
    // short-lived listeners for the duration of one call, and the coordinator
    // dispatches work in parallel by design. The default ceiling of 10 turns
    // a few concurrent deliveries into a bogus "possible memory leak" warning
    // — the listeners are removed on every settle path, so the ceiling is
    // measuring concurrency, not a leak.
    this.setMaxListeners(0)
    this.getWindowsShell = options.getWindowsShell ?? (() => 'cmd')
    this.getFavoriteNames = options.getFavoriteNames ?? (() => [])
    this.rustPty = options.rustPty ?? null
    this.rustPty?.on('data', (id: string, chunk: string) => this.handleRustOutput(id, chunk))
    this.rustPty?.on('exit', (id: string, code: number) => this.handleRustExit(id, code))
    this.rustPty?.on('spawn-error', (id: string, error: Error) => this.handleRustSpawnError(id, error))
    this.rustPty?.on('request-error', (id: string, error: Error) => this.handleRustRequestError(id, error))
    this.rustPty?.on('backend-error', (error: Error) => this.emit('backend-error', error))
    this.rustPty?.on('backend-exit', (code: number) => this.handleRustBackendExit(code))
  }







  private nextId(prefix: string): string {
    this.counter += 1
    return `${prefix}-${Date.now()}-${this.counter}`
  }

  private takenTitles(exceptId?: string): Set<string> {
    const taken = new Set<string>()
    for (const [id, record] of this.terminals) {
      if (id !== exceptId) taken.add(record.title.toLowerCase())
    }
    return taken
  }

  private assignAutoName(exceptId?: string): string {
    let favorites: string[] = []
    try {
      favorites = this.getFavoriteNames() ?? []
    } catch {
      favorites = []
    }
    return pickTerminalName({ favorites, taken: this.takenTitles(exceptId) })
  }

  /**
   * Free one slot at the terminal cap by dropping the longest-dead session.
   *
   * Only records that actually ran and exited qualify: a reserved-but-unspawned
   * record also has `pty == null && !nativeAlive`, and reclaiming one of those
   * would destroy a terminal the renderer is still about to attach to.
   * Returns false when every slot is either live or pending a first spawn.
   */
  private reclaimExitedSlot(): boolean {
    let oldestId: string | null = null
    let oldestAt = Infinity
    for (const [id, record] of this.terminals) {
      if (!record.exited || record.pty != null || record.nativeAlive) continue
      const at = record.exitedAt ?? 0
      if (at < oldestAt) {
        oldestAt = at
        oldestId = id
      }
    }
    if (oldestId === null) return false
    this.release(oldestId, { killDescendants: false })
    return true
  }

  reserve(options: { title?: string; cwd?: string; prefix?: string } = {}): TerminalInfo {
    if (this.terminals.size >= MAX_TERMINALS) {
      // Exited shells keep their scrollback for worker-read, but a pile of
      // closed-but-unreleased widgets must not wedge new terminals forever.
      if (!this.reclaimExitedSlot()) {
        throw new CommandError('rate_limited', `terminal limit reached (${MAX_TERMINALS})`)
      }
    }
    const prefix = options.prefix || 'term'
    const id = this.nextId(prefix)

    const explicit = options.title?.trim()
    const taken = this.takenTitles()
    const title =
      explicit && !isDefaultTerminalTitle(explicit)
        ? isLegacyNumberedAutomaticTerminalName(explicit) ||
          (isAutomaticTerminalName(explicit) && taken.has(explicit.toLowerCase()))
          ? this.assignAutoName()
          : makeUniqueTitle(explicit, taken)
        : this.assignAutoName()
    const record: TerminalRecord = {
      pty: null,
      nativeAlive: false,
      ptyDisposers: [],
      title,
      cwd: this.resolveCwd(options.cwd),
      output: new TerminalRingBuffer({ maxBytes: OUTPUT_BUFFER_LIMIT }),
      readOffset: 0,
      rendererPendingChars: 0,
      rendererPendingBatches: new Map(),
      outputPaused: false,
      lastDataAt: 0
    }
    this.terminals.set(id, record)
    return this.toInfo(id, record)
  }

  private resolveCwd(cwd?: string): string {
    if (cwd) {
      try {


        if (fs.statSync(cwd).isDirectory()) return cwd
      } catch {

      }
    }
    return os.homedir()
  }

  private toInfo(id: string, record: TerminalRecord): TerminalInfo {
    return {
      id,
      title: record.title,
      cwd: record.cwd,
      alive: record.pty !== null || record.nativeAlive,
      ...(record.lastPrompt ? { lastPrompt: record.lastPrompt } : {})
    }
  }

  has(id: string): boolean {
    return this.terminals.has(id)
  }

  isRunning(id: string): boolean {
    const record = this.terminals.get(id)
    return record?.pty != null || record?.nativeAlive === true
  }

  /**
   * Stop input that belongs to a previous PTY session from crossing a restart.
   * The queue intentionally waits for an in-flight write, so the epoch check
   * is the boundary that prevents its successor from reaching a new shell.
   */
  private invalidateInput(id: string): void {
    this.inputEpochs.set(id, Symbol())
  }



  list(): TerminalInfo[] {
    return Array.from(this.terminals, ([id, record]) => this.toInfo(id, record))
  }

  /**
   * One terminal's info, without building every other one's.
   *
   * The callers of this were written as `list().find(t => t.id === id)`, which
   * allocates an info object per open terminal to read a single field — on the
   * snapshot path, which runs on the thread that pumps every PTY.
   */
  info(id: string): TerminalInfo | undefined {
    const record = this.terminals.get(id)
    return record ? this.toInfo(id, record) : undefined
  }









  spawn(id: string, cols?: number, rows?: number, cwd?: string, title?: string): SpawnResult {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id))
      return { ok: false, error: 'invalid terminal id' }



    if (this.shuttingDown) return { ok: false, error: 'terminal manager is shutting down' }
    if (this.disposed.has(id)) return { ok: false, error: 'terminal was closed' }
    let record = this.terminals.get(id)
    if (record && (record.pty || record.nativeAlive)) {


      if (isPositiveTerminalInt(cols) && isPositiveTerminalInt(rows)) {
        if (record.pty) {
          try {
            record.pty.resize(cols, rows)
          } catch (err) {
            console.warn(`failed to resize reconnected terminal ${id}`, err)
          }
        } else {
          this.rustPty?.resize(id, cols, rows)
        }
      }
      this.preferredId = id
      return { ok: true, reconnected: true }
    }
    if (!record) {
      if (this.terminals.size >= MAX_TERMINALS) {
        // Same reclaim policy as reserve(): exited slots keep scrollback for
        // worker-read, but must not wedge brand-new terminals forever.
        if (!this.reclaimExitedSlot()) {
          return { ok: false, error: `terminal limit reached (${MAX_TERMINALS})` }
        }
      }
      const requestedTitle = title?.trim()
      const initialTitle = requestedTitle && !isDefaultTerminalTitle(requestedTitle)
        ? isLegacyNumberedAutomaticTerminalName(requestedTitle) ||
          (isAutomaticTerminalName(requestedTitle) && this.takenTitles(id).has(requestedTitle.toLowerCase()))
          ? this.assignAutoName(id)
          : makeUniqueTitle(requestedTitle, this.takenTitles(id))
        : this.assignAutoName(id)
      record = {
        pty: null,
        nativeAlive: false,
        ptyDisposers: [],
        title: initialTitle,
        cwd: this.resolveCwd(cwd),
        output: new TerminalRingBuffer({ maxBytes: OUTPUT_BUFFER_LIMIT }),
        readOffset: 0,
        rendererPendingChars: 0,
        rendererPendingBatches: new Map(),
        outputPaused: false,
        lastDataAt: 0
      }
      this.terminals.set(id, record)
      if (!requestedTitle || isDefaultTerminalTitle(requestedTitle) || record.title !== requestedTitle) {
        this.emit('title', id, record.title)
      }
    } else if (cwd && !record.pty && !record.nativeAlive) {

      const resolved = this.resolveCwd(cwd)
      if (resolved !== record.cwd) record.cwd = resolved
    }

    if (isPositiveTerminalInt(cols) && isPositiveTerminalInt(rows)) {
      record.cols = cols
      record.rows = rows
    }
    if (record.exited) {
      // A previous session ended on this record (exit without release, e.g. a
      // remount racing the exit notice). A new shell must not inherit the old
      // session's bytes: worker-read, delivery echoes and reconnect
      // scrollback would otherwise mix two different sessions.
      record.output.clear()
      record.readOffset = 0
      record.exited = false
      record.exitedAt = undefined
    }
    this.invalidateInput(id)

    if (this.rustPty) {
      record.startupOutput = process.platform === 'win32'
        ? conptyStartupOutput((data) => { void this.rustPty!.write(id, data) }) : undefined
      const result = this.rustPty.spawn(this.rustSpawnOptions(id, record, cols, rows))
      if (result.ok) {
        record.nativeAlive = true
        // No local child for Rust sessions: the engine owns the shell and its
        // whole tree (dispose kills it engine-side). Clear any stale node pid
        // so release() never taskkills a recycled pid from a previous fallback.
        record.pty = null
        record.rootPid = undefined
        this.preferredId = id
        this.emit('spawn', id)
        return { ok: true }
      }
      console.warn(`[rust-engine] spawn failed for ${id}; using node-pty fallback`, result.error)
    }

    return this.spawnNodePty(id, record, cols, rows)
  }

  private spawnNodePty(id: string, record: TerminalRecord, cols?: number, rows?: number): SpawnResult {
    try {
      const windowsShell = this.getWindowsShell()
      const shell = defaultShell(windowsShell)
      const shellArgs = process.platform === 'win32'
        ? resolveWindowsShellArgs(windowsShell)
        : resolveUnixShellArgs(shell)
      const spawnOptions = {
        name: 'xterm-256color',
        cols: clampPtyDimension(cols, 80),
        rows: clampPtyDimension(rows, 24),
        cwd: record.cwd,
        env: {
          ...resolveTerminalBaseEnv(process.env as Record<string, string>),
          ...resolveOrcTerminalEnv(id),
          ORCSPACE: '1',
          ORCSPACE_TERMINAL_ID: id,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          FORCE_COLOR: '3',
          COLORFGBG: '15;0',
          TERM_PROGRAM: 'OrcSpace',
          TERM_PROGRAM_VERSION: getAppVersion(),
          LANG: process.env.LANG || 'en_US.UTF-8',
          LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8',
          ...resolveCodeTerminalColorEnv(id)
        }
      }
      let child: IPty
      try {
        child = pty.spawn(shell, shellArgs, {
          ...spawnOptions,
          ...(process.platform === 'win32' ? windowsPtyOptions : {})
        })
      } catch (error) {
        if (process.platform !== 'win32') throw error
        console.warn('bundled ConPTY unavailable; using system ConPTY fallback', error)
        child = pty.spawn(shell, shellArgs, {
          ...spawnOptions,
          ...systemWindowsPtyOptions
        })
      }
      record.pty = child
      // The bundled host withholds the shell until the terminal answers its
      // startup handshake, so the answer lives here rather than in the widget
      // that may never open. conptyStartupOutput answers every query a host
      // can block on, which is what keeps that wait from becoming a hang.
      record.startupOutput = process.platform === 'win32'
        ? conptyStartupOutput((data) => child.write(data)) : undefined
      record.rootPid = child.pid
      this.preferredId = id

      record.ptyDisposers.push(
        child.onData((chunk) => {
          const current = this.terminals.get(id)
          if (!current || current.pty !== child) return
          chunk = current.startupOutput?.(chunk) ?? chunk
          if (!chunk) return
          current.output.append(chunk)
          current.lastDataAt = Date.now()
          this.emit('data', id, chunk)
        }),
        child.onExit(({ exitCode }) => {
          this.handlePtyExit(id, child, exitCode)
        })
      )
      this.emit('spawn', id)
      return { ok: true }
    } catch (err) {
      console.error(`failed to spawn terminal ${id}`, err)
      return { ok: false, error: String(err) }
    }
  }

  private rustSpawnOptions(
    id: string,
    record: TerminalRecord,
    cols?: number,
    rows?: number
  ): RustPtySpawnOptions {
    const env = {
      ...resolveTerminalBaseEnv(process.env as Record<string, string>),
      ...resolveOrcTerminalEnv(id),
      ORCSPACE: '1',
      ORCSPACE_TERMINAL_ID: id,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
      COLORFGBG: '15;0',
      TERM_PROGRAM: 'OrcSpace',
      TERM_PROGRAM_VERSION: getAppVersion(),
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8',
      ...resolveCodeTerminalColorEnv(id)
    }
    return {
      id,
      shell: defaultShell(this.getWindowsShell()),
      cols: clampPtyDimension(cols, 80),
      rows: clampPtyDimension(rows, 24),
      cwd: record.cwd,
      env
    }
  }

  private handleRustOutput(id: string, chunk: string): void {
    const current = this.terminals.get(id)
    if (!current || !current.nativeAlive) return
    chunk = current.startupOutput?.(chunk) ?? chunk
    if (!chunk) return
    current.output.append(chunk)
    current.lastDataAt = Date.now()
    this.emit('data', id, chunk)
  }

  private handleRustExit(id: string, exitCode: number): void {
    const current = this.terminals.get(id)
    if (!current || !current.nativeAlive) return
    current.nativeAlive = false
    this.invalidateInput(id)
    current.exited = true
    current.exitedAt = Date.now()
    this.emit('exit', id, exitCode)
  }

  private handleRustSpawnError(id: string, error: Error): void {
    const current = this.terminals.get(id)
    if (!current || !current.nativeAlive) return
    current.nativeAlive = false
    this.invalidateInput(id)
    // The engine has already told us the session is gone, so every write
    // still waiting on an ACK from it is dead. Fail them now: waiting out the
    // write-ACK timeout would hang those callers behind the fallback below,
    // which is about to give them a working shell.
    this.rustPty?.failTerminalWrites(id, 'terminal session failed to start')
    // The sidecar acknowledges the command before portable-pty has finished
    // creating the child, so this failure arrives after spawn() already
    // returned. Keep the widget alive by taking the same node-pty fallback as
    // the synchronous failure path instead of reporting a dead terminal.
    current.output.clear()
    current.readOffset = 0
    const fallback = this.spawnNodePty(id, current, current.cols, current.rows)
    if (fallback.ok) {
      console.warn(`[rust-engine] async spawn failed for ${id}; using node-pty fallback`, error)
      return
    }
    current.exited = true
    current.exitedAt = Date.now()
    this.emit('backend-error', error)
    this.emit('exit', id, 1)
  }

  private handleRustBackendExit(exitCode: number): void {
    for (const [id, record] of this.terminals) {
      if (!record.nativeAlive) continue
      record.nativeAlive = false
      this.invalidateInput(id)
      record.exited = true
      record.exitedAt = Date.now()
      if (this.shuttingDown) {
        // The app is quitting: a replacement shell would only be orphaned.
        this.emit('exit', id, exitCode)
        continue
      }
      // Keep the canvas/code widget usable when the native sidecar dies.
      // `spawn` will use node-pty as a local fallback if the sidecar cannot
      // be started again, so the user does not need to close the widget.
      const restarted = this.tryRestart(id)
      if (!restarted.ok) this.emit('exit', id, exitCode)
    }
  }

  private handleRustRequestError(id: string | undefined, error: Error): void {
    if (!id) return
    const current = this.terminals.get(id)
    if (!current || !current.nativeAlive) return
    if (isStalledTerminalInputError(error)) {
      // The child stopped reading its stdin. The widget already prints this
      // inline, in the terminal it happened to, which is where it belongs —
      // a second copy as a global toast would fire on every keystroke the
      // user tries afterwards.
      return
    }
    if (isDeadTerminalSessionError(error)) {
      // The engine is telling us this session no longer exists. Keeping the
      // record marked alive is what made a wedged terminal look hung forever:
      // every keystroke was accepted and silently dropped, and only closing
      // the widget helped. Report it as an exit so the widget says so and can
      // recover on its own.
      current.nativeAlive = false
      this.invalidateInput(id)
      current.exited = true
      current.exitedAt = Date.now()
      this.emit('backend-error', error)
      this.emit('exit', id, 1)
      return
    }
    // Any other failed sidecar operation says nothing about the session: the
    // shell is usually alive and only one write was refused (session death is
    // reported authoritatively through the exit event, which the engine emits
    // when the reader observes EOF). Destroying the session here used to
    // orphan the still-running child — its reader kept flooding the widget
    // with interleaved output while input went to a fresh shell, which looked
    // exactly like a hung terminal. So surface the failure and keep the
    // session; the widget already shows transient input errors and the user
    // can still close (which now kills the whole tree).
    this.emit('backend-error', error)
  }

  private tryRestart(id: string): SpawnResult {
    try {
      const record = this.terminals.get(id)
      // Reuse the last known geometry: respawning at the 80x24 default while
      // the widget shows a different size wraps/tears the live view.
      return this.spawn(id, record?.cols, record?.rows)
    } catch (error) {
      console.warn(`[terminal] failed to recover ${id}`, error)
      return { ok: false, error: String((error as Error)?.message ?? error) }
    }
  }





  async write(id: string, data: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (typeof data !== 'string' || typeof id !== 'string') {
      return { ok: false, error: 'invalid write' }
    }


    if (Buffer.byteLength(data, 'utf8') > MAX_TERMINAL_WRITE_BYTES) {
      return { ok: false, error: `write exceeds ${MAX_TERMINAL_WRITE_BYTES} bytes` }
    }
    const record = this.terminals.get(id)
    if (!record) return { ok: false, error: `terminal ${id} not found` }
    if (record.nativeAlive && this.rustPty) {
      // Waits for the engine's own ack (see RustPtySidecar.write) instead of
      // just confirming the bytes reached its stdin — a queue-full or
      // dead-session rejection now surfaces here instead of being reported
      // as a successful write while the keystroke silently vanishes.
      const result = await this.rustPty.write(id, data)
      if (result.ok) {
        this.preferredId = id
        return { ok: true }
      }
      return result
    }
    if (!record.pty) return { ok: false, error: `terminal ${id} is not running` }
    try {
      record.pty.write(data)
      this.preferredId = id
      return { ok: true }
    } catch (err) {


      console.warn(`failed to write to terminal ${id}`, err)
      return { ok: false, error: String((err as Error)?.message ?? err) }
    }
  }


  async writeInput(id: string, data: string): Promise<Awaited<ReturnType<TerminalManager['write']>>> {
    // Interrupt must reach the engine even while a previous write awaits its ACK.
    if (data === '\x03') {
      this.inputEpochs.set(id, Symbol())
      return this.write(id, data)
    }
    return this.serializeInput(id, () => this.write(id, data))
  }


  async writeLine(
    id: string,
    text: string,
    options: { pressEnter?: boolean; signal?: AbortSignal } = {}
  ): Promise<Awaited<ReturnType<TerminalManager['write']>>> {
    return this.serializeInput(id, async () => {
      const epoch = this.inputEpochs.get(id)
      if (options.signal?.aborted) return { ok: false, error: 'delivery cancelled' }
      const singleLine = text.replace(/\r\n|\r|\n/g, ' ')
      const typed = await this.write(id, singleLine)
      if (!typed.ok || options.pressEnter === false) return typed
      if (!(await this.waitBeforeSubmit(id, options.signal))) return { ok: false, error: 'delivery cancelled' }
      if (this.inputEpochs.get(id) !== epoch) return { ok: false, error: 'delivery interrupted' }
      return this.write(id, '\r')
    })
  }

  private serializeInput<T>(id: string, operation: () => T | Promise<T>): Promise<T | { ok: false; error: string }> {
    const previous = this.inputTails.get(id) ?? Promise.resolve()
    const epoch = this.inputEpochs.get(id)
    const current = awaitInputTurn(previous).then(
      () => this.inputEpochs.get(id) === epoch ? operation() : { ok: false as const, error: 'input interrupted' },
      () => ({ ok: false as const, error: 'terminal input queue timed out' })
    )
    // The tail waits for the previous turn as well as this one. takeInputTurn
    // gives up on a stalled predecessor after INPUT_QUEUE_STALL_MS, but "gave
    // up waiting" is not "the predecessor finished": settling the tail on the
    // timeout alone handed the queue to the next caller while the write ahead
    // of it was still in flight, and the two inputs interleaved in the shell —
    // half of one command typed into the middle of another. The timed-out turn
    // is still refused; it just no longer pulls the queue out from under the
    // write it was waiting for.
    const settled = Promise.allSettled([previous, current]).then(() => undefined)
    this.inputTails.set(id, settled)
    // Dropping the entry is keyed to the tail, not to this turn: forgetting it
    // while the predecessor was still running would hand the next caller a
    // fresh, already-resolved queue — the very overlap the tail exists to stop.
    void settled.then(() => {
      if (this.inputTails.get(id) === settled) this.inputTails.delete(id)
    })
    return current
  }








  async deliverLine(
    id: string,
    text: string,
    options: { pressEnter?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<TerminalDeliveryResult> {
    this.deliveryCounter += 1
    const receiptId = `delivery-${Date.now()}-${this.deliveryCounter}`
    const fail = (error: string): TerminalDeliveryFailure => ({
      ok: false,
      id: receiptId,
      terminalId: id,
      error
    })
    const staged = await this.serializeInput(id, () => this.stageDelivery(id, text, options))
    if (!staged.ok) return fail(staged.error)
    const confirmed = await this.waitForDeliveryEcho(
      id,
      staged.offset,
      staged.expected,
      staged.expectedLength,
      options.timeoutMs ?? 4_000,
      options.signal
    )
    if (!confirmed) return fail('not sent: target terminal did not confirm the message')
    return {
      ok: true,
      id: receiptId,
      terminalId: id,
      confirmedAt: Date.now(),
      evidence: 'terminal-output'
    }
  }

  /**
   * Pause between typing a message and pressing Enter.
   *
   * Agent TUIs (Codex, Claude Code and friends) treat a burst of characters as
   * a paste, and a carriage return landing inside that burst window is taken
   * as a newline *inside the composer* rather than as a submit. The gap used
   * to be a flat 30ms, well inside those windows: the message appeared in the
   * input box and simply never sent.
   *
   * The floor clears the burst window. After it the terminal is also given a
   * chance to fall quiet, because a TUI still repainting what it just received
   * has not finished handling the paste either. Bounded, so a chatty terminal
   * can never hold a delivery open.
   */
  private async waitBeforeSubmit(id: string, signal?: AbortSignal): Promise<boolean> {
    if (!(await waitForDelivery(TERMINAL_SUBMIT_BURST_GAP_MS, signal))) return false
    const record = this.terminals.get(id)
    if (!record) return true
    const deadline = Date.now() + TERMINAL_SUBMIT_SETTLE_MAX_MS
    for (;;) {
      const quietFor = Date.now() - record.lastDataAt
      const remaining = Math.min(TERMINAL_SUBMIT_SETTLE_QUIET_MS - quietFor, deadline - Date.now())
      if (remaining <= 0) return true
      if (!(await waitForDelivery(remaining, signal))) return false
    }
  }

  private async stageDelivery(
    id: string,
    text: string,
    options: { pressEnter?: boolean; signal?: AbortSignal }
  ): Promise<{ ok: true; offset: number; expected: string; expectedLength: number } | { ok: false; error: string }> {
    const epoch = this.inputEpochs.get(id)
    if (options.signal?.aborted) return { ok: false, error: 'delivery cancelled' }
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'message is empty' }
    const record = this.terminals.get(id)
    if (!record || !this.isRunning(id)) return { ok: false, error: `terminal ${id} is not running` }

    // Agent TUIs, including OpenCode, distinguish a pasted prompt from shell
    // input through the bracketed-paste markers. Without them a long message
    // delivered by `orc tell` can be interpreted as a `$ ...` shell command.
    const pastedText = text.replace(/\r\n?/g, '\n')
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(pastedText)) {
      return { ok: false, error: 'message contains unsafe terminal control characters' }
    }
    const input = `\x1b[200~${pastedText}\x1b[201~`
    const expected = normalizeTerminalDeliveryText(pastedText)
    if (!expected) return { ok: false, error: 'message has no visible text' }
    const expectedLength = pastedText.length
    const offset = record.output.globalOffset

    const typed = await this.write(id, input)
    if (!typed.ok) return { ok: false, error: typed.error }
    if (options.pressEnter !== false) {
      if (!(await this.waitBeforeSubmit(id, options.signal))) return { ok: false, error: 'delivery cancelled' }
      if (this.inputEpochs.get(id) !== epoch) return { ok: false, error: 'delivery interrupted' }
      const submitted = await this.write(id, '\r')
      if (!submitted.ok) return { ok: false, error: submitted.error }
    }
    return { ok: true, offset, expected, expectedLength }
  }

  private waitForDeliveryEcho(
    id: string,
    offset: number,
    expected: string,
    expectedLength: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    const matches = (): boolean => {
      const record = this.terminals.get(id)
      if (!record || !this.isRunning(id)) return false
      const from = Math.max(offset, record.output.startOffset)
      const output = record.output.read(from, OUTPUT_BUFFER_LIMIT).data
      const normalized = normalizeTerminalDeliveryText(output)
      if (!normalized || !expected) return false
      if (expected.length >= 8) {
        if (normalized.includes(expected)) return true
        // Wrapped by the target's composer: compare with the seams removed.
        const compactExpected = compactTerminalDeliveryText(expected)
        if (compactExpected.length >= 8 && compactTerminalDeliveryText(normalized).includes(compactExpected)) {
          return true
        }
      }
      // Short commands ("ls", "ok") collide with prose already on screen:
      // require a token boundary so "ls" inside "false" is not a delivery.
      const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (expected.length < 8 && new RegExp(`(^|\\W)${escaped}(\\W|$)`).test(normalized)) return true
      return matchesPasteMarker(normalized, expectedLength)
    }
    if (matches()) return Promise.resolve(true)
    if (signal?.aborted) return Promise.resolve(false)

    return new Promise<boolean>((resolve) => {
      let settled = false
      let lastCheckAt = 0
      let trailingCheck: ReturnType<typeof setTimeout> | undefined
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(trailingCheck)
        this.off('data', onData)
        this.off('exit', onExit)
        this.off('release', onRelease)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onData = (terminalId: string): void => {
        if (terminalId !== id) return
        // matches() re-reads and regex-scans up to OUTPUT_BUFFER_LIMIT bytes.
        // A hot PTY fires hundreds of data events per second; evaluating on
        // every one of them burns the main thread (which the PTY pump shares).
        // Throttling only delays the confirmation by milliseconds — the final
        // check on timeout stays exact.
        const now = Date.now()
        if (now - lastCheckAt < 75) {
          trailingCheck ??= setTimeout(() => {
            trailingCheck = undefined
            lastCheckAt = Date.now()
            if (matches()) finish(true)
          }, 75 - (now - lastCheckAt))
          return
        }
        lastCheckAt = now
        if (matches()) finish(true)
      }
      const onExit = (terminalId: string): void => {
        if (terminalId === id) finish(false)
      }
      const onRelease = (info: { id: string }): void => {
        if (info?.id === id) finish(false)
      }
      const onAbort = (): void => finish(false)
      const timer = setTimeout(() => finish(matches()), Math.min(15_000, Math.max(250, timeoutMs)))
      timer.unref?.()
      this.on('data', onData)
      this.on('exit', onExit)
      this.on('release', onRelease)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (matches()) finish(true)
    })
  }


  markPreferred(id: string): void {
    if (typeof id === 'string' && this.terminals.has(id)) this.preferredId = id
  }


  setTitle(id: string, title: string, opts: { unique?: boolean } = {}): void {
    const record = this.terminals.get(id)
    if (!record) return
    const next = title.trim().slice(0, 200)
    if (!next) return
    if (isDefaultTerminalTitle(next)) {
      record.title = this.assignAutoName(id)
    } else if (opts.unique) {
      record.title = makeUniqueTitle(next, this.takenTitles(id))
    } else {
      record.title = next
    }
    this.emit('title', id, record.title)
  }

  rememberPrompt(id: string, prompt: string): void {
    const record = this.terminals.get(id)
    if (!record) return
    const next = prompt.replace(/\s+/g, ' ').trim().slice(0, 12_000)
    if (!next || next === record.lastPrompt) return
    record.lastPrompt = next
    this.emit('prompt', id, next)
  }






  /**
   * Resolve where a write should go.
   *
   * Only an empty id or the `new` placeholder may float to another terminal.
   * An explicit id either is running (returned as-is) or resolves to null so
   * the caller fails with `not_found` carrying `{ requested, resolved }`
   * instead of typing into the wrong shell. Every path logs
   * requested->resolved so a misdirected write can be traced.
   */
  resolveWriteTarget(requestedId: string): string | null {
    const normalized = (requestedId ?? '').trim()
    const autoResolvable = normalized === '' || normalized === 'new'
    if (!autoResolvable) {
      if (this.isRunning(normalized)) return normalized
      console.warn(`[terminal] resolveWriteTarget requested=${normalized} resolved=(none: not running)`)
      return null
    }
    const pickFallback = (): string | null => {
      if (this.preferredId && this.isRunning(this.preferredId)) return this.preferredId
      const alive = this.list().filter((t) => t.alive)
      if (alive.length === 1) return alive[0].id
      if (alive.length > 1) return alive[alive.length - 1].id
      return null
    }
    const resolved = pickFallback()
    console.log(`[terminal] resolveWriteTarget requested=${normalized === '' ? '(empty)' : normalized} resolved=${resolved ?? '(none)'}`)
    return resolved
  }

  resize(id: string, cols: number, rows: number): void {
    if (!isPositiveTerminalInt(cols) || !isPositiveTerminalInt(rows)) return
    const current = this.terminals.get(id)
    if (current) {
      current.cols = cols
      current.rows = rows
    }
    if (current?.nativeAlive && this.rustPty) {
      const result = this.rustPty.resize(id, cols, rows)
      if (!result.ok) console.warn(`failed to resize Rust terminal ${id}: ${result.error}`)
      return
    }
    try {
      current?.pty?.resize(cols, rows)
    } catch (err) {


      console.warn(`failed to resize terminal ${id}`, err)
    }
  }

  noteRendererOutput(id: string, chars: number, deliveryId: number): void {
    const record = this.terminals.get(id)
    if (!record || !Number.isSafeInteger(chars) || chars <= 0 || !Number.isSafeInteger(deliveryId) || deliveryId <= 0) return
    if (record.rendererPendingBatches.has(deliveryId)) return
    record.rendererPendingBatches.set(deliveryId, chars)
    record.rendererPendingChars += chars
    if (record.rendererPendingChars >= RENDERER_OUTPUT_PAUSE_AT) this.setOutputPaused(id, record, true)
  }

  acknowledgeRendererOutput(id: string, deliveryId: number): void {
    const record = this.terminals.get(id)
    if (!record || !Number.isSafeInteger(deliveryId) || deliveryId <= 0) return
    const chars = record.rendererPendingBatches.get(deliveryId)
    if (chars === undefined) return
    record.rendererPendingBatches.delete(deliveryId)
    record.rendererPendingChars = Math.max(0, record.rendererPendingChars - chars)
    if (record.rendererPendingChars <= RENDERER_OUTPUT_RESUME_AT) this.setOutputPaused(id, record, false)
  }

  resetRendererOutput(id: string): void {
    const record = this.terminals.get(id)
    if (!record) return
    record.rendererPendingChars = 0
    record.rendererPendingBatches.clear()
    this.setOutputPaused(id, record, false)
  }

  private setOutputPaused(id: string, record: TerminalRecord, paused: boolean): void {
    if (record.outputPaused === paused) return
    record.outputPaused = paused
    try {
      if (record.pty) {
        if (paused) record.pty.pause()
        else record.pty.resume()
      } else if (record.nativeAlive) {
        const result = this.rustPty?.pauseOutput(id, paused)
        if (result && !result.ok) console.warn(`failed to ${paused ? 'pause' : 'resume'} terminal output ${id}: ${result.error}`)
      }
    } catch (error) {
      console.warn(`failed to ${paused ? 'pause' : 'resume'} terminal output ${id}`, error)
    }
  }







  readOutput(id: string, clear = false): string | null {
    const record = this.terminals.get(id)
    if (!record) return null


    const since = Math.max(record.readOffset, record.output.startOffset)
    const { data, newOffset } = record.output.read(since, OUTPUT_BUFFER_LIMIT)
    if (clear) record.readOffset = newOffset
    return data
  }



  appendOutput(id: string, chunk: string): void {
    this.terminals.get(id)?.output.append(chunk)
  }


  fullOutput(id: string): string | null {
    const record = this.terminals.get(id)
    if (!record) return null
    return record.output.toString()
  }







  tailOutput(id: string, maxBytes = 4_000): string | null {
    const record = this.terminals.get(id)
    if (!record) return null
    return record.output.tail(maxBytes)
  }







  lastDataAt(id: string): number {
    return this.terminals.get(id)?.lastDataAt ?? 0
  }









  handlePtyExit(id: string, child: IPty, exitCode: number): void {
    const current = this.terminals.get(id)
    if (!current || current.pty !== child) return
    const rootPid = current.rootPid
    const disposers = current.ptyDisposers ?? []
    current.pty = null
    current.rootPid = undefined
    current.ptyDisposers = []
    this.invalidateInput(id)
    current.exited = true
    current.exitedAt = Date.now()

    killProcessTree(rootPid)
    for (const d of disposers) {
      try {
        d.dispose()
      } catch {

      }
    }
    this.emit('exit', id, exitCode)
  }

  dispose(id: string): void {
    this.release(id)
    this.banId(id)
  }

  private banId(id: string): void {
    if (this.disposed.has(id)) return
    this.disposed.add(id)
    this.disposedOrder.push(id)
    this.emit('banned', id)
    if (this.disposedOrder.length <= TerminalManager.DISPOSED_CAP) return
    const drop = this.disposedOrder.splice(0, 1_024)
    for (const old of drop) this.disposed.delete(old)
  }







  release(
    id: string,
    options: ReleaseOptions = {}
  ): { id: string; title: string; cwd: string; scrollback: string; lastPrompt?: string } | null {
    const record = this.terminals.get(id)
    if (!record) return null
    const scrollback = record.output.toString()


    const wasRunning = this.isRunning(id)
    this.invalidateInput(id)
    // Backend calls may synchronously emit exit/failure events. Remove the
    // record first so recovery cannot spawn a replacement during teardown.
    this.terminals.delete(id)
    record.rendererPendingChars = 0
    record.rendererPendingBatches.clear()
    this.setOutputPaused(id, record, false)
    this.inputEpochs.delete(id)
    this.inputTails.delete(id)
    if (this.preferredId === id) this.preferredId = null
    try {
      record.pty?.kill()
    } catch {

    }
    this.rustPty?.dispose(id)




    for (const d of record.ptyDisposers ?? []) {
      try {
        d.dispose()
      } catch {

      }
    }
    record.ptyDisposers = []




    if (wasRunning && options.killDescendants !== false) killProcessTree(record.rootPid)
    const info = { id, title: record.title, cwd: record.cwd, scrollback, lastPrompt: record.lastPrompt }
    this.emit('release', info)
    return info
  }







  disposeWhenDetached(id: string, _graceMs = 750): void {



    void id
    void _graceMs
  }

  disposeAll(options: ReleaseOptions = {}): void {
    // Order matters. Each release below writes to the sidecar, and by the time
    // the app is quitting the engine has usually already seen EOF on its stdin
    // and exited — so those writes fail with EPIPE, which the sidecar reports
    // as "the backend died". That used to reach handleRustBackendExit and
    // respawn every terminal *while the app was shutting down*, leaving fresh
    // orphaned shells behind. Declaring the teardown first makes both the
    // failure report and any respawn a no-op.
    this.shuttingDown = true
    this.rustPty?.beginClose()
    for (const id of Array.from(this.terminals.keys())) this.release(id, options)
    this.rustPty?.close()
  }






  async waitUntilRunning(id: string, timeoutMs = 3000, signal?: AbortSignal): Promise<boolean> {
    if (this.disposed.has(id)) return false
    if (signal?.aborted) return false
    if (this.isRunning(id)) return true
    return new Promise<boolean>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const cleanup = (): void => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        this.off('spawn', onSpawn)
        this.off('banned', onBanned)
        this.off('release', onRelease)
        signal?.removeEventListener('abort', onAbort)
      }
      const onSpawn = (spawnedId: string): void => {
        if (spawnedId !== id) return
        cleanup()
        resolve(true)
      }
      const onBanned = (bannedId: string): void => {
        if (bannedId !== id) return
        cleanup()
        resolve(false)
      }
      const onRelease = (info: { id: string }): void => {
        if (info.id !== id) return
        cleanup()
        resolve(false)
      }
      const onAbort = (): void => {
        cleanup()
        resolve(false)
      }
      timer = setTimeout(() => {
        cleanup()
        resolve(this.isRunning(id))
      }, timeoutMs)
      timer.unref?.()
      this.on('spawn', onSpawn)
      this.on('banned', onBanned)
      this.on('release', onRelease)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        cleanup()
        resolve(false)
      }
    })
  }
}


export function normalizeDeliveryText(value: string): string {
  return normalizeTerminalDeliveryText(value)
}

export const TERMINAL_ID = /^[A-Za-z0-9_-]{1,128}$/
