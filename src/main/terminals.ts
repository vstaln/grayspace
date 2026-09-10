import { EventEmitter } from 'events'
import * as os from 'os'
import * as fs from 'fs'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import { OUTPUT_BUFFER_LIMIT, MAX_TERMINAL_WRITE_BYTES, defaultShell } from './config.ts'
import { killProcessTree } from './procTree.ts'
import { orcTerminalEnv } from './orcCli.ts'
import { TerminalRingBuffer } from './terminalBuffer.ts'
import { isDefaultTerminalTitle, makeUniqueTitle, pickTerminalName } from './terminalNames.ts'
import type { RustPtySpawnOptions, RustPtySidecar } from './rustPtySidecar.ts'








function terminalBaseEnv(env: Record<string, string>): Record<string, string> {
  const copy: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()


    if (
      upper === 'PATH' ||
      upper === 'NO_COLOR' ||
      upper === 'FORCE_COLOR' ||
      upper === 'TERM' ||
      upper === 'COLORTERM' ||
      upper === 'COLORFGBG'
    ) continue
    copy[key] = value
  }
  return copy
}







function codeTerminalColorEnv(id: string): Record<string, string> {
  if (!id.startsWith('code-')) return {}
  return {
    CLICOLOR: '1',
    CLICOLOR_FORCE: '1',
    ANSICON: '1',
    ConEmuANSI: 'ON'
  }
}

