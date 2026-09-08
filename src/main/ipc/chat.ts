import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { exec } from 'child_process'
import { chatRunner, type ChatModelId, type ChatEffort } from '../chatRunner.ts'
import { isLocalPath } from '../media.ts'
import { ipcMain } from './shims.ts'
import type { IpcDeps } from './types.ts'

const CHAT_MODELS = new Set<ChatModelId>([
  'codex',
  'claude',
  'grok',
  'antigravity',
  'opencode',
  'gemini',
  'cursor',
  'aider',
  'custom'
])
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/

type CatalogOption = { id: string; label: string; efforts?: ChatEffort[] }
type ChatModelCatalog = Partial<Record<ChatModelId, { models: CatalogOption[]; defaultModel?: string; defaultEffort?: ChatEffort }>>
const CODEX_EFFORTS: ChatEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const CLAUDE_EFFORTS: ChatEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const GROK_EFFORTS: ChatEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const VALID_EFFORTS = new Set<ChatEffort>(['minimal', ...CODEX_EFFORTS])
const MODEL_DISCOVERY_TIMEOUT_MS = 12_000

function readJson(file: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'), (k: string, v: unknown) =>
      k === '__proto__' || k === 'prototype' || k === 'constructor' ? undefined : v
    ) as Record<string, any>
  } catch {
    return null
  }
}

