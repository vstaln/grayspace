import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import * as electron from 'electron'

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
  | { type: 'exit'; id: string }
  | { type: 'response'; requestId?: string; ok: boolean; id?: string; error?: string }

const electronApp = (electron as unknown as { app?: { isPackaged?: boolean } }).app
const moduleDir = dirname(fileURLToPath(import.meta.url))






export class RustPtySidecar extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams
  private stdoutBuffer = ''
  private closing = false

  private constructor(binary: string) {
    super()
    this.child = spawn(binary, ['--engine'], {
      cwd: process.cwd(),
      env: { ...process.env, ORCSPACE_RUST_ENGINE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
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
      this.emit('backend-error', error)
    })
    this.child.on('exit', (code) => {
      if (!this.closing) this.emit('backend-exit', code ?? 1)
    })
  }

  static create(): RustPtySidecar | null {
    if (process.env.ORCSPACE_RUST_ENGINE === '0') return null
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
    return this.send({ type: 'spawn', ...options })
  }

  write(id: string, data: string): RustPtyResult {
    return this.send({ type: 'write', id, data })
  }

  resize(id: string, cols: number, rows: number): RustPtyResult {
    return this.send({ type: 'resize', id, cols, rows })
  }

  dispose(id: string): RustPtyResult {
    return this.send({ type: 'dispose', id })
  }

  close(): void {
    this.closing = true
    try {
      this.send({ type: 'shutdown' })
    } catch {

    }
    try {
      this.child.kill()
    } catch {

    }
  }

  private send(command: Record<string, unknown>): RustPtyResult {
    if (this.child.exitCode !== null || this.child.stdin.destroyed) {
      return { ok: false, error: 'rust engine is not running' }
    }
    try {
      this.child.stdin.write(`${JSON.stringify(command)}\n`)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error) }
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    if (this.stdoutBuffer.length > 2_000_000) {
      this.stdoutBuffer = this.stdoutBuffer.slice(-1_000_000)
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) return
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (!line) continue
      let event: EngineEvent
      try {
        event = JSON.parse(line) as EngineEvent
      } catch {
        console.warn('[rust-engine] ignored malformed event')
        continue
      }
      if (event.type === 'data') this.emit('data', event.id, event.data)
      else if (event.type === 'exit') this.emit('exit', event.id, 0)
      else if (event.type === 'response' && !event.ok) {
        const error = new Error(event.error || 'rust engine request failed')
        this.emit('request-error', event.id, error)
        this.emit('backend-error', error)
      } else if (event.type === 'ready') {
        this.emit('ready')
      }
    }
  }
}

export function createRustPtySidecar(): RustPtySidecar | null {
  return RustPtySidecar.create()
}
