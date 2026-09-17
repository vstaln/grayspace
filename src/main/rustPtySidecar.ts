import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import * as electron from 'electron'
import { rustPtyWorkingDirectory } from './conpty.ts'

export interface RustPtySpawnOptions {
  id: string
  shell: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

export type RustPtyResult = { ok: true } | { ok: false; error: string }

type EngineEvent =
  | { type: 'ready' }
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; code?: number }
  // `request_id` (snake_case) is read alongside `requestId` because engine
  // binaries built before the wire protocol's camelCase rename are still
  // out there and respond in snake_case; accepting either means a stale
  // build degrades to "no correlation, same as before" instead of "every
  // write times out".
  | { type: 'response'; requestId?: string; request_id?: string; ok: boolean; id?: string; error?: string }

const electronApp = (electron as unknown as { app?: { isPackaged?: boolean } }).app
const moduleDir = dirname(fileURLToPath(import.meta.url))
const MAX_ENGINE_STDIN_BUFFER_BYTES = 1 * 1024 * 1024

// How long to wait for the engine to acknowledge a write before treating it
// as failed. This is a same-machine pipe round trip to a process that is
// otherwise idle between commands, so a real ack normally lands in well
// under a millisecond — this only bounds how long a caller waits if the
// engine has wedged without exiting.
const WRITE_ACK_TIMEOUT_MS = 4_000
const SPAWN_ACK_TIMEOUT_MS = 8_000

export function shouldStartRustPty(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORCSPACE_RUST_ENGINE === '1'
}

interface PendingWrite {
  terminalId: string
  resolve: (result: RustPtyResult) => void
  timer: ReturnType<typeof setTimeout>
}






