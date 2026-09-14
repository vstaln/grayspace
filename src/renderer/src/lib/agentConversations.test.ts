import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  conversationKey,
  dismissedKey,
  extractResumeId,
  isResumeCommand,
  readDismissed,
  relativeTime,
  resumeAllCount,
  selectAutoResumeConversations,
  upgradeSessionsToResume,
  visibleConversations,
  writeDismissed
} from './agentConversations.ts'

function memoryStore(initial: Record<string, string> = {}): {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  data: Record<string, string>
} {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value },
    removeItem: (key) => { delete data[key] }
  }
}

const DIR = 'C:\\Users\\dev\\Project'

describe('agentConversations - relativeTime', () => {
  const now = 1_700_000_000_000

  test('under a minute reads as just now', () => {
    assert.equal(relativeTime(now - 5_000, now), 'just now')
  })

  test('a future timestamp does not read as negative', () => {
    assert.equal(relativeTime(now + 5_000, now), 'just now')
  })

  test('minutes are singular at one', () => {
    assert.equal(relativeTime(now - 60_000, now), '1 minute ago')
    assert.equal(relativeTime(now - 24 * 60_000, now), '24 minutes ago')
  })

  test('hours and days', () => {
    assert.equal(relativeTime(now - 3 * 3_600_000, now), '3 hours ago')
    assert.equal(relativeTime(now - 2 * 86_400_000, now), '2 days ago')
  })

  test('older than a month falls back to a date', () => {
    const label = relativeTime(now - 200 * 86_400_000, now)
    assert.ok(!label.endsWith('ago'), label)
  })

  test('a missing timestamp is labelled, not rendered as NaN', () => {
    assert.equal(relativeTime(0, now), 'unknown')
    assert.equal(relativeTime(Number.NaN, now), 'unknown')
  })
})

describe('agentConversations - panel rows', () => {
  const rows = [
    { agentId: 'claude' as const, id: 'aaaaaaaa1' },
    { agentId: 'codex' as const, id: 'bbbbbbbb1' },
    { agentId: 'antigravity' as const, id: 'cccccccc1' }
  ]

  test('dismissed rows drop out and the order is kept', () => {
    const visible = visibleConversations(rows, new Set(['codex:bbbbbbbb1']))
    assert.deepEqual(visible.map((r) => r.id), ['aaaaaaaa1', 'cccccccc1'])
  })

  test('an id dismissed for another agent does not hide this one', () => {
    assert.equal(visibleConversations(rows, new Set(['codex:aaaaaaaa1'])).length, 3)
  })

  test('resume all never exceeds rows, free slots or the bulk cap', () => {
    assert.equal(resumeAllCount(10, 32, 6), 6)
    assert.equal(resumeAllCount(3, 32, 6), 3)
    assert.equal(resumeAllCount(10, 2, 6), 2)
  })

  test('resume all is zero when there is no room, never negative', () => {
    assert.equal(resumeAllCount(10, 0, 6), 0)
    assert.equal(resumeAllCount(10, -4, 6), 0)
    assert.equal(resumeAllCount(0, 32, 6), 0)
  })
})

describe('agentConversations - dismissals', () => {
  test('keys are per folder', () => {
    assert.notEqual(dismissedKey(DIR), dismissedKey(`${DIR}-other`))
  })

  test('round-trips through storage', () => {
    const storage = memoryStore()
    writeDismissed(DIR, ['claude:a'], ['claude:a', 'codex:b'], storage)
    assert.deepEqual(Array.from(readDismissed(DIR, storage)), ['claude:a'])
  })

  test('drops dismissals whose conversation is gone', () => {
    const storage = memoryStore()
    const kept = writeDismissed(DIR, ['claude:a', 'claude:stale'], ['claude:a'], storage)
    assert.deepEqual(kept, ['claude:a'])
    assert.deepEqual(Array.from(readDismissed(DIR, storage)), ['claude:a'])
  })

  test('clears the key when nothing is left', () => {
    const storage = memoryStore({ [dismissedKey(DIR)]: '["claude:a"]' })
    writeDismissed(DIR, [], [], storage)
    assert.equal(storage.getItem(dismissedKey(DIR)), null)
  })

  test('corrupt storage reads as empty', () => {
    const storage = memoryStore({ [dismissedKey(DIR)]: '{not json' })
    assert.equal(readDismissed(DIR, storage).size, 0)
  })

  test('works with no storage at all', () => {
    assert.equal(readDismissed(DIR, null).size, 0)
    assert.deepEqual(writeDismissed(DIR, ['claude:a'], ['claude:a'], null), ['claude:a'])
  })

  test('conversation keys separate agents that share an id', () => {
    assert.notEqual(
      conversationKey({ agentId: 'claude', id: 'x1234567' }),
      conversationKey({ agentId: 'codex', id: 'x1234567' })
    )
  })
})

