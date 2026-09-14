import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { resolvePersistedAgent } from './persistedAgent.ts'

const AGENTS = [
  { id: 'claude', command: 'claude' },
  { id: 'codex', command: 'codex' },
  { id: 'antigravity', command: 'agy' },
  { id: 'browser', command: 'browser' },
  { id: 'custom', command: '' }
] as const

describe('resolvePersistedAgent', () => {
  test('keeps the arguments of a resumed conversation', () => {
    for (const [agentId, command, id] of [
      ['claude', 'claude --resume 9d911a96-6c48-4640-ae51-57833d0d64d1', 'claude'],
      ['codex', 'codex resume 01a09f25-88c0-7da1-8bf3-3fda3c91a298', 'codex'],
      ['antigravity', 'agy --conversation 850e41fb-e381-4461-9298-8ccd8e437256', 'antigravity']
    ] as const) {
      const resolved = resolvePersistedAgent(agentId, command, AGENTS)
      assert.equal(resolved?.agent.id, id, command)
      assert.equal(resolved?.command, command)
    }
  })

  test('the executable decides the agent, not stale metadata', () => {
    const resolved = resolvePersistedAgent('codex', 'claude --resume abcdefgh', AGENTS)
    assert.equal(resolved?.agent.id, 'claude')
    assert.equal(resolved?.command, 'claude --resume abcdefgh')
  })

  test('a quoted Windows wrapper is still recognised', () => {
    const command = '"C:\\codex-tools\\claude.exe" --resume abcdefgh'
    const resolved = resolvePersistedAgent('custom', command, AGENTS)
    assert.equal(resolved?.agent.id, 'claude')
    assert.equal(resolved?.command, command)
  })

  test('a bare agent command is unchanged', () => {
    const resolved = resolvePersistedAgent('claude', 'claude', AGENTS)
    assert.equal(resolved?.agent.id, 'claude')
    assert.equal(resolved?.command, 'claude')
  })

  test('an empty command falls back to how the agent normally starts', () => {
    const resolved = resolvePersistedAgent('claude', '', AGENTS)
    assert.equal(resolved?.agent.id, 'claude')
    assert.equal(resolved?.command, 'claude')
  })

  test('a browser session keeps its own identity', () => {
    const resolved = resolvePersistedAgent('browser', 'browser', AGENTS)
    assert.equal(resolved?.agent.id, 'browser')
    assert.equal(resolved?.command, 'browser')
  })

  test('an unrecognised command with a known agent id starts that agent', () => {
    const resolved = resolvePersistedAgent('claude', 'my-old-wrapper.ps1', AGENTS)
    assert.equal(resolved?.agent.id, 'claude')
    assert.equal(resolved?.command, 'claude')
  })

  test('an unknown CLI stays custom', () => {
    assert.equal(resolvePersistedAgent('custom', 'aider --model gpt', AGENTS), null)
    assert.equal(resolvePersistedAgent('', 'qwen', AGENTS), null)
  })
})
