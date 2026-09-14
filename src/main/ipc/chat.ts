import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain, shell } from './shims.ts'
import { extractChatAuthDetails } from './chatAuth.ts'
import type { IpcDeps } from './types.ts'
import { killProcessTree } from '../procTree.ts'

type Provider = 'chatgpt' | 'claude' | 'grok'
type Effort = 'low' | 'medium' | 'high'

interface ProviderInfo {
  id: Provider
  label: string
  command: string
  versionArgs: string[]
  statusArgs: string[]
  loginArgs: string[]
  authHosts: string[]
  installCommand: string
}

interface ResolvedCommand {
  file: string
  prefixArgs: string[]
}

const PROVIDERS: ProviderInfo[] = [
  { id: 'chatgpt', label: 'ChatGPT', command: 'codex', versionArgs: ['--version'], statusArgs: ['login', 'status'], loginArgs: ['login', '--device-auth'], authHosts: ['openai.com', 'chatgpt.com'], installCommand: 'npm install -g @openai/codex' },
  { id: 'claude', label: 'Claude', command: 'claude', versionArgs: ['--version'], statusArgs: ['auth', 'status'], loginArgs: ['auth', 'login', '--claudeai'], authHosts: ['claude.ai', 'claude.com', 'anthropic.com'], installCommand: 'npm install -g @anthropic-ai/claude-code' },
  { id: 'grok', label: 'Grok', command: 'grok', versionArgs: ['version'], statusArgs: ['models'], loginArgs: ['login', '--device-auth'], authHosts: ['x.ai', 'grok.com'], installCommand: 'npm install -g @xai-official/grok' }
]

const MODEL_RE = /^[A-Za-z0-9._:/-]{1,120}$/
const MAX_MESSAGE = 12_000
const MAX_HISTORY = 40
const MAX_PROVIDER_OUTPUT = 4 * 1024 * 1024
const active = new Map<string, ChildProcess>()
const authActive = new Map<Provider, { child: ChildProcess; timeout: NodeJS.Timeout }>()

function killChild(child: ChildProcess | undefined): void {
  if (!child) return
  try {
    if (child.pid) killProcessTree(child.pid)
  } catch {}
  try {
    child.kill()
  } catch {}
}

function appendProviderOutput(current: string, chunk: Buffer | string): string {
  const incoming = String(chunk)
  if (!incoming) return current
  const combined = current + incoming
  return combined.length <= MAX_PROVIDER_OUTPUT ? combined : combined.slice(-MAX_PROVIDER_OUTPUT)
}

process.once('exit', () => {
  for (const child of active.values()) killChild(child)
  for (const auth of authActive.values()) killChild(auth.child)
  active.clear()
  authActive.clear()
})

function providerOf(id: unknown): typeof PROVIDERS[number] | undefined {
  return PROVIDERS.find((provider) => provider.id === id)
}

function windowsCommandCandidates(command: string): string[] {
  const candidates: string[] = []
  const add = (path: string | undefined): void => {
    if (path && !candidates.includes(path)) candidates.push(path)
  }
  const appData = process.env.APPDATA
  const localAppData = process.env.LOCALAPPDATA
  const userProfile = process.env.USERPROFILE

  // GUI-launched Electron processes often inherit a stale PATH. These are the
  // default per-user install locations used by npm and the official Codex CLI.
  if (localAppData && command === 'codex') {
    const binRoot = join(localAppData, 'OpenAI', 'Codex', 'bin')
    try {
      for (const entry of readdirSync(binRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) add(join(binRoot, entry.name, 'codex.exe'))
      }
    } catch {
      // The standalone Codex installer may not be present.
    }
  }
  if (appData) {
    add(join(appData, 'npm', `${command}.ps1`))
    add(join(appData, 'npm', `${command}.cmd`))
    add(join(appData, 'npm', `${command}.exe`))
  }
  if (userProfile) add(join(userProfile, '.local', 'bin', `${command}.exe`))
  return candidates
}