describe('agentConversations - selectAutoResumeConversations', () => {
  const now = 1_700_000_000_000

  test('returns empty when no conversations or no slots', () => {
    assert.deepEqual(selectAutoResumeConversations([], 5), [])
    assert.deepEqual(selectAutoResumeConversations([{ agentId: 'codex', id: 'c1', updatedAt: now }], 0), [])
  })

  test('selects latest conversation per distinct agent', () => {
    const list = [
      { agentId: 'codex', id: 'c1', updatedAt: now },
      { agentId: 'codex', id: 'c2', updatedAt: now - 5 * 3600_000 },
      { agentId: 'claude', id: 'cl1', updatedAt: now - 10 * 3600_000 },
      { agentId: 'claude', id: 'cl2', updatedAt: now - 20 * 3600_000 }
    ]
    const selected = selectAutoResumeConversations(list, 5)
    assert.deepEqual(selected.map((c) => c.id), ['c1', 'cl1'])
  })

  test('includes multiple conversations of same agent if in recent burst', () => {
    const list = [
      { agentId: 'codex', id: 'c1', updatedAt: now },
      { agentId: 'codex', id: 'c2', updatedAt: now - 30 * 60_000 }, // 30 min ago
      { agentId: 'codex', id: 'c3', updatedAt: now - 5 * 3600_000 } // 5h ago
    ]
    const selected = selectAutoResumeConversations(list, 5)
    assert.deepEqual(selected.map((c) => c.id), ['c1', 'c2'])
  })

  test('respects maxSlots limit', () => {
    const list = [
      { agentId: 'codex', id: 'c1', updatedAt: now },
      { agentId: 'claude', id: 'cl1', updatedAt: now },
      { agentId: 'antigravity', id: 'a1', updatedAt: now }
    ]
    const selected = selectAutoResumeConversations(list, 2)
    assert.equal(selected.length, 2)
  })
})

describe('agentConversations - isResumeCommand', () => {
  test('detects resume commands', () => {
    assert.equal(isResumeCommand('claude --resume 123'), true)
    assert.equal(isResumeCommand('codex resume 123'), true)
    assert.equal(isResumeCommand('agy --conversation 123'), true)
  })

  test('rejects bare commands', () => {
    assert.equal(isResumeCommand('claude'), false)
    assert.equal(isResumeCommand('codex'), false)
    assert.equal(isResumeCommand('agy'), false)
    assert.equal(isResumeCommand(''), false)
  })
})

describe('agentConversations - extractResumeId', () => {
  test('extracts conversation ids from various CLI formats', () => {
    assert.equal(extractResumeId('claude --resume session-abc'), 'session-abc')
    assert.equal(extractResumeId('codex resume conv-123'), 'conv-123')
    assert.equal(extractResumeId('agy --conversation agy-999'), 'agy-999')
    assert.equal(extractResumeId('claude'), null)
    assert.equal(extractResumeId(''), null)
  })
})