function readJsonc(file: string): Record<string, any> | null {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    let inStr: '"' | "'" | '`' | false = false, esc = false, out = ''
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i], nxt = raw[i + 1]
      if (inStr) {
        out += ch
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === inStr) inStr = false
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch as '"' | "'" | '`'; out += ch; continue }
      if (ch === '/' && nxt === '*') { i += 2; while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++; i++; continue }
      if (ch === '/' && nxt === '/') { while (i < raw.length && raw[i] !== '\n') i++; out += '\n'; continue }
      out += ch
    }
    // Strip trailing commas - safe now that we're outside strings
    let cleaned = ''
    let inCleanStr: '"' | "'" | '`' | false = false, cleanEsc = false
    for (let i = 0; i < out.length; i++) {
      const ch = out[i]
      if (inCleanStr) {
        cleaned += ch
        if (cleanEsc) cleanEsc = false
        else if (ch === '\\') cleanEsc = true
        else if (ch === inCleanStr) inCleanStr = false
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') { inCleanStr = ch as '"' | "'" | '`'; cleaned += ch; continue }
      if ((ch === ',' && /^\s*[}\]]/.test(out.slice(i + 1)))) continue
      cleaned += ch
    }
    return JSON.parse(cleaned) as Record<string, any>
  } catch {
    return null
  }
}

function uniqueOptions(values: Array<{ id?: unknown; label?: unknown; efforts?: ChatEffort[] }>): CatalogOption[] {
  const seen = new Set<string>()
  return values.flatMap((value) => {
    if (typeof value.id !== 'string' || !value.id.trim()) return []
    const norm = value.id.toLowerCase()
    if (seen.has(norm)) return []
    seen.add(norm)
    return [{ id: value.id, label: typeof value.label === 'string' && value.label.trim() ? value.label : value.id, efforts: value.efforts }]
  })
}

export function parseAgyModels(output: string): CatalogOption[] {
  return uniqueOptions(output.split(/\r?\n/).flatMap((line) => {
    const match = /^([^\s]+)\s+(.+)$/.exec(line.trim())
    if (!match || !/^(gemini|claude|gpt)-/i.test(match[1])) return []
    return [{ id: match[1], label: match[2].trim(), efforts: ['low', 'medium', 'high'] as ChatEffort[] }]
  }))
}

export function parseGrokModels(output: string): CatalogOption[] {
  return uniqueOptions(output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*\*\s+([^\s]+)(?:\s+\(default\))?\s*$/.exec(line)
    return match ? [{ id: match[1], label: match[1], efforts: GROK_EFFORTS }] : []
  }))
}

export function parseOpenCodeZenModels(output: string): CatalogOption[] {
  return uniqueOptions(output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((id) => /^opencode\/[A-Za-z0-9._-]+$/.test(id))
    .map((id) => ({ id, label: id.slice('opencode/'.length), efforts: ['minimal', 'low', 'medium', 'high', 'max'] as ChatEffort[] })))
}

function runModelCommand(command: string): Promise<string> {
  return new Promise((resolve) => {
    exec(command, {
      windowsHide: true,
      timeout: MODEL_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' }
    }, (error, stdout) => resolve(error && !stdout ? '' : stdout))
  })
}

function readCodexDefaults(home: string): { model?: string; effort?: ChatEffort } {
  try {
    const source = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
    const model = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(source)?.[1]
    const rawEffort = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(source)?.[1]
    return { model, effort: VALID_EFFORTS.has(rawEffort as ChatEffort) ? rawEffort as ChatEffort : undefined }
  } catch {
    return {}
  }
}

async function discoverChatModels(): Promise<ChatModelCatalog> {
  const home = os.homedir()
  const result: ChatModelCatalog = {}

  const [agyRes, grokRes, opencodeRes] = await Promise.allSettled([
    runModelCommand('agy models'),
    runModelCommand('grok models'),
    runModelCommand('opencode models opencode')
  ])
  const agyOutput = agyRes.status === 'fulfilled' ? agyRes.value : ''
  const grokOutput = grokRes.status === 'fulfilled' ? grokRes.value : ''
  const opencodeOutput = opencodeRes.status === 'fulfilled' ? opencodeRes.value : ''

  const claude = readJson(path.join(home, '.claude', 'settings.json'))
  if (claude) {
    const env = claude.env && typeof claude.env === 'object' ? claude.env as Record<string, unknown> : {}
    const configured = [claude.model, env.ANTHROPIC_MODEL, ...Object.keys(claude.modelSettings || {})]
    const models = uniqueOptions(configured.map((id) => ({ id, efforts: CLAUDE_EFFORTS })))
    const configuredEffort = typeof claude.effortLevel === 'string' ? claude.effortLevel : typeof claude.modelSettings?.[claude.model]?.effortLevel === 'string' ? claude.modelSettings[claude.model].effortLevel : undefined
    if (models.length) {
      result.claude = {
        models,
        defaultModel: typeof claude.model === 'string' && models.some((entry) => entry.id === claude.model) ? claude.model : models[0].id,
        defaultEffort: VALID_EFFORTS.has(configuredEffort as ChatEffort) ? configuredEffort as ChatEffort : undefined
      }
    }
  }

  const agy = readJson(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'))
  const agyModels = parseAgyModels(agyOutput)
  if (agyModels.length) {
    const configured = typeof agy?.model === 'string' ? agy.model : undefined
    const selected = agyModels.find((entry) => entry.id === configured || entry.label === configured) ?? agyModels[0]
    const effortFromModel = /(?:-|\()(low|medium|high)(?:\)|$)/i.exec(selected.id)?.[1]?.toLowerCase() as ChatEffort | undefined
    result.antigravity = { models: agyModels, defaultModel: selected.id, defaultEffort: effortFromModel || 'medium' }
  } else if (agy && typeof agy.model === 'string') {
    result.antigravity = { models: [{ id: agy.model, label: agy.model, efforts: ['low', 'medium', 'high'] }], defaultModel: agy.model, defaultEffort: 'medium' }
  }

  const grok = readJson(path.join(home, '.grok', 'models_cache.json'))
  if (grok?.models && typeof grok.models === 'object') {
    const models = uniqueOptions(Object.values(grok.models).flatMap((entry: any) => {
      const info = entry?.info
      if (!info || info.hidden || info.supported_in_api === false) return []
      const efforts = Array.isArray(info.reasoning_efforts) ? info.reasoning_efforts.map((item: any) => item?.value).filter((value: any): value is ChatEffort => VALID_EFFORTS.has(value)) : undefined
      return [{ id: info.id || info.model, label: info.name || info.id || info.model, efforts }]
    }))
    if (models.length) result.grok = { models, defaultModel: models[0].id, defaultEffort: models[0].efforts?.[0] }
  }
  const grokCliModels = parseGrokModels(grokOutput)
  if (grokCliModels.length) {
    const defaultFromOutput = /^Default model:\s*(\S+)/mi.exec(grokOutput)?.[1]
    result.grok = { models: grokCliModels, defaultModel: defaultFromOutput || grokCliModels[0].id, defaultEffort: 'medium' }
  }

  // OpenCode may have many custom providers in its config. Chat intentionally
  // exposes only OpenCode's curated Zen provider, never those custom entries.
  const cliZenModels = parseOpenCodeZenModels(opencodeOutput)
  const opencode = readJson(path.join(home, '.config', 'opencode', 'opencode.json')) || readJsonc(path.join(home, '.config', 'opencode', 'opencode.jsonc'))
  const configuredZen: Array<{ id?: unknown; label?: unknown }> = []
  for (const [providerId, provider] of Object.entries((opencode?.providers || opencode?.provider || {}) as Record<string, any>)) {
    if (!/^(opencode|zen)$/i.test(providerId) && !/opencode\s*zen/i.test(String(provider?.name || ''))) continue
    const models = provider?.models
    if (Array.isArray(models)) configuredZen.push(...models.map((model: any) => ({ id: String(model?.id || '').startsWith('opencode/') ? model?.id : `opencode/${model?.id}`, label: model?.name || model?.id })))
    else if (models && typeof models === 'object') configuredZen.push(...Object.entries(models).map(([id, model]: [string, any]) => ({ id: id.startsWith('opencode/') ? id : `opencode/${id}`, label: model?.name || id })))
  }
  const opencodeModels = uniqueOptions(cliZenModels.length ? cliZenModels : configuredZen)
  if (opencodeModels.length) result.opencode = { models: opencodeModels, defaultModel: opencodeModels[0].id, defaultEffort: 'medium' }

  const codex = readJson(path.join(home, '.codex', 'models_cache.json'))
  if (codex?.models && Array.isArray(codex.models)) {
    const models = uniqueOptions(codex.models.filter((entry: any) => entry?.visibility !== 'hidden' && entry?.supported_in_api !== false).map((entry: any) => ({
      id: entry.slug, label: entry.display_name || entry.slug, efforts: Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels.map((item: any) => item?.effort).filter((value: any): value is ChatEffort => VALID_EFFORTS.has(value)) : CODEX_EFFORTS
    })))
    if (models.length) {
      const configured = readCodexDefaults(home)
      const selected = codex.models.find((entry: any) => entry?.slug === configured.model) || codex.models.find((entry: any) => entry?.slug === models[0].id)
      result.codex = {
        models,
        defaultModel: models.some((entry) => entry.id === configured.model) ? configured.model : models[0].id,
        defaultEffort: configured.effort || selected?.default_reasoning_level
      }
    }
  }
  return result
}

/**
 * The chat pane's transport. One headless CLI process per thread (see
 * ChatRunner), streams cleaned answer text to the renderer through
 * `chat:onData` and settles the bubble on `chat:onExit`.
 */
export function registerChatIpc(deps: IpcDeps): void {
  const push = (channel: string, threadId: string, payload: unknown): void => {
    const win = deps.getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, threadId, payload)
  }

  chatRunner.on('data', (threadId: string, chunk: string) => {
    push('chat:onData', threadId, chunk)
  })
  chatRunner.on('exit', (threadId: string, payload: unknown) => {
    push('chat:onExit', threadId, payload)
  })

  ipcMain.handle(
    'chat:send',
    (_e, threadId: unknown, model: unknown, prompt: unknown, options: unknown): { ok: true } | { error: string } => {
      if (typeof threadId !== 'string' || !THREAD_ID.test(threadId)) {
        return { error: 'invalid thread id' }
      }
      if (typeof model !== 'string' || !CHAT_MODELS.has(model as ChatModelId)) {
        return { error: 'unknown model' }
      }
      if (typeof prompt !== 'string') return { error: 'invalid prompt' }
      const cwd = deps.getWorkspaceDir() || os.homedir()
      const safeOptions = options && typeof options === 'object'
        ? options as { model?: unknown; effort?: unknown; images?: unknown; command?: unknown }
        : undefined
      const effort = safeOptions?.effort
      const modelName = safeOptions?.model
      const images = Array.isArray(safeOptions?.images)
        ? safeOptions.images
            .filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && isLocalPath(value))
            .slice(0, 4)
        : undefined
      return chatRunner.send(threadId, model as ChatModelId, prompt, cwd, {
        model: typeof modelName === 'string' && MODEL_NAME.test(modelName) ? modelName : undefined,
        effort: VALID_EFFORTS.has(effort as ChatEffort) ? effort as ChatEffort : undefined,
        images,
        command: typeof safeOptions?.command === 'string' ? safeOptions.command.slice(0, 512) : undefined
      })
    }
  )

  ipcMain.handle('chat:models', (): Promise<ChatModelCatalog> => discoverChatModels())

  ipcMain.handle('chat:stop', (_e, threadId: unknown): { ok: boolean } => {
    if (typeof threadId !== 'string') return { ok: false }
    return { ok: chatRunner.stop(threadId) }
  })

  ipcMain.handle('chat:dispose', (_e, threadId: unknown): { ok: boolean } => {
    if (typeof threadId !== 'string') return { ok: false }
    chatRunner.dispose(threadId)
    return { ok: true }
  })
}
