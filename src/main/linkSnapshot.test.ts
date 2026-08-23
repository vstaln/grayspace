import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { buildPresence, buildSnapshot, presenceLeaksSecrets, summarizePlanner } from './linkSnapshot.ts'

describe('linkSnapshot — presence', () => {
  test('names the app and the ports, and never carries a token', () => {
    const presence = buildPresence({ mcpRunning: true, workspaceDir: 'C:\\proj', pid: 42 })
    assert.equal(presence.app, 'orcspace')
    assert.equal(presence.ok, true)
    assert.equal(presence.pid, 42)
    assert.equal(presence.controlPort, 47932)
    assert.equal(presence.mcpPort, 47940)
    assert.equal(presence.mcpUrl, 'http://localhost:47940/mcp')
    assert.equal(presence.mcpRunning, true)
    assert.equal(presence.workspaceDir, 'C:\\proj')
    assert.deepEqual(presenceLeaksSecrets(presence), [])
  })

  test('null workspace is preserved, not stringified', () => {
    const presence = buildPresence({ mcpRunning: false, workspaceDir: null })
    assert.equal(presence.workspaceDir, null)
    assert.equal(presence.mcpRunning, false)
  })

  test('presenceLeaksSecrets finds nested token-like keys', () => {
    assert.deepEqual(presenceLeaksSecrets({ token: 'x' }), ['token'])
    assert.deepEqual(presenceLeaksSecrets({ headers: { a: 1 } }), ['headers'])
    assert.deepEqual(presenceLeaksSecrets({ ok: true }), [])
  })
})

describe('linkSnapshot — planner summary', () => {
  test('counts open / done and unique projects', () => {
    const summary = summarizePlanner([
      { done: false, project: 'A' },
      { done: true, project: 'A' },
      { done: false, project: 'B' },
      { done: false }
    ])
    assert.equal(summary.total, 4)
    assert.equal(summary.open, 3)
    assert.equal(summary.done, 1)
    assert.deepEqual(summary.projects, ['A', 'B'])
  })
})

describe('linkSnapshot — snapshot', () => {
  test('strips deleted notes and omits bodies', () => {
    const snap = buildSnapshot({
      mcpRunning: true,
      workspaceDir: null,
      managerId: 'dash',
      terminals: [{ id: 't1' }],
      widgets: [{ id: 't1', kind: 'terminal' }],
      tasks: [{ id: 'task-1' }],
      locks: [],
      plannerItems: [{ done: false, project: 'x' }],
      brainNotes: [
        { id: 'n1', title: 'Alive', tags: ['a'], updatedAt: 1 },
        { id: 'n2', title: 'Trash', tags: [], updatedAt: 2, deletedAt: 9 }
      ],
      journal: { lastSeq: 3, entries: [{ seq: 3 }] },
      commands: ['widget.create']
    })
    assert.equal(snap.brain.count, 1)
    assert.equal(snap.brain.notes.length, 1)
    assert.equal(snap.brain.notes[0].title, 'Alive')
    assert.equal(snap.planner.summary.total, 1)
    assert.equal(snap.managerId, 'dash')
    assert.deepEqual(presenceLeaksSecrets(snap), [])
  })
})