export class RustPtySidecar extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams
  private stdoutBuffer = ''
  private closing = false
  private shutdownSent = false
  private closeTimer?: ReturnType<typeof setTimeout>
  private backendFailureSignalled = false
  private writeRequestCounter = 0
  private sessionCounter = 0
  private readonly sessions = new Map<string, string>()
  private readonly sessionOwners = new Map<string, string>()
  // spawn() only confirms that the command reached the engine. Keep the
  // request pending until the engine reports whether PTY creation succeeded.
  private readonly pendingSpawns = new Set<string>()
  private readonly pendingSpawnTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pendingWrites = new Map<string, PendingWrite>()
  // Short cooldown after a lost ACK drains already queued input failures
  // quickly. Fresh input can retry afterwards; Ctrl+C is always allowed.
  private readonly unacknowledged = new Map<string, number>()

  private constructor(binary: string) {
    super()
    this.child = spawn(binary, ['--engine'], {
      // Match node-pty's host so synchronized frames retain their cursor order.
      cwd: rustPtyWorkingDirectory(),
      env: { ...process.env, ORCSPACE_RUST_ENGINE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child.stdin.on('error', (error) => {
      console.warn('[rust-engine] sidecar stdin error', error)
      this.signalBackendFailure(error)
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      const text = String(chunk).trim()
      if (text) console.warn(`[rust-engine] ${text}`)
    })
    this.child.on('error', (error) => {
      console.warn('[rust-engine] sidecar error', error)
      this.signalBackendFailure(error)
    })
    this.child.on('exit', (code) => {
      clearTimeout(this.closeTimer)
      this.clearAllPendingSpawns()
      this.forgetAllSessions()
      this.failAllPendingWrites('rust engine exited before acknowledging the write')
      if (!this.closing && !this.backendFailureSignalled) {
        this.backendFailureSignalled = true
        this.emit('backend-exit', code ?? 1)
      }
    })
  }

  static create(force = false): RustPtySidecar | null {
    // A local build artifact must not silently replace the terminal backend.
    // Keep the proven node-pty path as the default and make the Rust engine an
    // explicit opt-in while its ConPTY rendering parity is still being tested.
    if (!force && !shouldStartRustPty()) return null
    const packaged = Boolean(electronApp?.isPackaged)
    const extension = process.platform === 'win32' ? '.exe' : ''
    const candidates = packaged
      ? [join(process.resourcesPath, 'native', `orcspace-engine${extension}`)]
      : [
          join(moduleDir, `../../native/target/release/orcspace${extension}`),
          join(moduleDir, `../../native/target/debug/orcspace${extension}`),
          join(process.cwd(), `native/target/release/orcspace${extension}`),
          join(process.cwd(), `native/target/debug/orcspace${extension}`)
        ]
    const binary = candidates.find((candidate) => existsSync(candidate))
    if (!binary) {
      console.warn('[rust-engine] binary unavailable; using node-pty fallback')
      return null
    }
    try {
      return new RustPtySidecar(binary)
    } catch (error) {
      console.warn('[rust-engine] failed to start; using node-pty fallback', error)
      return null
    }
  }

  spawn(options: RustPtySpawnOptions): RustPtyResult {
    const wireId = `orcpty:${++this.sessionCounter}`
    const result = this.send({ type: 'spawn', ...options, id: wireId,
      env: { ORCSPACE_TERMINAL_ID: options.id, ORCSPACE_AGENT_ID: options.id, ...options.env } })
    if (result.ok) {
      const old = this.sessions.get(options.id)
      if (old) {
        this.sessionOwners.delete(old)
        this.send({ type: 'dispose', id: old })
      }
      this.failTerminalWrites(options.id, 'terminal session replaced')
      this.sessions.set(options.id, wireId)
      this.sessionOwners.set(wireId, options.id)
      this.clearPendingSpawn(options.id)
      this.pendingSpawns.add(options.id)
      const timer = setTimeout(() => {
        if (!this.pendingSpawns.delete(options.id)) return
        this.pendingSpawnTimers.delete(options.id)
        this.send({ type: 'dispose', id: wireId })
        this.forgetSession(options.id, wireId)
        this.emit('spawn-error', options.id, new Error('rust engine did not confirm terminal spawn in time'))
      }, SPAWN_ACK_TIMEOUT_MS)
      timer.unref?.()
      this.pendingSpawnTimers.set(options.id, timer)
    }
    return result
  }

  /**
   * Unlike the other commands, write() waits for the engine's own
   * acknowledgement instead of just confirming stdin accepted the bytes.
   * The engine tags every write's response with the `requestId` we send, so
   * a rejection (a dead session, a queue that never drains) reaches the
   * caller as a real failure instead of the input silently vanishing while
   * the UI reports success. See consumeStdout() for the other half.
   */
  write(id: string, data: string): Promise<RustPtyResult> {
    if (this.closing || this.backendFailureSignalled || this.child.exitCode !== null || this.child.stdin.destroyed) {
      return Promise.resolve({ ok: false, error: 'rust engine is not running' })
    }
    const capacity = MAX_ENGINE_STDIN_BUFFER_BYTES + (data === '\x03' ? 64 * 1024 : 0)
    if (this.child.stdin.writableLength > capacity) {
      return Promise.resolve({ ok: false, error: 'rust engine input buffer is full' })
    }
    if ((this.unacknowledged.get(id) ?? 0) > Date.now() && data !== '\x03') {
      return Promise.resolve({
        ok: false,
        error: 'rust engine did not acknowledge the write in time'
      })
    }
    this.writeRequestCounter += 1
    const requestId = `w${this.writeRequestCounter}`
    return new Promise<RustPtyResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingWrites.delete(requestId)) {
          // Briefly reject queued keystrokes, then permit a fresh probe. A
          // missing response must not permanently disable a healthy session.
          this.unacknowledged.set(id, Date.now() + 1_000)
          resolve({ ok: false, error: 'rust engine did not acknowledge the write in time' })
        }
      }, WRITE_ACK_TIMEOUT_MS)
      timer.unref?.()
      this.pendingWrites.set(requestId, { terminalId: id, resolve, timer })
      try {
        // Sent under both spellings so a pre-camelCase engine build still
        // echoes something we can key the pending map on (see the
        // EngineEvent comment above).
        this.child.stdin.write(`${JSON.stringify({ type: 'write', id: this.sessions.get(id) ?? id, data, requestId, request_id: requestId })}\n`)
        // A `false` return from stdin.write() only means the internal buffer
        // is over its high-water mark (backpressure) — the chunk is queued
        // either way. It is not a failure signal, so it is not checked here;
        // the capacity guard above (checked before writing) is what actually
        // caps memory growth, and the real pass/fail verdict comes from the
        // engine's own response.
      } catch (error) {
        const pending = this.pendingWrites.get(requestId)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingWrites.delete(requestId)
        }
        resolve({ ok: false, error: String((error as Error)?.message ?? error) })
      }
    })
  }

  private failAllPendingWrites(message: string): void {
    // The engine is gone or restarting: nothing is owed an answer any more,
    // so no terminal should stay locked out waiting for one.
    this.unacknowledged.clear()
    if (this.pendingWrites.size === 0) return
    const pending = Array.from(this.pendingWrites.values())
    this.pendingWrites.clear()
    for (const entry of pending) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, error: message })
    }
  }

  private clearPendingSpawn(id: string): boolean {
    const pending = this.pendingSpawns.delete(id)
    const timer = this.pendingSpawnTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.pendingSpawnTimers.delete(id)
    }
    return pending
  }

  private clearAllPendingSpawns(): void {
    for (const timer of this.pendingSpawnTimers.values()) clearTimeout(timer)
    this.pendingSpawnTimers.clear()
    this.pendingSpawns.clear()
  }

  private forgetSession(ownerId: string, wireId?: string): void {
    const currentWireId = this.sessions.get(ownerId)
    if (wireId && currentWireId !== wireId) return
    if (currentWireId) {
      this.sessions.delete(ownerId)
      this.sessionOwners.delete(currentWireId)
    } else if (wireId) {
      this.sessionOwners.delete(wireId)
    }
  }

  private forgetAllSessions(): void {
    this.sessions.clear()
    this.sessionOwners.clear()
  }

  private failTerminalWrites(id: string, message: string): void {
    this.unacknowledged.delete(id)
    for (const [requestId, pending] of this.pendingWrites) {
      if (pending.terminalId !== id) continue
      clearTimeout(pending.timer)
      this.pendingWrites.delete(requestId)
      pending.resolve({ ok: false, error: message })
    }
  }

  resize(id: string, cols: number, rows: number): RustPtyResult {
    return this.send({ type: 'resize', id: this.sessions.get(id) ?? id, cols, rows })
  }

  dispose(id: string): RustPtyResult {
    const wireId = this.sessions.get(id) ?? id
    const result = this.send({ type: 'dispose', id: wireId })
    if (result.ok) {
      this.sessions.delete(id)
      this.sessionOwners.delete(wireId)
      this.clearPendingSpawn(id)
      this.failTerminalWrites(id, 'terminal disposed')
    }
    return result
  }

  /**
   * Mark the teardown as intentional without touching the child yet.
   *
   * Shutdown still has terminals to release, and every release writes here.
   * By then the engine has usually seen EOF on its stdin and exited, so those
   * writes fail with EPIPE — which without this would be reported as "the
   * backend died" and trigger a respawn of every terminal mid-shutdown.
   */
  beginClose(): void {
    this.closing = true
  }

  close(): void {
    if (this.shutdownSent) return
    this.shutdownSent = true
    this.closing = true
    this.clearAllPendingSpawns()
    this.failAllPendingWrites('rust engine is shutting down')
    try {
      this.send({ type: 'shutdown' })
    } catch {

    }
    try {
      this.child.stdin.end()
    } catch {

    }
    if (this.child.exitCode === null) {
      this.closeTimer = setTimeout(() => {
        try { this.child.kill() } catch {}
      }, 5_000)
      this.closeTimer.unref?.()
    }
  }

  private signalBackendFailure(error: Error): void {
    this.clearAllPendingSpawns()
    this.forgetAllSessions()
    this.failAllPendingWrites(error.message || 'rust engine failed')
    if (this.closing || this.backendFailureSignalled) return
    this.backendFailureSignalled = true
    this.close()
    this.emit('backend-error', error)
    this.emit('backend-exit', 1)
  }

  private send(command: Record<string, unknown>): RustPtyResult {
    if (this.backendFailureSignalled || this.child.exitCode !== null || this.child.stdin.destroyed) {
      return { ok: false, error: 'rust engine is not running' }
    }
    const lifecycle = command.type === 'dispose' || command.type === 'shutdown'
    const capacity = MAX_ENGINE_STDIN_BUFFER_BYTES + (lifecycle ? 64 * 1024 : 0)
    if (this.child.stdin.writableLength > capacity) {
      return { ok: false, error: 'rust engine input buffer is full' }
    }
    try {
      this.child.stdin.write(`${JSON.stringify(command)}\n`)
      // stdin.write() returning false only means the internal buffer is over
      // its high-water mark (backpressure) — the command is queued and will
      // still be sent. Re-checking writableLength here used to report this
      // already-accepted command as failed, which could make a caller retry
      // and double-send it. The pre-write check above is what actually bounds
      // memory growth; this call either threw (caught below) or the command
      // is on its way to the engine.
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error) }
    }
  }

  /**
   * Walks the buffer with a cursor and compacts it once, instead of reslicing
   * the whole thing per event. A busy engine delivers hundreds of events in a
   * single chunk, and the old `buffer = buffer.slice(newline + 1)` copied every
   * byte still ahead of the cursor each time — quadratic in the chunk size, on
   * the same thread that pumps every PTY, exactly when output is heaviest.
   *
   * The compaction sits in `finally` so a throwing listener cannot leave
   * already-handled lines in the buffer to be replayed as duplicate output.
   */
  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let start = 0
    try {
      while (true) {
        const newline = this.stdoutBuffer.indexOf('\n', start)
        if (newline < 0) return
        const line = this.stdoutBuffer.slice(start, newline).trim()
        start = newline + 1
        if (line) this.handleEngineLine(line)
      }
    } finally {
      if (start > 0) this.stdoutBuffer = this.stdoutBuffer.slice(start)
      // Drain complete events before bounding a malformed partial packet;
      // trimming a whole burst first used to discard ACKs and exit events.
      if (this.stdoutBuffer.length > 2_000_000) this.stdoutBuffer = ''
    }
  }

  private handleEngineLine(line: string): void {
    let event: EngineEvent
    try {
      event = JSON.parse(line) as EngineEvent
    } catch {
      console.warn('[rust-engine] ignored malformed event')
      return
    }
    if (!event || typeof event !== 'object') return
    const eventId = 'id' in event && typeof event.id === 'string' ? event.id : undefined
    const wireId = eventId?.startsWith('orcpty:') ? eventId : undefined
    if (wireId) {
      const owner = this.sessionOwners.get(wireId)
      if (!owner || this.sessions.get(owner) !== wireId) return
      if ('id' in event) event.id = owner
    }
    if (event.type === 'data' && (typeof event.id !== 'string' || typeof event.data !== 'string')) return
    if (event.type === 'data') this.emit('data', event.id, event.data)
    else if (event.type === 'exit') {
      // `data` was guarded but `exit` was not, so a malformed packet emitted an
      // exit for terminal `undefined` — which matches no session and reached
      // listeners as a phantom teardown.
      if (typeof event.id !== 'string') return
      this.clearPendingSpawn(event.id)
      this.failTerminalWrites(event.id, 'terminal exited')
      this.forgetSession(event.id, wireId)
      this.emit('exit', event.id, typeof event.code === 'number' ? event.code : 0)
    } else if (event.type === 'response') {
      const requestId = event.requestId ?? event.request_id
      // Any answer for this terminal — including a late one for a write
      // already given up on, and including a rejection — proves the engine
      // is still talking about it, so it goes back in circulation.
      if (event.id) this.unacknowledged.delete(event.id)
      if (!requestId && typeof event.id === 'string' && this.clearPendingSpawn(event.id)) {
        if (!event.ok) {
          this.emit('spawn-error', event.id, new Error(event.error || 'rust engine failed to spawn terminal'))
        }
        return
      }
      if (requestId) {
        const pending = this.pendingWrites.get(requestId)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingWrites.delete(requestId)
          pending.resolve(event.ok ? { ok: true } : { ok: false, error: event.error || 'rust engine request failed' })
        }
      }
      if (!event.ok) {
        const error = new Error(event.error || 'rust engine request failed')
        this.emit('request-error', event.id, error)
      }
    } else if (event.type === 'ready') {
      this.emit('ready')
    }
  }
}

export function createRustPtySidecar(options: { force?: boolean } = {}): RustPtySidecar | null {
  return RustPtySidecar.create(options.force === true)
}
