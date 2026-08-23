import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { ActorRegistry } from './actors.ts'
import { CommandBus } from './bus.ts'
import { Journal } from './journal.ts'
import { LockManager } from './locks.ts'
import { VersionRegistry } from './versioned.ts'

describe('Idempotency — Idempotency-Key caching and retry deduplication', () => {
  test('re-submitting command with same idempotency key returns cached result without re-executing', async () => {
    const actors = new ActorRegistry()
    const locks = new LockManager()
    const journal = new Journal()
    const bus = new CommandBus({ actors, locks, journal })
    const noteVersions = new VersionRegistry('note')
    bus.registerVersions('note', noteVersions)

    actors.register({ id: 'agent-1', type: 'agent', label: 'Agent', transport: 'mcp' })

    let executions = 0
    bus.register<{ title: string }, { id: string; version: number }>('note.create', {
      ignoreVersion: true,
      apply: ({ command }) => {
        executions += 1
        return { id: `note-${executions}`, version: noteVersions.bump('n1') }
      }
    })

    const key = 'idem-req-12345'

    // First attempt
    const res1 = await bus.submit({
      idempotencyKey: key,
      actorId: 'agent-1',
      type: 'note.create',
      target: 'note:new',
      payload: { title: 'First' }
    })

    assert.equal(res1.ok, true)
    assert.equal(executions, 1)
    const originalSeq = res1.seq

    // Second attempt with exact same key (e.g. network timeout retry)
    const res2 = await bus.submit({
      idempotencyKey: key,
      actorId: 'agent-1',
      type: 'note.create',
      target: 'note:new',
      payload: { title: 'First' }
    })

    assert.equal(res2.ok, true)
    assert.equal(res2.cached, true)
    assert.equal(res2.seq, originalSeq)
    assert.equal(executions, 1, 'handler must not run a second time')
    assert.equal(journal.lastSeq, 2, 'only 1 intent + 1 commit logged in journal')
  })
})
