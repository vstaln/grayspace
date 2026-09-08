import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import * as os from 'os'
import { StringDecoder } from 'string_decoder'
import { stripAnsi } from './ansi.ts'
import { killProcessTree } from './procTree.ts'
import { quoteWin32CmdArg } from './ipc/shared.ts'

/** Chat models the pane offers — ids match the renderer's ChatPane picker. */
export type ChatModelId =
  | 'codex'
  | 'claude'
  | 'grok'
  | 'antigravity'
  | 'opencode'
  | 'gemini'
  | 'cursor'
  | 'aider'
  | 'custom'

export type ChatEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export interface ChatSendOptions {
  model?: string
  effort?: ChatEffort
  /** Absolute image paths for CLIs that support native initial attachments. */
  images?: string[]
  /** Custom CLI argv template. Use {prompt}, or the prompt is appended. */
  command?: string
}

const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/

interface ModelSpec {
  /** The CLI binary, as typed in a shell. */
  command: string
  /** Non-interactive ("headless") arguments that make the CLI print its
   *  answer to stdout and exit instead of opening a TUI. */
  headlessArgs: string[]
  modelFlag?: boolean
  effortFlag?: boolean | 'codex-config' | 'opencode-variant'
  customTemplate?: boolean
}

/**
 * How each CLI is invoked for a one-shot question. These are the vendors'
 * documented non-interactive modes; a CLI that is missing or rejects the
 * flags exits with a message on stderr, which the pane shows inline — a
 * visible failure instead of the old silent "отправлено в CLI" stub.
 */
const MODELS: Record<ChatModelId, ModelSpec> = {
  claude: { command: 'claude', headlessArgs: ['-p'], modelFlag: true, effortFlag: true },
  // JSONL keeps Codex' diagnostic banner, echoed prompt and token accounting
  // out of the chat bubble. ChatRunner extracts only agent messages below.
  codex: { command: 'codex', headlessArgs: ['exec', '--skip-git-repo-check', '--json'], modelFlag: true, effortFlag: 'codex-config' },
  grok: { command: 'grok', headlessArgs: ['-p'], modelFlag: true, effortFlag: true },
  antigravity: { command: 'agy', headlessArgs: ['-p'], modelFlag: true, effortFlag: true },
  opencode: { command: 'opencode', headlessArgs: ['run'], modelFlag: true, effortFlag: 'opencode-variant' },
  gemini: { command: 'gemini', headlessArgs: ['-p'], modelFlag: true },
  cursor: { command: 'cursor-agent', headlessArgs: ['-p'], modelFlag: true },
  aider: { command: 'aider', headlessArgs: ['--message'], modelFlag: true },
  custom: { command: '', headlessArgs: [], customTemplate: true }
}

const IS_WIN = process.platform === 'win32'
/** Safety net: a headless CLI that somehow wedges must not sit forever. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000
/** Stream chunks are flushed to the renderer at most once per frame-ish. */
const FLUSH_INTERVAL_MS = 16
const MAX_PROMPT_CHARS = 32_000
const MAX_PENDING_CHARS = 2_000_000

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
  /** The command is a JavaScript CLI launched through Electron's executable. */
  useElectronAsNode?: boolean
}

export function buildChatProcessEnv(useElectronAsNode = false): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb'
  }
  // In a packaged Electron app, process.execPath is OrcSpace.exe rather than
  // node.exe.  npm's Windows .cmd wrappers can be launched directly by
  // passing their JS entry point to that executable, but Electron otherwise
  // starts a second OrcSpace instance.  This flag puts Electron in its
  // Node-compatible mode so the CLI script runs in the child process.
  if (useElectronAsNode) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

