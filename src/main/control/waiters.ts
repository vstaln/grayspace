import type * as http from 'http'
import type { OrchestrationStore } from '../orchestration/store.ts'
import type { MessageType } from '../orchestration/types.ts'

const MAX_WAITERS = 50
let activeWaiters = 0

function overloaded(): boolean {
  return activeWaiters >= MAX_WAITERS
}

export function waitForInbox(
  orchestration: OrchestrationStore,
  agentId: string,
  filter: { runId?: string; types?: MessageType[]; includeAcked?: boolean; limit?: number },
  timeoutMs: number,
  req: http.IncomingMessage
): Promise<{ messages: unknown[]; overloaded: boolean }> {
  if (overloaded()) return Promise.resolve({ messages: orchestration.inbox(agentId, filter), overloaded: true })
  activeWaiters += 1
  return new Promise((resolvePromise) => {
    let finished = false
    const finish = (messages: unknown[]): void => {
      if (finished) return
      finished = true
      activeWaiters = Math.max(0, activeWaiters - 1)
      clearTimeout(timer)
      orchestration.off('message', onMessage)
      req.off('close', onClose)
      resolvePromise({ messages, overloaded: false })
    }
    const onMessage = (message?: { runId?: string; type?: MessageType }): void => {
      if (message) {
        if (filter.runId && message.runId !== filter.runId) return
        if (filter.types?.length && message.type && !filter.types.includes(message.type)) return
      }
      const messages = orchestration.inbox(agentId, filter)
      if (messages.length > 0) finish(messages)
    }
    const onClose = (): void => finish([])
    const timer = setTimeout(() => finish([]), timeoutMs)
    timer.unref?.()
    orchestration.on('message', onMessage)
    req.on('close', onClose)
    onMessage()
  })
}

export function waitForReply(
  orchestration: OrchestrationStore,
  askId: string,
  timeoutMs: number,
  req: http.IncomingMessage
): Promise<{ reply: unknown; overloaded: boolean }> {
  if (overloaded()) return Promise.resolve({ reply: orchestration.replyTo(askId) ?? null, overloaded: true })
  activeWaiters += 1
  return new Promise((resolvePromise) => {
    let finished = false
    const finish = (reply: unknown): void => {
      if (finished) return
      finished = true
      activeWaiters = Math.max(0, activeWaiters - 1)
      clearTimeout(timer)
      orchestration.off('message', onMessage)
      req.off('close', onClose)
      resolvePromise({ reply, overloaded: false })
    }
    const onMessage = (): void => {
      const reply = orchestration.replyTo(askId)
      if (reply) finish(reply)
    }
    const onClose = (): void => finish(null)
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    orchestration.on('message', onMessage)
    req.on('close', onClose)
    onMessage()
  })
}
