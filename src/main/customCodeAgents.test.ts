import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_CUSTOM_CODE_AGENTS, normalizeCustomCodeAgents } from '../shared/customCodeAgents.ts'

describe('custom code agents', () => {
  it('keeps valid named commands and trims whitespace', () => {
    assert.deepEqual(normalizeCustomCodeAgents([
      { id: 'agent_1', name: ' Aider ', command: ' aider --model gpt ' }
    ]), [{ id: 'agent_1', name: 'Aider', command: 'aider --model gpt' }])
  })

  it('drops invalid, duplicate and built-in IDs', () => {
    assert.deepEqual(normalizeCustomCodeAgents([
      { id: 'claude', name: 'Replacement', command: 'other' },
      { id: 'my-agent', name: 'Aider', command: 'aider' },
      { id: 'my-agent', name: 'Duplicate', command: 'duplicate' },
      { id: 'bad\nid', name: 'Broken', command: 'broken' },
      { id: 'empty-command', name: 'No command', command: '  ' },
      { id: 'multiline', name: 'Unsafe', command: 'tool\nnext' }
    ]), [{ id: 'my-agent', name: 'Aider', command: 'aider' }])
  })

  it('caps the list and rejects oversized fields', () => {
    const entries = Array.from({ length: MAX_CUSTOM_CODE_AGENTS + 1 }, (_, index) => ({
      id: `agent-${index}`,
      name: `Agent ${index}`,
      command: 'agent'
    }))
    entries.push({ id: 'oversized', name: 'x'.repeat(41), command: 'agent' })
    assert.equal(normalizeCustomCodeAgents(entries).length, MAX_CUSTOM_CODE_AGENTS)
    assert.deepEqual(normalizeCustomCodeAgents([{ id: 'oversized', name: 'Agent', command: 'x'.repeat(513) }]), [])
  })
})
