import { randomUUID } from 'crypto'
import type { BrowserAgentAction, BrowserAgentResponse } from '../preload/api.ts'

type Broadcast = (channel: string, payload: unknown) => void

const pending = new Map<string, (response: BrowserAgentResponse) => void>()
const busyWidgets = new Set<string>()
const MAX_RESPONSE_BYTES = 96 * 1024

export function requestBrowserAgentAction(
  widgetId: string,
  action: BrowserAgentAction,
  broadcast: Broadcast,
  timeoutMs = 30_000
): Promise<BrowserAgentResponse> {
  if (busyWidgets.has(widgetId)) return Promise.resolve({ ok: false, error: 'browser widget is handling another action' })
  const requestId = randomUUID()
  busyWidgets.add(widgetId)
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ ok: false, error: 'browser action timed out' }), timeoutMs)
    const finish = (response: BrowserAgentResponse): void => {
      clearTimeout(timer)
      pending.delete(requestId)
      busyWidgets.delete(widgetId)
      resolve(response)
    }
    pending.set(requestId, finish)
    try {
      broadcast('browser:agent-action', { requestId, widgetId, action })
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

/**
 * Asks the Code view to open a browser session of its own and answers with the
 * session id. An agent working in Code expects its browser beside it; placing
 * it on the canvas left it out of sight and out of `orc browser list`.
 */
export function requestCodeBrowserOpen(
  title: string,
  broadcast: Broadcast,
  timeoutMs = 5_000
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ ok: false, error: 'Code view did not open a browser' }), timeoutMs)
    const finish = (response: BrowserAgentResponse): void => {
      clearTimeout(timer)
      pending.delete(requestId)
      if (!response.ok) return resolve(response)
      const id = (response.result as { id?: unknown } | null)?.id
      resolve(typeof id === 'string' && /^code-[A-Za-z0-9_-]{1,120}$/.test(id)
        ? { ok: true, id }
        : { ok: false, error: 'Code view returned an invalid browser id' })
    }
    pending.set(requestId, finish)
    try {
      broadcast('browser:open-in-code', { requestId, title })
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

export function resolveBrowserAgentAction(requestId: string, raw: unknown): boolean {
  const finish = pending.get(requestId)
  if (!finish) return false
  if (!raw || typeof raw !== 'object') return false

  const response = raw as Record<string, unknown>
  if (response.ok === false && typeof response.error === 'string') {
    finish({ ok: false, error: response.error.slice(0, 1000) })
    return true
  }
  if (response.ok !== true) return false

  let serialized: string
  try {
    serialized = JSON.stringify(response.result ?? null)
  } catch {
    finish({ ok: false, error: 'browser returned an unsupported result' })
    return true
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESPONSE_BYTES) {
    finish({ ok: false, error: 'browser result is too large; request a smaller snapshot' })
    return true
  }
  finish({ ok: true, result: JSON.parse(serialized) as unknown })
  return true
}
