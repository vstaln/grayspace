import type { TelegramBot } from './telegramBot.ts'
import type { CoordinationSnapshot } from './coordination.ts'

export interface NotificationSender {
  sendMessage(text: string): Promise<{ ok: true } | { error: string }>
}

/** Dispatches automated notifications on Kanban task completions and review requests. */
export class NotificationManager {
  private readonly telegram: NotificationSender
  private previousTaskStates = new Map<string, string>()
  private initializedTasks = false

  constructor(telegram: NotificationSender) {
    this.telegram = telegram
  }

  /**
   * Fans one message out to every configured channel. A channel that is not
   * set up, or that is down, must never stop the other one from delivering —
   * so failures are collected rather than thrown, and the result says whether
   * the message reached anybody at all.
   */
  async send(message: string): Promise<{ ok: true } | { error: string }> {
    const attempts: Array<Promise<{ ok: true } | { error: string }>> = []
    for (const channel of [this.telegram]) {
      try {
        attempts.push(channel.sendMessage(message).catch((err) => ({ error: errorText(err) })))
      } catch (err) {
        attempts.push(Promise.resolve({ error: errorText(err) }))
      }
    }
    const results = await Promise.all(attempts)
    if (results.some((result) => 'ok' in result)) return { ok: true }
    const errors = results.map((result) => ('error' in result ? result.error : '')).filter(Boolean)
    return { error: errors.join('; ') || 'no notification channel is configured' }
  }

  handleCoordinationChange(snapshot: CoordinationSnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.tasks)) return

    if (!this.initializedTasks) {
      for (const t of snapshot.tasks) {
        this.previousTaskStates.set(t.id, t.state)
      }
      this.initializedTasks = true
      return
    }

    const live = new Set<string>()
    for (const task of snapshot.tasks) {
      live.add(task.id)
      const prev = this.previousTaskStates.get(task.id)
      this.previousTaskStates.set(task.id, task.state)
      // A task never seen before counts as changed: one whose whole
      // claim→done cycle fits between two polls must still announce itself,
      // not silently vanish into the baseline.
      if (prev === undefined || prev !== task.state) {
        if (task.state === 'done') {
          const assigneeStr = task.assignee ? ` (assignee: ${task.assignee})` : ''
          void this.send(`[OrcSpace] ✅ Task completed: "${task.title}"${assigneeStr}`)
        } else if (task.state === 'review') {
          const assigneeStr = task.assignee ? ` (assignee: ${task.assignee})` : ''
          void this.send(`[OrcSpace] 🔍 Task ready for review: "${task.title}"${assigneeStr}`)
        }
      }
    }
    for (const id of Array.from(this.previousTaskStates.keys())) {
      if (!live.has(id)) this.previousTaskStates.delete(id)
    }
  }

}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
