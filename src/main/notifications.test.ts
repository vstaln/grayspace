import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NotificationManager, type NotificationSender } from './notifications.ts'
import type { CoordinationSnapshot } from './coordination.ts'

class MockSender implements NotificationSender {
  messages: string[] = []
  async sendMessage(text: string): Promise<{ ok: true }> {
    this.messages.push(text)
    return { ok: true }
  }
}

describe('NotificationManager', () => {
  it('does not send notification on initial task hydration', () => {
    const telegram = new MockSender()
    const manager = new NotificationManager(telegram)

    const initialSnapshot: CoordinationSnapshot = {
      managerId: null,
      tasks: [
        {
          id: 't-1',
          title: 'Existing task',
          brief: '',
          files: [],
          state: 'done',
          createdBy: 'user',
          tags: [],
          maxSteps: 10,
          maxReviewIterations: 3,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          version: 1
        }
      ],
      locks: []
    }

    manager.handleCoordinationChange(initialSnapshot)
    assert.equal(telegram.messages.length, 0)
  })

  it('notifies Telegram when a task moves to done', async () => {
    const telegram = new MockSender()
    const manager = new NotificationManager(telegram)

    const initialSnapshot: CoordinationSnapshot = {
      managerId: null,
      tasks: [
        {
          id: 't-1',
          title: 'Implement feature',
          brief: '',
          files: [],
          state: 'in_progress',
          createdBy: 'user',
          assignee: 'agent-1',
          tags: [],
          maxSteps: 10,
          maxReviewIterations: 3,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          version: 1
        }
      ],
      locks: []
    }

    manager.handleCoordinationChange(initialSnapshot)
    assert.equal(telegram.messages.length, 0)

    const updatedSnapshot: CoordinationSnapshot = {
      ...initialSnapshot,
      tasks: [
        {
          ...initialSnapshot.tasks[0],
          state: 'done',
          version: 2
        }
      ]
    }

    manager.handleCoordinationChange(updatedSnapshot)
    await new Promise((r) => setTimeout(r, 10))

    assert.equal(telegram.messages.length, 1)
    assert.match(telegram.messages[0], /Task completed: "Implement feature" \(assignee: agent-1\)/)
  })
})
