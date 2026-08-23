import { EventEmitter } from 'events'
import type { AppState } from './appState'
import type { Core } from './core/index.ts'
import type { CanvasStore } from './canvasState.ts'
import { handleBotCommand } from './botCommands.ts'

export type TelegramConnectionState = 'disconnected' | 'connected' | 'error'

export interface TelegramStatus {
  state: TelegramConnectionState
  lastMessage?: string
  error?: string
}

interface TelegramUpdate {
  update_id: number
  message?: {
    text?: string
    from?: {
      id?: number | string
      is_bot?: boolean
      first_name?: string
      username?: string
    }
    chat?: {
      id?: number | string
      type?: string
    }
  }
}

interface TelegramResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

export interface TelegramBotOptions {
  sleep?: (ms: number) => Promise<void>
  maxRetryDelayMs?: number
}

/** Telegram uses numeric ids while settings arrive from IPC as strings. Supports comma-separated IDs. */
export function isTelegramUserAllowed(userId: number | string, allowlist: string | undefined): boolean {
  if (!allowlist) return false
  const target = String(userId).trim()
  return allowlist
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
    .includes(target)
}

export const isTelegramChatAllowed = isTelegramUserAllowed

function safeTelegramError(error: unknown, token: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  // Fetch implementations may include the request URL in network errors.
  return raw.replaceAll(token, '[redacted]').replaceAll(encodeURIComponent(token), '[redacted]')
}

/** Small dependency-free Telegram Bot API client with a single long-poll loop. */
export class TelegramBot extends EventEmitter {
  private readonly state: AppState
  private readonly core: Core
  private readonly canvas: CanvasStore
  private status: TelegramStatus = { state: 'disconnected' }
  private abort: AbortController | null = null
  private offset = 0
  private generation = 0
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetryDelayMs: number

  constructor(state: AppState, core: Core, canvas: CanvasStore, options: TelegramBotOptions = {}) {
    super()
    this.state = state
    this.core = core
    this.canvas = canvas
    // Same rationale as the Discord bot: remote keystrokes go through the
    // command bus as a user-type actor so they are journaled and gated by the
    // terminal's lock (P4).
    core.actors.register({ id: 'telegram', type: 'user', label: 'Telegram', transport: 'integration' })
    this.sleep = options.sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)))
    this.maxRetryDelayMs = options.maxRetryDelayMs || 30_000
  }

  getStatus(): TelegramStatus {
    return { ...this.status }
  }

  /** Re-reads encrypted settings and starts/stops polling accordingly. */
  refresh(): void {
    this.stop()
    if (this.state.settings.telegramBotToken) void this.start(this.state.settings.telegramBotToken)
  }

  stop(): void {
    this.generation += 1
    this.abort?.abort()
    this.abort = null
    if (this.status.state !== 'disconnected') this.setStatus({ state: 'disconnected' })
  }

  async sendMessage(
    text: string,
    targetId = this.state.settings.telegramUserId ?? this.state.settings.telegramChatId
  ): Promise<{ ok: true } | { error: string }> {
    const token = this.state.settings.telegramBotToken
    const target = targetId?.trim()
    if (!token) return { error: 'Telegram bot token is not configured' }
    if (!target) return { error: 'Telegram user ID is not configured' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      await this.api(token, 'sendMessage', { chat_id: target, text: text.slice(0, 4096) }, controller.signal)
      return { ok: true }
    } catch (error) {
      const failure = controller.signal.aborted ? new Error('Telegram send timed out') : error
      const message = safeTelegramError(failure, token)
      this.setStatus({ state: 'error', error: message })
      return { error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  async testSend(): Promise<{ ok: true } | { error: string }> {
    return this.sendMessage('OrcSpace Telegram integration test')
  }

  private async start(token: string): Promise<void> {
    const run = ++this.generation
    const abort = new AbortController()
    this.abort = abort
    let failures = 0
    let verified = false
    while (run === this.generation && !abort.signal.aborted) {
        try {
          if (!verified) {
            await this.api(token, 'getMe', {}, abort.signal)
            if (run !== this.generation) return
            verified = true
            this.setStatus({ state: 'connected' })
          }
          const response = await this.api<TelegramUpdate[]>(token, 'getUpdates', {
            offset: this.offset,
            timeout: 25,
            allowed_updates: ['message']
          }, abort.signal)
          failures = 0
          for (const update of response) {
            this.offset = Math.max(this.offset, update.update_id + 1)
            await this.handleMessage(update).catch((err) => {
              this.setStatus({ state: 'error', error: String(err?.message ?? err) })
            })
          }
        } catch (error) {
          if (abort.signal.aborted || run !== this.generation) return
          failures += 1
          verified = false
          const message = safeTelegramError(error, token)
          this.setStatus({ state: 'error', error: message })
          const delay = Math.min(this.maxRetryDelayMs, 1000 * 2 ** Math.min(failures - 1, 10))
          await Promise.race([
            this.sleep(delay),
            new Promise<void>((resolve) => {
              if (abort.signal.aborted) return resolve()
              abort.signal.addEventListener('abort', () => resolve(), { once: true })
            })
          ])
        }
    }
  }

  private async handleMessage(update: TelegramUpdate): Promise<void> {
    const message = update.message
    const text = message?.text?.trim()
    const senderId = message?.from?.id ?? message?.chat?.id
    const settings = this.state.settings
    const allowedUserId = settings.telegramUserId ?? settings.telegramChatId
    // Authentication happens before looking up or writing to any terminal.
    if (!text || senderId === undefined || !allowedUserId) return
    if (!isTelegramUserAllowed(senderId, allowedUserId)) return
    this.status.lastMessage = new Date().toISOString()
    this.emit('status', this.getStatus())

    if (text.startsWith('/')) {
      const reply = await handleBotCommand(text, {
        core: this.core,
        canvas: this.canvas,
        state: this.state,
        actorId: 'telegram'
      })
      if (reply) await this.sendMessage(reply, String(senderId))
      return
    }

    if (!settings.targetTerminalId) return
    // Through the bus (journaled, lock-gated) instead of a raw pty write so an
    // agent mid-command cannot have its keystrokes interleaved (P4).
    const result = await this.core.bus.submit<{ ok: true }>({
      actorId: 'telegram',
      type: 'terminal.input',
      target: `terminal:${settings.targetTerminalId}`,
      payload: { data: text.slice(0, 4_000) + '\r\n' }
    })
    if (!result.ok) this.setStatus({ state: 'error', error: result.message })
  }

  private setStatus(status: TelegramStatus): void {
    this.status = { ...status }
    this.emit('status', this.getStatus())
  }

  private async api<T = unknown>(token: string, method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${token.trim()}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
    let payload: TelegramResponse<T>
    try {
      payload = (await response.json()) as TelegramResponse<T>
    } catch {
      throw new Error('Telegram returned an invalid response')
    }
    if (!response.ok || !payload.ok) {
      throw new Error(payload.description || `Telegram API request failed (${response.status})`)
    }
    return payload.result as T
  }
}