function windowsPowerShell(): string {
  const windir = process.env.WINDIR || 'C:\\Windows'
  const installed = join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(installed) ? installed : 'powershell.exe'
}

function resolveWindowsCommand(paths: string[], command: string): ResolvedCommand | undefined {
  for (const path of [...paths, ...windowsCommandCandidates(command)]) {
    const extension = extname(path).toLowerCase()
    if ((extension === '.exe' || extension === '.com') && existsSync(path)) return { file: path, prefixArgs: [] }
    const script = extension ? path.replace(/\.(?:cmd|bat)$/i, '.ps1') : `${path}.ps1`
    if (existsSync(script)) return { file: windowsPowerShell(), prefixArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] }
    if (existsSync(path) && (extension === '.cmd' || extension === '.bat')) {
      return { file: process.env.COMSPEC || 'cmd.exe', prefixArgs: ['/d', '/s', '/c', path] }
    }
  }
  return undefined
}

function resolveCommand(command: string): Promise<ResolvedCommand | undefined> {
  if (process.platform !== 'win32') return Promise.resolve({ file: command, prefixArgs: [] })
  return new Promise((resolve) => {
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const child = spawn('where.exe', [command], { shell: false, windowsHide: true })
    let stdout = ''
    const finish = (paths: string[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(resolveWindowsCommand(paths, command))
    }
    timeout = setTimeout(() => {
      try { child.kill() } catch {}
      finish([])
    }, 5000)
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
    child.once('error', () => finish([]))
    child.once('close', (code) => {
      const paths = code === 0 ? stdout.split(/\r?\n/).map((path) => path.trim()).filter(Boolean) : []
      finish(paths)
    })
  })
}

function spawnResolved(command: ResolvedCommand, args: string[], options: { cwd?: string; stdin?: 'pipe' | 'ignore' } = {}): ChildProcess {
  return spawn(command.file, [...command.prefixArgs, ...args], {
    shell: false,
    windowsHide: true,
    cwd: options.cwd,
    stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe']
  })
}

async function run(command: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const resolved = await resolveCommand(command)
  if (!resolved) return { code: -1, stdout: '', stderr: `${command} CLI was not found` }
  return new Promise((resolve) => {
    const child = spawnResolved(resolved, args, { stdin: input === undefined ? 'ignore' : 'pipe' })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timeout: NodeJS.Timeout
    const finish = (result: { code: number; stdout: string; stderr: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    timeout = setTimeout(() => {
      killChild(child)
      finish({ code: -1, stdout, stderr: `${stderr}\nTimed out`.trim() })
    }, 10_000)
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout = appendProviderOutput(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr = appendProviderOutput(stderr, chunk) })
    child.on('error', (error) => finish({ code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim() }))
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }))
    if (input !== undefined) {
      child.stdin?.write(input)
      child.stdin?.end()
    }
  })
}

function isConnected(provider: ProviderInfo, code: number, stdout: string, stderr: string): boolean {
  if (code !== 0) return false
  if (provider.id === 'grok') return true
  const statusText = `${stdout}\n${stderr}`
  if (/not logged in|not authenticated|disconnected/i.test(statusText)) return false
  if (provider.id === 'claude') {
    try {
      const parsed = JSON.parse(stdout) as { loggedIn?: unknown }
      if (typeof parsed.loggedIn === 'boolean') return parsed.loggedIn
    } catch {}
  }
  return /logged in|authenticated|connected|active/i.test(statusText)
}

async function providerStatus(provider: ProviderInfo): Promise<{ id: Provider; label: string; available: boolean; connected: boolean; connecting: boolean; detail: string; installCommand?: string }> {
  const status = await run(provider.command, provider.statusArgs)
  const statusText = `${status.stdout}\n${status.stderr}`
  const unavailable = status.code === -1 || /not recognized|not found|no such file|cannot find/i.test(statusText)
  const connected = isConnected(provider, status.code, status.stdout, status.stderr)
  const connecting = authActive.has(provider.id)
  return {
    id: provider.id,
    label: provider.label,
    available: !unavailable,
    connected,
    connecting,
    detail: connected ? 'Connected via OAuth' : connecting ? 'Waiting for OAuth sign-in' : unavailable ? 'CLI not found' : 'Not connected',
    installCommand: unavailable ? provider.installCommand : undefined
  }
}

