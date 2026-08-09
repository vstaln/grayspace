import { ipcMain, app, dialog, shell, BrowserWindow } from 'electron'
import { delimiter, extname, join } from 'path'
import * as fs from 'fs'
import { spawn, ChildProcess } from 'child_process'
import { BACKGROUND_DIR_NAME, MCP_PORT, MAX_CHAT_PROMPT_CHARS } from './config'
import * as media from './media'
import { streamOpenRouter } from './openrouter'
import { fetchOpenRouterModels } from './openrouterModels'
import { CoordinationStore, Forbidden, USER_AUTHOR } from './coordination'
import { TerminalManager } from './terminals'
import { killProcessTree } from './procTree'
import { BrainStore } from './brain'
import { CanvasState } from './canvasState'
import type { AppState, SettingsPatch } from './appState'

interface IpcDeps {
  terminals: TerminalManager
  coordination: CoordinationStore
  brain: BrainStore
  canvas: CanvasState
  state: AppState
  getWindow(): BrowserWindow | null
  getWorkspaceDir(): string | undefined
  setWorkspaceDir(dir: string | undefined): void
}

/** Id of the terminal widget currently holding keyboard focus, if any. */
let terminalFocusedId: string | null = null

/** Read by `before-input-event` in the main window so terminal keys win over menu accelerators. */
export function focusedTerminalId(): string | null {
  return terminalFocusedId
}

/** Wraps store calls so a Forbidden surfaces to the renderer as `{ error }`. */
function guard<T>(fn: () => T): T | { error: string } {
  try {
    return fn()
  } catch (err) {
    if (err instanceof Forbidden) return { error: err.message }
    throw err
  }
}

/**
 * Adds up every numeric field on a token-usage object — Claude Code's
 * `usage` (input/output/cache_creation/cache_read) and Codex's
 * `total_token_usage` (input/output/reasoning/...) both count the whole
 * context this way, they just don't agree on field names.
 */
function sumTokenFields(usage: Record<string, number>): number | null {
  const total = Object.values(usage).reduce((sum, v) => (Number.isFinite(v) ? sum + v : sum), 0)
  return total > 0 ? total : null
}