describe('agentConversations - upgradeSessionsToResume regression tests', () => {
  test('mixed set [resume A, bare] preserves A and assigns B to the bare session', () => {
    const sessions = [
      {
        id: 'term-1',
        agent: { id: 'codex', command: 'codex resume session-A', label: 'Codex' },
        title: 'Session A',
        status: 'active' as const
      },
      {
        id: 'term-2',
        agent: { id: 'codex', command: 'codex', label: 'Codex' },
        title: 'Codex',
        status: 'finished' as const
      }
    ]
    const conversations = [
      { id: 'session-A', agentId: 'codex' as const, title: 'Session A', updatedAt: 1000, command: 'codex resume session-A' },
      { id: 'session-B', agentId: 'codex' as const, title: 'Session B', updatedAt: 900, command: 'codex resume session-B' }
    ]

    const { sessions: upgraded, upgraded: anyUpgraded } = upgradeSessionsToResume(sessions, conversations)

    assert.equal(anyUpgraded, true)
    assert.equal(upgraded.length, 2)
    assert.equal(upgraded[0].agent.command, 'codex resume session-A')
    assert.equal(upgraded[0].status, 'active')
    assert.equal(upgraded[1].agent.command, 'codex resume session-B')
    assert.equal(upgraded[1].title, 'Session B')
    assert.equal(upgraded[1].status, 'active')
  })

  test('collision of same conversation id across different agents does not conflict', () => {
    const sessions = [
      {
        id: 'term-1',
        agent: { id: 'codex', command: 'codex resume common-id', label: 'Codex' },
        title: 'Codex with common ID',
        status: 'active' as const
      },
      {
        id: 'term-2',
        agent: { id: 'claude', command: 'claude', label: 'Claude' },
        title: 'Claude',
        status: 'active' as const
      }
    ]
    const conversations = [
      { id: 'common-id', agentId: 'codex' as const, title: 'Codex Session', updatedAt: 1000, command: 'codex resume common-id' },
      { id: 'common-id', agentId: 'claude' as const, title: 'Claude Session', updatedAt: 900, command: 'claude --resume common-id' }
    ]

    const { sessions: upgraded } = upgradeSessionsToResume(sessions, conversations)

    assert.equal(upgraded[0].agent.command, 'codex resume common-id')
    assert.equal(upgraded[1].agent.command, 'claude --resume common-id')
    assert.equal(upgraded[1].title, 'Claude Session')
  })

  test('multiple bare sessions for the same agent receive distinct conversations in order', () => {
    const sessions = [
      {
        id: 'term-1',
        agent: { id: 'claude', command: 'claude', label: 'Claude' },
        status: 'finished' as const
      },
      {
        id: 'term-2',
        agent: { id: 'claude', command: 'claude', label: 'Claude' },
        status: 'finished' as const
      }
    ]
    const conversations = [
      { id: 'c1', agentId: 'claude' as const, title: 'First Claude', updatedAt: 1000, command: 'claude --resume c1' },
      { id: 'c2', agentId: 'claude' as const, title: 'Second Claude', updatedAt: 900, command: 'claude --resume c2' }
    ]

    const { sessions: upgraded, upgraded: anyUpgraded } = upgradeSessionsToResume(sessions, conversations)

    assert.equal(anyUpgraded, true)
    assert.equal(upgraded[0].agent.command, 'claude --resume c1')
    assert.equal(upgraded[0].status, 'active')
    assert.equal(upgraded[1].agent.command, 'claude --resume c2')
    assert.equal(upgraded[1].status, 'active')
  })

  test('browser sessions are ignored and preserved', () => {
    const sessions = [
      {
        id: 'term-browser',
        agent: { id: 'browser', command: '', label: 'Browser' },
        title: 'Browser Tab',
        status: 'active' as const
      }
    ]
    const { sessions: upgraded, upgraded: anyUpgraded } = upgradeSessionsToResume(sessions, [])
    assert.equal(anyUpgraded, false)
    assert.equal(upgraded[0].agent.id, 'browser')
  })

  test('excess bare sessions keep their bare command with active status when conversations run out', () => {
    const sessions = [
      {
        id: 'term-1',
        agent: { id: 'codex', command: 'codex', label: 'Codex' },
        status: 'finished' as const
      },
      {
        id: 'term-2',
        agent: { id: 'codex', command: 'codex', label: 'Codex' },
        status: 'finished' as const
      }
    ]
    const conversations = [
      { id: 'c1', agentId: 'codex' as const, title: 'Single Session', updatedAt: 1000, command: 'codex resume c1' }
    ]

    const { sessions: upgraded } = upgradeSessionsToResume(sessions, conversations)

    assert.equal(upgraded[0].agent.command, 'codex resume c1')
    assert.equal(upgraded[0].status, 'active')
    assert.equal(upgraded[1].agent.command, 'codex')
    assert.equal(upgraded[1].status, 'active')
  })
})