function authEvent(event: IpcMainInvokeEvent, provider: Provider, type: 'started' | 'instructions' | 'complete' | 'error', extra: Record<string, unknown> = {}): void {
  try { event.sender.send('chat:auth-event', { provider, type, ...extra }) } catch {}
}

function authErrorText(provider: ProviderInfo, output: string): string {
  const last = stripVTControlCharacters(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-2).join(' ').slice(0, 320)
  return last || `${provider.label} sign-in did not complete.`
}

export function parseOutput(raw: string): string {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const itemMap = new Map<string, string>()
  const responses: string[] = []
  const deltas: string[] = []
  let explicitResult: string | undefined

  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown
      const walk = (entry: unknown): void => {
        if (!entry || typeof entry !== 'object') return
        const object = entry as Record<string, unknown>
        const item = object.item
        if (item && typeof item === 'object') {
          const typed = item as Record<string, unknown>
          const id = typeof typed.id === 'string' ? typed.id : 'default'
          if (typed.type === 'agent_message' && typeof typed.text === 'string') {
            itemMap.set(id, typed.text)
          }
        }
        if (object.type === 'agent_message' && typeof object.text === 'string') {
          const id = typeof object.id === 'string' ? object.id : 'default'
          itemMap.set(id, object.text)
        }
        if (typeof object.delta === 'string' && (object.type === 'response.output_text.delta' || object.type === 'content_block_delta')) {
          deltas.push(object.delta)
        }
        if (typeof object.result === 'string') {
          explicitResult = object.result
        }
        if (typeof object.output_text === 'string') {
          responses.push(object.output_text)
        }
      }
      walk(value)
    } catch {
      // Some provider CLIs print a plain-text answer even with JSON enabled.
    }
  }

  if (explicitResult !== undefined && explicitResult.trim()) {
    return explicitResult.trim()
  }
  if (itemMap.size > 0) {
    const combined = Array.from(itemMap.values()).filter(Boolean).join('\n\n').trim()
    if (combined) return combined
  }
  if (deltas.length > 0) {
    return deltas.join('').trim()
  }
  if (responses.length > 0) {
    return responses.join('').trim()
  }
  return raw.trim()
}

export function parseError(stderr: string, stdout: string, providerLabel: string, code: number): string {
  const err = stderr.trim()
  const out = parseOutput(stdout)
  if (err && (!out || err.includes('Error:') || err.includes('error:'))) {
    return err
  }
  if (out && out !== stdout.trim()) {
    return out
  }
  if (err) {
    return err
  }
  return `${providerLabel} returned exit code ${code}. Connect the account in Settings and try again.`
}

function historyPrompt(history: unknown[], message: string): string {
  const transcript = history
    .slice(-MAX_HISTORY)
    .filter((entry): entry is { role: string; content: string } => Boolean(entry) && typeof entry === 'object' && typeof (entry as { role?: unknown }).role === 'string' && typeof (entry as { content?: unknown }).content === 'string')
    .map((entry) => `${entry.role === 'assistant' ? 'Assistant' : 'User'}: ${entry.content.slice(0, MAX_MESSAGE)}`)
    .join('\n\n')
  return [
    'You are the assistant inside the OrcSpace AI Chat widget.',
    'Answer the user directly and concisely. Do not modify files or run commands unless the user explicitly asks.',
    transcript ? `Conversation so far:\n${transcript}` : '',
    `User: ${message}`
  ].filter(Boolean).join('\n\n')
}

