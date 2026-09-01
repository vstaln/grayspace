import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import * as os from 'os'
import { stripAnsi } from './ansi.ts'
import { killProcessTree } from './procTree.ts'
import { quoteWin32CmdArg } from './ipc/shared.ts'

/** Chat models the pane offers — ids match the renderer's ChatPane picker. */
export type ChatModelId = 'codex' | 'claude' | 'grok' | 'antigravity' | 'opencode'

interface ModelSpec {
  /** The CLI binary, as typed in a shell. */
  command: string
  /** Non-interactive ("headless") arguments that make the CLI print its
   *  answer to stdout and exit instead of opening a TUI. */
  headlessArgs: string[]
}

/**
 * How each CLI is invoked for a one-shot question. These are the vendors'
 * documented non-interactive modes; a CLI that is missing or rejects the
 * flags exits with a message on stderr, which the pane shows inline — a
 * visible failure instead of the old silent "отправлено в CLI" stub.
 */
const MODELS: Record<ChatModelId, ModelSpec> = {
  claude: { command: 'claude', headlessArgs: ['-p'] },
  codex: { command: 'codex', headlessArgs: ['exec', '--skip-git-repo-check'] },
  grok: { command: 'grok', headlessArgs: ['-p'] },
  antigravity: { command: 'agy', headlessArgs: ['-p'] },
  opencode: { command: 'opencode', headlessArgs: ['run'] }
}

const IS_WIN = process.platform === 'win32'
/** Safety net: a headless CLI that somehow wedges must not sit forever. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000
/** Stream chunks are flushed to the renderer at most once per frame-ish. */
const FLUSH_INTERVAL_MS = 16
const MAX_PROMPT_CHARS = 32_000

interface ChatRun {
  child: ChildProcess
  /** Cleaned chunks waiting for the next 16 ms flush. */
  pending: string[]
  flushTimer: NodeJS.Timeout | null
  timeoutTimer: NodeJS.Timeout | null
  cancelled: boolean
  timedOut: boolean
  exited: boolean
}

/**
 * Runs chat threads against the installed agent CLIs in their headless
 * (print) mode and streams the cleaned answer back, one `data` event per
 * animation frame.
 *
 * This replaces the previous design — an interactive CLI inside a hidden pty
 * per thread. That design had two fatal flaws: the renderer's pty-output
 * subscription never attached after the terminal was created (so every reply
 * fell back to the "Открой Code tab" stub), and each thread kept a live
 * interactive `claude`/`codex` TUI process running in the background for the
 * lifetime of the app — the hidden shells the freezes were eventually traced
 * to. Here each message is one short-lived process with stdin closed: nothing
 * to subscribe to too late, nothing left running when the answer is done.
 */
import * as fs from 'fs'
import * as path from 'path'

interface ResolvedInvocation {
  command: string
  args: string[]
  shell: boolean
}

function resolveInvocation(spec: ModelSpec, prompt: string): ResolvedInvocation {
  if (!IS_WIN) {
    return { command: spec.command, args: [...spec.headlessArgs, prompt], shell: false }
  }

  // On Windows, try resolving executable or npm wrapper directly so multiline
  // prompts are not corrupted by cmd.exe line splitting.
  const pathext = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
  const pathDirs = (process.env.PATH || '').split(path.delimiter)

  for (const dir of pathDirs) {
    if (!dir) continue
    for (const ext of pathext) {
      const fullPath = path.join(dir, spec.command + ext)
      if (fs.existsSync(fullPath)) {
        const extLower = ext.toLowerCase()
        if (extLower === '.exe') {
          return { command: fullPath, args: [...spec.headlessArgs, prompt], shell: false }
        }
        if (extLower === '.cmd' || extLower === '.bat') {
          try {
            const content = fs.readFileSync(fullPath, 'utf8')
            const m = /"%_prog%"\s+"([^"]+\.js)"/i.exec(content) || /node(?:\.exe)?"\s+"([^"]+\.js)"/i.exec(content)
            if (m) {
              const scriptPath = m[1].replace(/%dp0%/gi, path.dirname(fullPath))
              if (fs.existsSync(scriptPath)) {
                return { command: process.execPath, args: [scriptPath, ...spec.headlessArgs, prompt], shell: false }
              }
            }
          } catch {
            /* ignore read error and fall through */
          }
          // Default .cmd invocation: pass through cmd.exe /d /s /c
          return {
            command: 'cmd.exe',
            args: ['/d', '/s', '/c', spec.command, ...spec.headlessArgs, quoteWin32CmdArg(prompt)],
            shell: false
          }
        }
      }
    }
  }

  // Fallback if not found on PATH explicitly:
  const line = [spec.command, ...spec.headlessArgs, quoteWin32CmdArg(prompt)].join(' ')
  return { command: line, args: [], shell: true }
}

export class ChatRunner extends EventEmitter {
  private readonly runs = new Map<string, ChatRun>()

  isRunning(threadId: string): boolean {
    return this.runs.has(threadId)
  }

