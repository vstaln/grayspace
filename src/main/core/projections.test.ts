import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { Journal } from './journal.ts'
import { ProjectionManager } from './projections.ts'

describe('Materialized Projections over the Journal', () => {
  test('projections update in real-time on journal events for O(1) query', () => {
    const journal = new Journal()
    const projections = new ProjectionManager(journal, { windowMs: 3600_000 })

    // Simulate journal commits
    journal.append({
      phase: 'commit',
      actorId: 'user',
      type: 'note.create',
      target: 'note:n1',
      payload: { title: 'First Note' },
      version: 1
    })

    journal.append({
      phase: 'commit',
      actorId: 'agent-codex',
      type: 'task.create',
      target: 'task:t1',
      payload: { title: 'Task 1' },
      version: 1
    })

    journal.append({
      phase: 'commit',
      actorId: 'user',
      type: 'note.update',
      target: 'note:n1',
      payload: { title: 'First Note Updated' },
      version: 2
    })

    // 1. Resource History Projection
    const n1Hist = projections.resourceHistory('note:n1')
    assert.ok(n1Hist)
    assert.equal(n1Hist.target, 'note:n1')
    assert.equal(n1Hist.commitCount, 2)
    assert.equal(n1Hist.version, 2)
    assert.equal(n1Hist.lastActorId, 'user')

    // 2. Actor Activity Projection
    const userAct = projections.actorStatus('user')
    assert.ok(userAct)
    assert.equal(userAct.commitCount, 2)
    assert.deepEqual(userAct.touchedResources, ['note:n1'])

    const codexAct = projections.actorStatus('agent-codex')
    assert.ok(codexAct)
    assert.equal(codexAct.commitCount, 1)
    assert.deepEqual(codexAct.touchedResources, ['task:t1'])

    // 3. Rolling Recent Digest
    const digest = projections.recentDigest()
    assert.equal(digest.totalCommits, 3)
    assert.equal(digest.byScheme['note'], 2)
    assert.equal(digest.byScheme['task'], 1)
    assert.equal(digest.byActor['user'], 2)
    assert.equal(digest.byActor['agent-codex'], 1)
  })
})