function safeOrcTerminalEnv(id: string): Record<string, string> {
  try {
    return orcTerminalEnv(id)
  } catch {
    // The terminal must remain usable even while the Electron control
    // channel is unavailable (for example during startup or recovery).
    // The shell can still run normally; OrcSpace integration will be
    // restored on the next spawn once the control channel is ready.
    const path = process.env.PATH ?? process.env.Path ?? ''
    return {
      ...(path ? { PATH: path } : {}),
      ORCSPACE_AGENT_ID: id,
      ORCSPACE_NODE: process.execPath
    }
  }
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
  pty: IPty | null
  nativeAlive: boolean







  ptyDisposers: { dispose(): void }[]
  title: string
  cwd: string




  output: TerminalRingBuffer








  readOffset: number

  rootPid?: number

  lastDataAt: number

  exited?: boolean
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




  private preferredId: string | null = null
  private deliveryCounter = 0







  private readonly inputTails = new Map<string, Promise<void>>()

  constructor(
    options: {
      getWindowsShell?: () => 'cmd' | 'powershell'
      getFavoriteNames?: () => string[]
      rustPty?: RustPtySidecar | null
    } = {}
  ) {
    super()
    this.getWindowsShell = options.getWindowsShell ?? (() => 'cmd')
    this.getFavoriteNames = options.getFavoriteNames ?? (() => [])
    this.rustPty = options.rustPty ?? null
    this.rustPty?.on('data', (id: string, chunk: string) => this.handleRustOutput(id, chunk))
    this.rustPty?.on('exit', (id: string, code: number) => this.handleRustExit(id, code))
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

  reserve(options: { title?: string; cwd?: string; prefix?: string } = {}): TerminalInfo {
    const prefix = options.prefix || 'term'
    const id = this.nextId(prefix)

    const explicit = options.title?.trim()
    const taken = this.takenTitles()
    const title =
      explicit && !isDefaultTerminalTitle(explicit)
        ? makeUniqueTitle(explicit, taken)
        : this.assignAutoName()
    const record: TerminalRecord = {
      pty: null,
      nativeAlive: false,
      ptyDisposers: [],
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


        if (fs.statSync(cwd).isDirectory()) return cwd
      } catch {

      }
    }
    return os.homedir()
  }

  private toInfo(id: string, record: TerminalRecord): TerminalInfo {
    return { id, title: record.title, cwd: record.cwd, alive: record.pty !== null || record.nativeAlive }
  }

  has(id: string): boolean {
    return this.terminals.has(id)
  }

  isRunning(id: string): boolean {
    const record = this.terminals.get(id)
    return record?.pty != null || record?.nativeAlive === true
  }



  list(): TerminalInfo[] {
    return Array.from(this.terminals, ([id, record]) => this.toInfo(id, record))
  }









  spawn(id: string, cols?: number, rows?: number, cwd?: string): SpawnResult {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id))
      return { ok: false, error: 'invalid terminal id' }



    if (this.disposed.has(id)) return { ok: false, error: 'terminal was closed' }
    let record = this.terminals.get(id)
    if (record && (record.pty || record.nativeAlive)) {


      if (isPositiveInt(cols) && isPositiveInt(rows)) {
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
      record = {
        pty: null,
        nativeAlive: false,
        ptyDisposers: [],
        title: id,
        cwd: this.resolveCwd(cwd),
        output: new TerminalRingBuffer({ maxBytes: OUTPUT_BUFFER_LIMIT }),
        readOffset: 0,
        lastDataAt: 0
      }
      this.terminals.set(id, record)
      record.title = this.assignAutoName(id)
      this.emit('title', id, record.title)
    } else if (cwd && !record.pty && !record.nativeAlive) {

      const resolved = this.resolveCwd(cwd)
      if (resolved !== record.cwd) record.cwd = resolved
    }

    if (this.rustPty) {
      const result = this.rustPty.spawn(this.rustSpawnOptions(id, record, cols, rows))
      if (result.ok) {
        record.nativeAlive = true
        this.preferredId = id
        this.emit('spawn', id)
        return { ok: true }
      }
      console.warn(`[rust-engine] spawn failed for ${id}; using node-pty fallback`, result.error)
    }

    try {
      const child = pty.spawn(defaultShell(this.getWindowsShell()), [], {
        name: 'xterm-256color',
        cols: isPositiveInt(cols) ? cols : 80,
        rows: isPositiveInt(rows) ? rows : 24,
        cwd: record.cwd,
        env: {
          ...terminalBaseEnv(process.env as Record<string, string>),
          ...safeOrcTerminalEnv(id),
          ORCSPACE: '1',
          ORCSPACE_TERMINAL_ID: id,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          FORCE_COLOR: '3',
          COLORFGBG: '15;0',
          TERM_PROGRAM: 'OrcSpace',
          TERM_PROGRAM_VERSION: '2.0.0',
          LANG: process.env.LANG || 'en_US.UTF-8',
          LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8',
          ...codeTerminalColorEnv(id)
        }
      })
      record.pty = child
      record.rootPid = child.pid
      this.preferredId = id

      record.ptyDisposers.push(
        child.onData((chunk) => {
          const current = this.terminals.get(id)
          if (!current || current.pty !== child) return
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
      ...terminalBaseEnv(process.env as Record<string, string>),
      ...safeOrcTerminalEnv(id),
      ORCSPACE: '1',
      ORCSPACE_TERMINAL_ID: id,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
      COLORFGBG: '15;0',
      TERM_PROGRAM: 'OrcSpace',
      TERM_PROGRAM_VERSION: '2.0.0',
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8',
      ...codeTerminalColorEnv(id)
    }
    return {
      id,
      shell: defaultShell(this.getWindowsShell()),
      cols: isPositiveInt(cols) ? cols : 80,
      rows: isPositiveInt(rows) ? rows : 24,
      cwd: record.cwd,
      env
    }
  }

  private handleRustOutput(id: string, chunk: string): void {
    const current = this.terminals.get(id)
    if (!current || !current.nativeAlive) return
    current.output.append(chunk)
    current.lastDataAt = Date.now()
    this.emit('data', id, chunk)
  }

  private handleRustExit(id: string, exitCode: number): void {
    const current = this.terminals.get(id)
    if (!current || !current.nativeAlive) return
    current.nativeAlive = false
    current.exited = true
    this.emit('exit', id, exitCode)
  }

  private handleRustBackendExit(exitCode: number): void {
    for (const [id, record] of this.terminals) {
      if (!record.nativeAlive) continue
      record.nativeAlive = false
      record.exited = true
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
    // The sidecar has already rejected an operation for this PTY. Keeping it
    // marked alive creates a zombie terminal: future writes appear successful
    // because they only reach the sidecar pipe, while the PTY actor is gone or
    // blocked. Surface the failure as an exit so the widget can recover.
    current.nativeAlive = false
    current.exited = true
    this.emit('backend-error', error)
    // A timed-out native request can leave one PTY actor blocked. Marking the
    // record dead lets spawn_with_options replace that actor; if the sidecar
    // itself is unavailable, spawn() falls back to node-pty.
    const restarted = this.tryRestart(id)
    if (!restarted.ok) this.emit('exit', id, 1)
  }

  private tryRestart(id: string): SpawnResult {
    try {
      return this.spawn(id)
    } catch (error) {
      console.warn(`[terminal] failed to recover ${id}`, error)
      return { ok: false, error: String((error as Error)?.message ?? error) }
    }
  }





  write(id: string, data: string): { ok: true } | { ok: false; error: string } {
    if (typeof data !== 'string' || typeof id !== 'string') {
      return { ok: false, error: 'invalid write' }
    }


    if (Buffer.byteLength(data, 'utf8') > MAX_TERMINAL_WRITE_BYTES) {
      return { ok: false, error: `write exceeds ${MAX_TERMINAL_WRITE_BYTES} bytes` }
    }
    const record = this.terminals.get(id)
    if (!record) return { ok: false, error: `terminal ${id} not found` }
    if (record.nativeAlive && this.rustPty) {
      const result = this.rustPty.write(id, data)
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


  async writeInput(id: string, data: string): Promise<ReturnType<TerminalManager['write']>> {
    return this.serializeInput(id, () => this.write(id, data))
  }


  async writeLine(
    id: string,
    text: string,
    options: { pressEnter?: boolean; signal?: AbortSignal } = {}
  ): Promise<ReturnType<TerminalManager['write']>> {
    return this.serializeInput(id, async () => {
      const singleLine = text.replace(/\r\n|\r|\n/g, ' ')
      const typed = this.write(id, singleLine)
      if (!typed.ok || options.pressEnter === false) return typed
      if (!(await deliveryDelay(30, options.signal))) return { ok: false, error: 'delivery cancelled' }
      return this.write(id, '\r')
    })
  }

  private serializeInput<T>(id: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.inputTails.get(id) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    const settled = current.then(
      () => undefined,
      () => undefined
    )
    this.inputTails.set(id, settled)
    return current.finally(() => {
      if (this.inputTails.get(id) === settled) this.inputTails.delete(id)
    })
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

  private async stageDelivery(
    id: string,
    text: string,
    options: { pressEnter?: boolean; signal?: AbortSignal }
  ): Promise<{ ok: true; offset: number; expected: string } | { ok: false; error: string }> {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'message is empty' }
    const record = this.terminals.get(id)
    if (!record || !this.isRunning(id)) return { ok: false, error: `terminal ${id} is not running` }

    const singleLine = text.replace(/\r\n|\r|\n/g, ' ')
    const expected = normalizeDeliveryText(singleLine)
    if (!expected) return { ok: false, error: 'message has no visible text' }
    const offset = record.output.globalOffset

    const typed = this.write(id, singleLine)
    if (!typed.ok) return { ok: false, error: typed.error }
    if (options.pressEnter !== false) {
      if (!(await deliveryDelay(30, options.signal))) return { ok: false, error: 'delivery cancelled' }
      const submitted = this.write(id, '\r')
      if (!submitted.ok) return { ok: false, error: submitted.error }
    }
    return { ok: true, offset, expected }
  }

  private waitForDeliveryEcho(
    id: string,
    offset: number,
    expected: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    const matches = (): boolean => {
      const record = this.terminals.get(id)
      if (!record || !this.isRunning(id)) return false
      const from = Math.max(offset, record.output.startOffset)
      const output = record.output.read(from, OUTPUT_BUFFER_LIMIT).data
      return normalizeDeliveryText(output).includes(expected)
    }
    if (matches()) return Promise.resolve(true)
    if (signal?.aborted) return Promise.resolve(false)

    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.off('data', onData)
        this.off('exit', onExit)
        this.off('release', onRelease)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onData = (terminalId: string): void => {
        if (terminalId === id && matches()) finish(true)
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
    const current = this.terminals.get(id)
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
    current.exited = true

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
  ): { id: string; title: string; cwd: string; scrollback: string } | null {
    const record = this.terminals.get(id)
    if (!record) return null
    const scrollback = record.output.toString()


    const wasRunning = this.isRunning(id)
    try {
      record.pty?.kill()
    } catch {

    }
    if (record.nativeAlive) this.rustPty?.dispose(id)




    for (const d of record.ptyDisposers ?? []) {
      try {
        d.dispose()
      } catch {

      }
    }
    record.ptyDisposers = []
    this.terminals.delete(id)
    if (this.preferredId === id) this.preferredId = null




    if (wasRunning && options.killDescendants !== false) killProcessTree(record.rootPid)
    const info = { id, title: record.title, cwd: record.cwd, scrollback }
    this.emit('release', info)
    return info
  }







  disposeWhenDetached(id: string, _graceMs = 750): void {



    void id
    void _graceMs
  }

  disposeAll(options: ReleaseOptions = {}): void {


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
  return String(value ?? '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function deliveryDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isPositiveInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0
}


export const TERMINAL_ID = /^[A-Za-z0-9_-]{1,128}$/