  /**
   * Starts (or restarts — a new message in the same thread supersedes a run
   * still in flight) the headless CLI for one thread. Resolves once the
   * process actually spawned; the answer itself arrives through `data`/`exit`.
   */
  send(threadId: string, model: ChatModelId, prompt: string, cwd?: string): { ok: true } | { error: string } {
    if (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) {
      return { error: 'invalid thread id' }
    }
    const spec = MODELS[model]
    if (!spec) return { error: `unknown model: ${String(model)}` }
    if (typeof prompt !== 'string' || !prompt.trim()) return { error: 'empty prompt' }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return { error: `prompt exceeds ${MAX_PROMPT_CHARS} characters` }
    }
    // A new message replaces whatever the thread was still generating.
    this.stop(threadId)

    let child: ChildProcess
    try {
      const invocation = resolveInvocation(spec, prompt)
      if (invocation.shell) {
        child = spawn(invocation.command, {
          shell: true,
          cwd: cwd || undefined,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            NO_COLOR: '1',
            FORCE_COLOR: '0',
            TERM: 'dumb'
          }
        })
      } else {
        child = spawn(invocation.command, invocation.args, {
          cwd: cwd || undefined,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            NO_COLOR: '1',
            FORCE_COLOR: '0',
            TERM: 'dumb'
          }
        })
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }

    const run: ChatRun = {
      child,
      pending: [],
      flushTimer: null,
      timeoutTimer: null,
      cancelled: false,
      timedOut: false,
      exited: false
    }
    this.runs.set(threadId, run)

    const collect = (raw: Buffer): void => {
      const chunk = stripAnsi(raw.toString('utf8'))
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
      if (!chunk) return
      run.pending.push(chunk)
      if (run.flushTimer === null) {
        run.flushTimer = setTimeout(() => this.flush(threadId), FLUSH_INTERVAL_MS)
        run.flushTimer.unref?.()
      }
    }

    child.stdout?.on('data', collect)
    // Errors (bad flags, not logged in, missing binary) stream on stderr —
    // surfaced in the bubble rather than dying in a console the user never
    // opens.
    child.stderr?.on('data', collect)
    child.on('error', (err) => {
      // ENOENT and friends arrive here: the CLI is simply not installed.
      run.pending.push(`\n\n[${spec.command} failed to start: ${err.message}]`)
      this.finish(threadId, run, { code: 1 })
    })
    child.on('close', (code) => {
      this.finish(threadId, run, { code: code ?? 0 })
    })

    run.timeoutTimer = setTimeout(() => {
      run.timedOut = true
      this.stop(threadId)
    }, RUN_TIMEOUT_MS)
    run.timeoutTimer.unref?.()

    return { ok: true }
  }

  /** Stops the in-flight run for a thread (user Stop button, thread switch). */
  stop(threadId: string): boolean {
    const run = this.runs.get(threadId)
    if (!run) return false
    run.cancelled = true
    this.killRun(run)
    // The 'close' event finishes the bookkeeping; if it already fired, do it
    // here so a Stop click always resolves the bubble.
    this.finish(threadId, run, { code: 0, force: true })
    return true
  }

  /** Thread deleted: stop and forget. */
  dispose(threadId: string): void {
    this.stop(threadId)
  }

  disposeAll(): void {
    for (const id of Array.from(this.runs.keys())) this.dispose(id)
  }

  private killRun(run: ChatRun): void {
    try {
      if (typeof run.child.pid === 'number') killProcessTree(run.child.pid)
      else run.child.kill()
    } catch {
      /* already gone */
    }
  }

  private flush(threadId: string): void {
    const run = this.runs.get(threadId)
    if (!run) return
    if (run.flushTimer !== null) {
      clearTimeout(run.flushTimer)
      run.flushTimer = null
    }
    if (run.pending.length === 0) return
    const chunk = run.pending.join('')
    run.pending = []
    this.emit('data', threadId, chunk)
  }

  private finish(threadId: string, run: ChatRun, opts: { code: number; force?: boolean }): void {
    if (run.exited) return
    if (opts.force !== true && !run.exited) {
      // Normal path: give stdout/stderr a beat to drain before the final
      // flush so the last chunk of the answer is not lost to the race
      // between 'close' and the pipe's final 'data' event.
      run.exited = true
      setImmediate(() => {
        this.flush(threadId)
        this.cleanup(threadId, run)
        this.emit('exit', threadId, {
          exitCode: opts.code,
          cancelled: run.cancelled,
          timedOut: run.timedOut
        })
      })
      return
    }
    run.exited = true
    this.flush(threadId)
    this.cleanup(threadId, run)
    this.emit('exit', threadId, { exitCode: opts.code, cancelled: run.cancelled, timedOut: run.timedOut })
  }

  private cleanup(threadId: string, run: ChatRun): void {
    if (run.flushTimer !== null) {
      clearTimeout(run.flushTimer)
      run.flushTimer = null
    }
    if (run.timeoutTimer !== null) {
      clearTimeout(run.timeoutTimer)
      run.timeoutTimer = null
    }
    if (this.runs.get(threadId) === run) this.runs.delete(threadId)
  }
}

/** The one runner behind the chat IPC surface. */
export const chatRunner = new ChatRunner()