function buildInvocationArgs(spec: ModelSpec, prompt: string, options?: ChatSendOptions): string[] {
  if (spec.customTemplate) {
    const parsed = parseCustomCommand(options?.command ?? '')
    const hasPlaceholder = parsed.args.some((arg) => arg.includes('{prompt}'))
    const args = parsed.args.map((arg) => arg.replaceAll('{prompt}', prompt))
    if (!hasPlaceholder) args.push(prompt)
    return args
  }
  const args = [...spec.headlessArgs]
  if (spec.modelFlag && options?.model) args.push('--model', options.model)
  if (spec.effortFlag && options?.effort) {
    // Codex CLI 0.152+ removed the old --effort flag. Its equivalent is a
    // TOML config override; passing --effort makes `codex exec` fail before it
    // ever sees the prompt (the error shown in Chat).
    if (spec.effortFlag === 'codex-config') args.push('--config', `model_reasoning_effort=${options.effort}`)
    else if (spec.effortFlag === 'opencode-variant') args.push('--variant', options.effort)
    else args.push('--effort', options.effort)
  }
  // Codex consumes images as repeatable --image arguments before the prompt.
  // Other providers are left untouched until their installed CLI advertises a
  // stable equivalent; blindly adding this flag would recreate the same
  // provider-specific startup failure we are fixing here.
  if (spec.command === 'codex' && options?.images) {
    for (const image of options.images) args.push('--image', image)
  }
  args.push(prompt)
  return args
}

/** Pure command builder kept public so provider-specific flags stay covered by tests. */
export function buildChatInvocationArgs(model: ChatModelId, prompt: string, options?: ChatSendOptions): string[] {
  return buildInvocationArgs(MODELS[model], prompt, options)
}

export function parseCustomCommand(value: string): { command: string; args: string[] } {
  const source = String(value ?? '').trim()
  if (!source || source.length > 512) throw new Error('custom CLI command is required (max 512 characters)')
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const char of source) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (quote) throw new Error('custom CLI command has an unclosed quote')
  if (current) tokens.push(current)
  const command = tokens.shift() ?? ''
  if (!command || /[\r\n\0]/.test(command)) throw new Error('custom CLI command is invalid')
  return { command, args: tokens }
}