function commandArgs(provider: Provider, model: string, effort: Effort, prompt: string): string[] {
  if (provider === 'chatgpt') return ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', model, '-c', `model_reasoning_effort="${effort}"`, '-']
  if (provider === 'claude') return ['-p', '--output-format', 'json', '--model', model, '--effort', effort, '--permission-mode', 'plan']
  return ['--no-auto-update', '-p', prompt.slice(-8_000), '--output-format', 'json', '-m', model, '--effort', effort]
}

function sendEvent(event: IpcMainInvokeEvent, payload: Record<string, unknown>): void {
  try { event.sender.send('chat:event', payload) } catch {}
}

export function registerChatIpc(deps: IpcDeps): void {
  ipcMain.handle('chat:providers', async () => {
    return Promise.all(PROVIDERS.map(providerStatus))
  })

  ipcMain.handle('chat:connect', async (event, id: Provider) => {
    const provider = providerOf(id)
    if (!provider) return { ok: false, error: 'Unknown provider' }
    if (authActive.has(provider.id)) return { ok: true }
    try {
      const available = await run(provider.command, provider.versionArgs)
      if (available.code !== 0) return { ok: false, error: `${provider.label} CLI is not installed. Run: ${provider.installCommand}` }
      const resolved = await resolveCommand(provider.command)
      if (!resolved) return { ok: false, error: `${provider.label} CLI is not installed. Run: ${provider.installCommand}` }
      const child = spawnResolved(resolved, provider.loginArgs)
      let output = ''
      let openedUrl: string | undefined
      let announcedCode: string | undefined
      let announcedInput = false
      const timeout = setTimeout(() => killChild(child), 15 * 60_000)
      authActive.set(provider.id, { child, timeout })
      authEvent(event, provider.id, 'started', { message: `Starting ${provider.label} sign-in…` })
      const onOutput = (chunk: Buffer | string): void => {
        output = `${output}${String(chunk)}`.slice(-32_000)
        const details = extractChatAuthDetails(output, provider.authHosts)
        const urlChanged = Boolean(details.url && details.url !== openedUrl)
        const codeChanged = Boolean(details.userCode && details.userCode !== announcedCode)
        const inputChanged = details.requiresInput !== announcedInput
        if (details.url && urlChanged && provider.id !== 'claude') {
          openedUrl = details.url
          void shell.openExternal(details.url).catch(() => {})
        } else if (details.url && urlChanged) {
          openedUrl = details.url
        }
        if (urlChanged || codeChanged || inputChanged) {
          announcedCode = details.userCode
          announcedInput = details.requiresInput
          authEvent(event, provider.id, 'instructions', {
            message: details.requiresInput
              ? 'Complete sign-in in your browser, then paste the returned code here.'
              : details.userCode ? 'Enter this code on the provider sign-in page.' : 'Complete sign-in in your browser.',
            url: details.url,
            userCode: details.userCode,
            requiresInput: details.requiresInput
          })
        }
      }
      child.stdout?.on('data', onOutput)
      child.stderr?.on('data', onOutput)
      child.once('error', (error) => {
        const current = authActive.get(provider.id)
        if (current?.child !== child) return
        clearTimeout(current.timeout)
        authActive.delete(provider.id)
        authEvent(event, provider.id, 'error', { message: error.message })
      })
      child.once('close', () => {
        const current = authActive.get(provider.id)
        if (current?.child !== child) return
        clearTimeout(current.timeout)
        authActive.delete(provider.id)
        void providerStatus(provider).then((status) => {
          authEvent(event, provider.id, status.connected ? 'complete' : 'error', {
            message: status.connected ? `${provider.label} connected.` : authErrorText(provider, output)
          })
        })
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('chat:auth-submit', (_event, id: Provider, code: string) => {
    const auth = authActive.get(id)
    if (!auth) return { ok: false, error: 'No sign-in is waiting for a code.' }
    const clean = typeof code === 'string' ? code.trim().replace(/[\r\n]/g, '').slice(0, 4096) : ''
    if (!clean) return { ok: false, error: 'Paste the OAuth code first.' }
    if (!auth.child.stdin?.writable) return { ok: false, error: 'This sign-in no longer accepts input.' }
    auth.child.stdin.write(`${clean}\n`)
    return { ok: true }
  })

  ipcMain.handle('chat:send', async (event, request: { widgetId?: unknown; provider?: unknown; model?: unknown; reasoningEffort?: unknown; message?: unknown; history?: unknown[]; workspaceDir?: unknown }) => {
    const widgetId = typeof request?.widgetId === 'string' ? request.widgetId.slice(0, 128) : ''
    const provider = providerOf(request?.provider)?.id
    const model = typeof request?.model === 'string' && MODEL_RE.test(request.model) ? request.model : ''
    const effort = request?.reasoningEffort === 'low' || request?.reasoningEffort === 'high' || request?.reasoningEffort === 'medium' ? request.reasoningEffort : 'medium'
    const message = typeof request?.message === 'string' ? request.message.trim().slice(0, MAX_MESSAGE) : ''
    if (!widgetId || !provider || !model || !message) return { ok: false, error: 'Chat request is incomplete.' }
    const previous = active.get(widgetId)
    killChild(previous)
    const requestId = randomUUID()
    const input = historyPrompt(Array.isArray(request.history) ? request.history : [], message)
    const providerInfo = providerOf(provider)
    if (!providerInfo) return { ok: false, error: 'Unknown provider' }
    const resolved = await resolveCommand(providerInfo.command)
    if (!resolved) return { ok: false, error: `${providerInfo.label} CLI is not installed. Run: ${providerInfo.installCommand}` }
    const workspaceDir = typeof request?.workspaceDir === 'string' && request.workspaceDir.length < 1024 ? request.workspaceDir : undefined
    // Renderer input: require an absolute existing directory, not just any
    // existing path, so a file or a crafted relative path cannot become cwd.
    let requestedDir: string | undefined
    if (workspaceDir && isAbsolute(workspaceDir)) {
      try {
        if (statSync(workspaceDir).isDirectory()) requestedDir = workspaceDir
      } catch {
        requestedDir = undefined
      }
    }
    const workingRoot = requestedDir ?? (deps.getWorkspaceDir() || process.cwd())
    let child: ChildProcess
    try {
      child = spawnResolved(resolved, commandArgs(provider, model, effort, input), { cwd: workingRoot })
    } catch (spawnError) {
      return { ok: false, error: spawnError instanceof Error ? spawnError.message : 'Failed to launch provider CLI.' }
    }
    active.set(widgetId, child)
    sendEvent(event, { widgetId, requestId, type: 'status', text: 'Thinking…', provider })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      if (active.get(widgetId) !== child) return
      killChild(child)
      active.delete(widgetId)
      sendEvent(event, { widgetId, requestId, type: 'error', text: `${providerInfo.label} request timed out.`, provider })
    }, 300_000)
    timeout.unref?.()
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(timeout)
      if (active.get(widgetId) !== child) return
      active.delete(widgetId)
      sendEvent(event, { widgetId, requestId, type: 'error', text: `${providerInfo.label} CLI is unavailable: ${error.message}`, provider })
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (active.get(widgetId) !== child) return
      active.delete(widgetId)
      if (code !== 0) {
        sendEvent(event, { widgetId, requestId, type: 'error', text: parseError(stderr, stdout, providerInfo.label, code ?? -1), provider })
        return
      }
      const answer = parseOutput(stdout)
      sendEvent(event, { widgetId, requestId, type: answer ? 'complete' : 'error', text: answer || 'The model returned an empty response.', provider })
    })
    if (provider !== 'grok') child.stdin?.write(input)
    child.stdin?.end()
    return { ok: true, requestId }
  })

  ipcMain.handle('chat:cancel', (_event, widgetId: string) => {
    const child = active.get(widgetId)
    if (child) {
      killChild(child)
      active.delete(widgetId)
    }
    return { ok: true }
  })
}