export function registerIpc(deps: IpcDeps): void {
  const { terminals, coordination, brain, state, canvas } = deps
  /** The human's identity on the board, used for role checks and assignment. */
  const actor = (): { role: 'member' | 'lead'; name: string } => ({
    role: state.settings.role,
    name: state.settings.userName
  })
  // One cancel function per in-flight chat turn, whichever kind of backend is
  // running it — a killed child process for the CLI providers, an aborted
  // fetch for OpenRouter — so `chat:cancel` doesn't need to know which.
  const chatCancel = new Map<string, () => void>()

  // ---- window (custom title bar; the OS frame is off on every platform) --
  ipcMain.on('window:minimize', () => deps.getWindow()?.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    const window = deps.getWindow()
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.on('window:close', () => deps.getWindow()?.close())
  ipcMain.handle('window:is-maximized', () => deps.getWindow()?.isMaximized() ?? false)

  // ---- chat: local CLI agents + OpenRouter's free-tier models -----------
  type ChatProvider = 'claude' | 'codex' | 'opencode' | 'openrouter'
  const PROVIDER_LABEL: Record<ChatProvider, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    opencode: 'OpenCode',
    openrouter: 'OpenRouter'
  }
  /** A CLI agent that produced nothing for this long is considered hung. */
  const CLI_IDLE_TIMEOUT_MS = 3 * 60_000
  /** OpenRouter has to stream a first token at least this fast. */
  const OPENROUTER_TIMEOUT_MS = 2 * 60_000

  const sendChatEvent = (id: string, type: 'delta' | 'done' | 'error', payload: Record<string, string> = {}): void =>
    deps.getWindow()?.webContents.send('chat:event', { id, type, ...payload })

  /**
   * Resolves the provider's real launcher on Windows. npm-installed CLIs exist
   * as `.cmd`/`.ps1` shims in `%APPDATA%\npm`, which Node refuses to spawn
   * directly (`shell: false` → ENOENT). The `.exe` binaries those shims point
   * at (or a standalone install) are preferred — they spawn without a shell;
   * only a `.cmd`/`.bat` fallback needs `cmd.exe` to run it.
   */
  const resolveWin32Command = (command: string): string | null => {
    if (process.platform !== 'win32') return command
    const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean)
    const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean)
    for (const dir of dirs) {
      const base = join(dir, command)
      for (const ext of exts) {
        const candidate = base + ext
        try {
          if (fs.statSync(candidate).isFile()) return candidate
        } catch {
          /* not this one */
        }
      }
      try {
        if (fs.statSync(base).isFile()) return base
      } catch {
        /* not this one */
      }
    }
    return null
  }

  const spawnProvider = (
    provider: ChatProvider,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv }
  ): ChildProcess => {
    const command = provider === 'claude' ? 'claude' : provider === 'codex' ? 'codex' : 'opencode'
    const base = { cwd: options.cwd || process.cwd(), windowsHide: true, env: options.env || process.env }
    if (process.platform !== 'win32') return spawn(command, args, { ...base, shell: false })
    const resolved = resolveWin32Command(command)
    if (!resolved) return spawn(command, args, { ...base, shell: false }) // emits ENOENT on 'error'
    const isShim = /\.(cmd|bat)$/i.test(resolved)
    return spawn(resolved, args, isShim ? { ...base, shell: true } : { ...base, shell: false })
  }

  ipcMain.handle(
    'chat:send',
    (
      _e,
      request: {
        id: string
        provider: ChatProvider
        prompt: string
        model: string
        effort: 'low' | 'medium' | 'high'
        mode: 'fast' | 'build' | 'plan'
      }
    ) => {
      if (!request?.id || !request.prompt?.trim() || chatCancel.has(request.id))
        return { ok: false, error: 'Некорректный запрос чата' }
      if (request.prompt.length > MAX_CHAT_PROMPT_CHARS)
        return { ok: false, error: `Промпт слишком длинный (максимум ${MAX_CHAT_PROMPT_CHARS} символов)` }
      const provider = request.provider || 'claude'
      const label = PROVIDER_LABEL[provider] || provider

      if (provider === 'openrouter') {
        const apiKey = state.settings.openRouterApiKey
        if (!apiKey)
          return { ok: false, error: 'Нет ключа OpenRouter — вставьте его в настройках чата' }
        // No default model here on purpose: the catalog is fetched live, so any
        // id hardcoded as a fallback would eventually name a retired model and
        // fail with a confusing 400 from OpenRouter instead of a clear message.
        if (!request.model)
          return { ok: false, error: 'Не выбрана модель OpenRouter' }
        const controller = new AbortController()
        const timer = setTimeout(() => {
          if (!chatCancel.has(request.id)) return
          chatCancel.delete(request.id)
          sendChatEvent(request.id, 'error', { error: `OpenRouter не ответил за ${OPENROUTER_TIMEOUT_MS / 60000} мин — отменено` })
          controller.abort()
        }, OPENROUTER_TIMEOUT_MS)
        const finish = (type: 'done' | 'error', error?: string): void => {
          clearTimeout(timer)
          chatCancel.delete(request.id)
          sendChatEvent(request.id, type, error ? { error } : {})
        }
        chatCancel.set(request.id, () => controller.abort())
        void streamOpenRouter(
          apiKey,
          request.model,
          request.prompt,
          {
            onDelta: (text) => sendChatEvent(request.id, 'delta', { text }),
            onDone: () => finish('done'),
            onError: (error) => finish('error', error)
          },
          controller.signal
        )
        return { ok: true }
      }

      const turns = request.mode === 'fast' ? 3 : request.mode === 'plan' ? 5 : request.effort === 'high' ? 20 : request.effort === 'medium' ? 10 : 5
      const prompt = `[Workspace assistant; mode=${request.mode}; effort=${request.effort}]\n${request.mode === 'fast' ? 'Be concise and use at most the needed investigation.\n' : ''}${request.prompt}`
      const args = provider === 'claude'
        ? ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', request.model || 'sonnet', '--max-turns', String(turns)]
        : provider === 'codex'
          ? ['exec', '--json', '--model', request.model || 'gpt-5-codex', '--config', `model_reasoning_effort="${request.effort}"`, prompt]
          : ['run', prompt, '--format', 'json', '--model', request.model || 'anthropic/claude-sonnet-4', '--variant', request.effort]
      if (provider === 'claude' && request.mode === 'plan') args.push('--permission-mode', 'plan')
      try {
        const child = spawnProvider(provider, args, {
          cwd: deps.getWorkspaceDir() || process.cwd(),
          env: process.env
        })
        // Exactly one terminal event per turn: a spawn failure ('error') and a
        // non-zero exit ('close') both describe the same dead child, so the
        // first one wins and the second is not reported twice.
        let settled = false
        chatCancel.set(request.id, () => {
          settled = true
          try {
            child.kill()
          } catch {
            /* already gone */
          }
          // A CLI agent keeps an entire process tree (its own spawns, tools,
          // detached helpers); child.kill() only takes the direct child, so
          // sweep the survivors by ancestry (P2-001).
          killProcessTree(child.pid)
        })
        const fail = (error: string): void => {
          if (settled) return
          settled = true
          chatCancel.delete(request.id)
          sendChatEvent(request.id, 'error', { error })
        }
        const succeed = (): void => {
          if (settled) return
          settled = true
          chatCancel.delete(request.id)
          sendChatEvent(request.id, 'done', usageTokens !== null ? { tokens: String(usageTokens) } : {})
        }
        // A child that never writes another byte is hung, not thinking — kill it
        // and surface the fact instead of leaving the panel busy forever.
        let idleTimer: NodeJS.Timeout | null = null
        const kickIdleTimer = (): void => {
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            idleTimer = null
            fail(`${label} не отвечает — отменено по таймауту`)
            try {
              child.kill()
            } catch {
              /* already gone */
            }
            killProcessTree(child.pid)
          }, CLI_IDLE_TIMEOUT_MS)
        }
        // The CLI agents report their own token accounting in a couple of
        // shapes: Claude Code's closing `result` event carries a `usage`
        // object, Codex emits a dedicated `token_count` event. Either one, when
        // present, is an exact figure straight from the provider — worth
        // reporting on `done` instead of falling back to the renderer's
        // characters-per-token guess.
        let usageTokens: number | null = null
        let buffer = ''; let stderr = ''
        child.stdout?.on('data', (chunk: Buffer) => {
          kickIdleTimer()
          buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''
          for (const line of lines) try {
            const event = JSON.parse(line) as {
              type?: string
              result?: string
              text?: string
              message?: { content?: Array<{ text?: string }> }
              item?: { text?: string; content?: string }
              usage?: Record<string, number>
              info?: { total_token_usage?: Record<string, number> }
              total_token_usage?: Record<string, number>
            }
            for (const part of event.message?.content || []) if (part.text) sendChatEvent(request.id, 'delta', { text: part.text })
            // Claude Code's closing `type:"result"` event carries the *entire*
            // reply again as a summary, not new content — every word of it was
            // already streamed above via `message.content`. Rendering it too
            // duplicated the whole answer back-to-back with no separator, so
            // this provider's final text is deliberately not re-emitted here.
            if (event.text) sendChatEvent(request.id, 'delta', { text: event.text })
            if (event.item?.text || event.item?.content) sendChatEvent(request.id, 'delta', { text: event.item.text || event.item.content || '' })
            if (event.usage) usageTokens = sumTokenFields(event.usage)
            const codexUsage = event.info?.total_token_usage || event.total_token_usage
            if (codexUsage) usageTokens = sumTokenFields(codexUsage)
          } catch { /* non-JSON diagnostics are intentionally not rendered as assistant text */ }
        })
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
        child.on('error', (err) => {
          if (idleTimer) clearTimeout(idleTimer)
          fail(`${label} недоступен: ${err.message}`)
        })
        child.on('close', (code) => {
          if (idleTimer) clearTimeout(idleTimer)
          if (code !== 0) fail(stderr.trim() || `${label} завершился с кодом ${code ?? '—'}`)
          else succeed()
        })
        return { ok: true }
      } catch (err) { return { ok: false, error: String(err) } }
    }
  )
  ipcMain.handle('chat:models', (_e, force?: boolean) => fetchOpenRouterModels(force === true))
  ipcMain.on('chat:cancel', (_e, id: string) => {
    const cancel = chatCancel.get(id)
    if (!cancel) return
    chatCancel.delete(id)
    cancel()
    // The provider loop may never emit anything after being aborted (aborted
    // fetches in particular), so the UI clears its busy state here.
    sendChatEvent(id, 'done')
  })

  // ---- terminals ---------------------------------------------------------
  ipcMain.handle('terminal:create', (_e, id: string, cols?: number, rows?: number) =>
    terminals.spawn(id, cols, rows, deps.getWorkspaceDir())
  )
  ipcMain.on('terminal:write', (_e, id: string, data: string) => terminals.write(id, data))
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) =>
    terminals.resize(id, cols, rows)
  )
  ipcMain.on('terminal:dispose', (_e, id: string) => terminals.dispose(id))
  /** The renderer reports which terminal holds keyboard focus, if any. */
  ipcMain.on('terminal:focus', (_e, focused: boolean, id?: string) => {
    terminalFocusedId = focused && typeof id === 'string' ? id : null
  })

  // ---- workspace directory ----------------------------------------------
  ipcMain.handle('workspace:get-dir', () => deps.getWorkspaceDir() ?? null)
  ipcMain.handle('workspace:pick-dir', async () => {
    const window = deps.getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return deps.getWorkspaceDir() ?? null
    deps.setWorkspaceDir(result.filePaths[0])
    return result.filePaths[0]
  })

  // ---- remembered project folders ----------------------------------------
  ipcMain.handle('workspace:recent', () => state.get().recent)
  /** Reopens a folder already in the list without going through the OS dialog. */
  ipcMain.handle('workspace:open-recent', (_e, path: string) => {
    if (typeof path !== 'string' || !fs.existsSync(path)) {
      state.removeRecent(String(path))
      return { error: 'папка недоступна' }
    }
    deps.setWorkspaceDir(path)
    return path
  })
  ipcMain.handle('workspace:pin-recent', (_e, path: string) => {
    state.togglePin(path)
    return state.get().recent
  })
  ipcMain.handle('workspace:forget-recent', (_e, path: string) => {
    state.removeRecent(path)
    return state.get().recent
  })

  // ---- settings ----------------------------------------------------------
  ipcMain.handle('settings:get', () => state.settings)
  ipcMain.handle('settings:set', (_e, patch: SettingsPatch) => {
    const next = state.patchSettings(patch ?? {})
    // Link syntax drives the parser, so relink every note before the UI reloads.
    brain.refresh()
    return next
  })

  // ---- pasted pictures ---------------------------------------------------
  ipcMain.handle('media:save-clipboard', () => media.saveClipboardImage())
  /** Paste of a real File: the renderer already holds the bytes, so it sends them. */
  ipcMain.handle('media:save-bytes', (_e, bytes: Uint8Array, ext: string) => {
    if (!bytes?.byteLength) return null
    if (bytes.byteLength > media.MAX_MEDIA_BYTES) return { error: 'Изображение больше 24 МБ' }
    return media.saveBytes(Buffer.from(bytes), ext || 'png')
  })
  ipcMain.handle('media:data-url', (_e, path: string) =>
    typeof path === 'string' && media.hasImageExtension(path) ? media.dataUrl(path) : null
  )

  // ---- wallpaper ---------------------------------------------------------
  const backgroundDir = (): string => join(app.getPath('userData'), BACKGROUND_DIR_NAME)

  const backgroundDataUrl = async (): Promise<string | null> => {
    const path = state.settings.backgroundImage
    if (!path) return null
    const url = await media.dataUrl(path)
    // The copy was deleted out from under us — forget it instead of retrying forever.
    if (!url) state.patchSettings({ backgroundImage: null })
    return url
  }

  ipcMain.handle('settings:get-background', () => backgroundDataUrl())
  ipcMain.handle('settings:pick-background', async () => {
    const window = deps.getWindow()
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'Изображения', extensions: media.IMAGE_EXTENSIONS }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const source = result.canceled ? null : result.filePaths[0]
    if (!source) return { dataUrl: await backgroundDataUrl() }

    try {
      if (fs.statSync(source).size > media.MAX_MEDIA_BYTES)
        return { error: 'Файл больше 24 МБ — выберите изображение поменьше.' }

      const dir = backgroundDir()
      fs.mkdirSync(dir, { recursive: true })
      // One wallpaper at a time: clearing the folder first keeps old copies from
      // accumulating in userData every time the picture is changed.
      for (const name of fs.readdirSync(dir)) {
        try {
          fs.rmSync(join(dir, name), { force: true })
        } catch {
          /* a locked leftover must not block the new pick */
        }
      }
      const target = join(dir, `background-${Date.now()}${extname(source).toLowerCase() || '.png'}`)
      fs.copyFileSync(source, target)
      state.patchSettings({ backgroundImage: target })
      return { dataUrl: await backgroundDataUrl() }
    } catch (err) {
      return { error: `Не удалось прочитать файл: ${String(err)}` }
    }
  })
  ipcMain.handle('settings:clear-background', () => {
    state.patchSettings({ backgroundImage: null })
    try {
      fs.rmSync(backgroundDir(), { recursive: true, force: true })
    } catch {
      /* the setting is already cleared; a stale copy on disk is harmless */
    }
    return null
  })

  // ---- canvas layout (widgets, camera, strokes) ---------------------------
  ipcMain.handle('canvas:load', () => canvas.load())
  ipcMain.handle('canvas:save', (_e, snapshot) => {
    canvas.save(snapshot ?? {})
  })

  // ---- second brain ------------------------------------------------------
  ipcMain.handle('brain:list', () => brain.snapshot())
  ipcMain.handle('brain:create', (_e, input) => brain.create(input ?? {}))
  ipcMain.handle('brain:update', (_e, id: string, patch) => brain.update(id, patch ?? {}))
  ipcMain.handle('brain:delete', (_e, id: string) => brain.remove(id))
  ipcMain.handle('brain:trash', () => brain.trash())
  ipcMain.handle('brain:restore', (_e, id: string) => brain.restore(id))
  ipcMain.handle('brain:purge', (_e, id: string) => brain.purge(id))
  ipcMain.handle('brain:graph', () => brain.graph())

  // ---- coordination / kanban --------------------------------------------
  ipcMain.handle('coordination:status', () => coordination.snapshot())
  ipcMain.handle(
    'coordination:create-task',
    (_e, input: { title: string; brief?: string; state?: string; tags?: string[]; dueAt?: number; assignee?: string }) =>
      guard(() =>
        coordination.createTask({
          title: input?.title ?? '',
          brief: input?.brief,
          createdBy: USER_AUTHOR,
          state: (input?.state as never) ?? 'queued',
          tags: input?.tags,
          dueAt: input?.dueAt,
          assignee: input?.assignee
        })
      )
  )
  ipcMain.handle(
    'coordination:update-task',
    (
      _e,
      id: string,
      patch: { state?: string; title?: string; brief?: string; tags?: string[]; dueAt?: number | null; assignee?: string | null }
    ) => guard(() => coordination.updateTaskAsUser(id, patch ?? {}, actor()))
  )
  ipcMain.handle('coordination:delete-task', (_e, id: string) => guard(() => coordination.deleteTask(id)))
  ipcMain.handle('coordination:reset-manager', () => {
    coordination.forceResetManager()
    return coordination.snapshot()
  })
  ipcMain.handle('coordination:release-locks', () => {
    coordination.forceReleaseLocks()
    return coordination.snapshot()
  })
}