function resolveInvocation(spec: ModelSpec, prompt: string, options?: ChatSendOptions): ResolvedInvocation {
  const invocationArgs = buildInvocationArgs(spec, prompt, options)
  if (!IS_WIN) {
    return { command: spec.command, args: invocationArgs, shell: false }
  }

  // A custom CLI may be an absolute path with spaces. Resolve it before the
  // PATH scan; joining PATH entries to an already absolute command produces a
  // malformed path and falls through to an unquoted cmd.exe invocation.
  if (path.isAbsolute(spec.command) && fs.existsSync(spec.command)) {
    const directExt = path.extname(spec.command).toLowerCase()
    if (directExt === '.exe') return { command: spec.command, args: invocationArgs, shell: false }
    if (directExt === '.cmd' || directExt === '.bat') {
      return {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', spec.command, ...invocationArgs.map(quoteWin32CmdArg)],
        shell: false
      }
    }
    return { command: spec.command, args: invocationArgs, shell: false }
  }

  // On Windows, try resolving executable or npm wrapper directly so multiline
  // prompts are not corrupted by cmd.exe line splitting. Cap PATH scan to 60 entries to avoid hang on network drives.
  const pathext = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
  const pathDirs = (process.env.PATH || '').split(path.delimiter).slice(0, 60)

  for (const dir of pathDirs) {
    if (!dir) continue
    for (const ext of pathext) {
      const fullPath = path.join(dir, spec.command + ext)
      let exists = false
      try { exists = fs.existsSync(fullPath) } catch { continue }
      if (!exists) continue
      const extLower = ext.toLowerCase()
      if (extLower === '.exe') {
        return { command: fullPath, args: invocationArgs, shell: false }
      }
      if (extLower === '.cmd' || extLower === '.bat') {
        try {
          const content = fs.readFileSync(fullPath, 'utf8')
          const m = /"%_prog%"\s+"([^"]+\.js)"/i.exec(content) || /node(?:\.exe)?"\s+"([^"]+\.js)"/i.exec(content)
          if (m) {
            const scriptPath = m[1].replace(/%dp0%/gi, path.dirname(fullPath))
            if (fs.existsSync(scriptPath)) {
              // The npm Codex JS launcher spawns codex.exe without
              // `windowsHide`. When its parent is a GUI Electron process,
              // Windows consequently creates the visible console window the
              // user sees over OrcSpace. Launch the bundled native executable
              // ourselves so our hidden-process flag applies to the real CLI.
              if (spec.command === 'codex') {
                const triple = process.arch === 'arm64'
                  ? 'aarch64-pc-windows-msvc'
                  : 'x86_64-pc-windows-msvc'
                const platformPackage = process.arch === 'arm64'
                  ? 'codex-win32-arm64'
                  : 'codex-win32-x64'
                const codexPackage = path.dirname(path.dirname(scriptPath))
                const nativeBinary = path.join(
                  codexPackage,
                  'node_modules',
                  '@openai',
                  platformPackage,
                  'vendor',
                  triple,
                  'bin',
                  'codex.exe'
                )
                if (fs.existsSync(nativeBinary)) {
                  return { command: nativeBinary, args: invocationArgs, shell: false }
                }
              }
              return {
                command: process.execPath,
                args: [scriptPath, ...invocationArgs],
                shell: false,
                useElectronAsNode: true
              }
            }
          }
        } catch {
          /* ignore read error and fall through */
        }
        // Default .cmd invocation: pass through cmd.exe /d /s /c
        return {
          command: 'cmd.exe',
          args: ['/d', '/s', '/c', spec.command, ...invocationArgs.map(quoteWin32CmdArg)],
          shell: false
        }
      }
    }
  }

  // Fallback if not found on PATH explicitly: still no shell:true — spawn
  // cmd.exe with an argv array so prompt quoting stays in quoteWin32CmdArg
  // instead of a hand-joined command line the shell re-parses.
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', spec.command, ...invocationArgs.map(quoteWin32CmdArg)],
    shell: false
  }
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
  send(threadId: string, model: ChatModelId, prompt: string, cwd?: string, options?: ChatSendOptions): { ok: true } | { error: string } {
    if (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) {
      return { error: 'invalid thread id' }
    }
    let spec = MODELS[model]
    if (!spec) return { error: `unknown model: ${String(model)}` }
    if (typeof prompt !== 'string' || !prompt.trim()) return { error: 'empty prompt' }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return { error: `prompt exceeds ${MAX_PROMPT_CHARS} characters` }
    }
    if (options?.model !== undefined && !MODEL_NAME_RE.test(options.model)) {
      return { error: 'invalid model id' }
    }
    if (model === 'custom') {
      try {
        const parsed = parseCustomCommand(options?.command ?? '')
        spec = { command: parsed.command, headlessArgs: parsed.args, customTemplate: true }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
    // A new message replaces whatever the thread was still generating.
    this.stop(threadId)

    let child: ChildProcess
    try {
      const invocation = resolveInvocation(spec, prompt, options)
      if (invocation.shell) {
        child = spawn(invocation.command, {
          shell: true,
          cwd: cwd || undefined,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: buildChatProcessEnv(invocation.useElectronAsNode)
        })
      } else {
        child = spawn(invocation.command, invocation.args, {
          cwd: cwd || undefined,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: buildChatProcessEnv(invocation.useElectronAsNode)
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

    let pendingChars = 0
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let codexJsonBuffer = ''
    let codexStderrBuffer = ''
    let codexMessageCount = 0
    const collectText = (rawStr: string): void => {
      if (pendingChars > MAX_PENDING_CHARS) return
      const chunk = stripAnsi(rawStr)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
      if (!chunk) return
      run.pending.push(chunk)
      pendingChars += chunk.length
      if (pendingChars > MAX_PENDING_CHARS) run.pending.push('\n\n[Output truncated — exceeded 2M chars]')
      if (run.flushTimer === null) {
        run.flushTimer = setTimeout(() => this.flush(threadId), FLUSH_INTERVAL_MS)
        run.flushTimer.unref?.()
      }
    }

    const collectStdout = (raw: Buffer): void => {
      const decoded = stdoutDecoder.write(raw.length > 512_000 ? raw.subarray(0, 512_000) : raw)
      if (model !== 'codex') {
        collectText(decoded + (raw.length > 512_000 ? '\n[truncated chunk]' : ''))
        return
      }
      codexJsonBuffer += decoded
      const lines = codexJsonBuffer.split(/\r?\n/)
      codexJsonBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const message = extractCodexJsonLine(line)
        if (message) {
          collectText(`${codexMessageCount > 0 ? '\n\n' : ''}${message}`)
          codexMessageCount++
        }
      }
    }

    const collectStderr = (raw: Buffer): void => {
      const decoded = stderrDecoder.write(raw.length > 512_000 ? raw.subarray(0, 512_000) : raw)
      if (model !== 'codex') {
        collectText(decoded + (raw.length > 512_000 ? '\n[truncated chunk]' : ''))
        return
      }
      codexStderrBuffer += decoded
      const lines = codexStderrBuffer.split(/\r?\n/)
      codexStderrBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const diagnostic = cleanCodexStderrLine(line)
        if (diagnostic) collectText(`${diagnostic}\n`)
      }
    }

    child.stdout?.on('data', collectStdout)
    // Errors (bad flags, not logged in, missing binary) stream on stderr —
    // surfaced in the bubble rather than dying in a console the user never
    // opens.
    child.stderr?.on('data', collectStderr)
    child.on('error', (err) => {
      // ENOENT and friends arrive here: the CLI is simply not installed.
      const stdoutTail = stdoutDecoder.end()
      const stderrTail = stderrDecoder.end()
      if (model === 'codex') codexJsonBuffer += stdoutTail
      else if (stdoutTail) run.pending.push(stdoutTail)
      if (model === 'codex') {
        const diagnostic = cleanCodexStderrLine(codexStderrBuffer + stderrTail)
        if (diagnostic) run.pending.push(diagnostic)
      } else if (stderrTail) run.pending.push(stderrTail)
      run.pending.push(`\n\n[${spec.command} failed to start: ${err.message}]`)
      this.finish(threadId, run, { code: 1 })
    })
    child.on('close', (code) => {
      const stdoutTail = stdoutDecoder.end()
      const stderrTail = stderrDecoder.end()
      if (model === 'codex') {
        codexJsonBuffer += stdoutTail
        const message = extractCodexJsonLine(codexJsonBuffer)
        if (message) run.pending.push(`${codexMessageCount > 0 ? '\n\n' : ''}${message}`)
      } else if (stdoutTail) {
        const cleaned = stripAnsi(stdoutTail).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        if (cleaned) run.pending.push(cleaned)
      }
      if (model === 'codex') {
        const diagnostic = cleanCodexStderrLine(codexStderrBuffer + stderrTail)
        if (diagnostic) run.pending.push(diagnostic)
      } else if (stderrTail) {
        run.pending.push(stripAnsi(stderrTail).replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
      }
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
    // child.kill() is the cross-platform stop: killProcessTree is a Windows
    // no-op on mac/Linux, where the old branch leaked the CLI process.
    // On Windows the tree sweep still runs for detached grandchildren.
    try {
      run.child.kill()
    } catch {
      /* already gone */
    }
    try {
      if (typeof run.child.pid === 'number') killProcessTree(run.child.pid)
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

/** Convert one Codex `exec --json` event into user-facing chat text. */
export function extractCodexJsonLine(line: string): string {
  if (!line.trim()) return ''
  try {
    const event = JSON.parse(line) as {
      type?: string
      message?: string
      error?: { message?: string }
      item?: { type?: string; text?: string }
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      return event.item.text
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      const message = event.error?.message || event.message
      return message ? `\n\n[Codex error: ${message}]` : ''
    }
    return ''
  } catch {
    // JSON mode should only emit JSON on stdout. Ignore malformed diagnostic
    // fragments instead of putting the CLI protocol back into the UI.
    return ''
  }
}

/** Remove known Codex infrastructure chatter while preserving real failures. */
export function cleanCodexStderrLine(line: string): string {
  const cleaned = stripAnsi(line).trim()
  if (cleaned === 'Reading additional input from stdin...') return ''
  if (/^\d{4}-\d{2}-\d{2}T\S+\s+WARN\s+codexskills::interface:\s+ignoring interface\.icon(?:small|large):/i.test(cleaned)) return ''
  if (/^\d{4}-\d{2}-\d{2}T\S+\s+WARN\s+codexcore::shellsnapshot:\s+Failed to create shell snapshot for powershell:/i.test(cleaned)) return ''
  if (/^\d{4}-\d{2}-\d{2}T\S+\s+WARN\s+codex_core::tasks:\s+failed to flush rollout after emitting terminal turn event:/i.test(cleaned)) return ''
  return cleaned
}

/** The one runner behind the chat IPC surface. */
export const chatRunner = new ChatRunner()
