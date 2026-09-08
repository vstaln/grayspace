import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { ActorRegistry } from './actors.ts'
import { CommandFlow } from './flow.ts'
import { Journal } from './journal.ts'
import { LockManager } from './locks.ts'
import { VersionRegistry } from './versioned.ts'
import { CommandError, type JournalEntry } from './types.ts'

function createTransactionHarness() {
  const actors = new ActorRegistry()
  const locks = new LockManager()
  const journal = new Journal()
  const bus = new CommandFlow({ actors, locks, journal })
  const noteVersions = new VersionRegistry('note')
  const taskVersions = new VersionRegistry('task')

  const notes = new Map<string, { id: string; body: string; version: number }>()
  const tasks = new Map<string, { id: string; title: string; version: number }>()
  const entries: JournalEntry[] = []
  journal.on('entry', (e) => entries.push(e))

  bus.registerVersions('note', noteVersions)
  bus.registerVersions('task', taskVersions)

  bus.register<{ id: string; body: string }, { id: string; version: number }>('note.create', {
    ignoreVersion: true,
    apply: ({ command }) => {
      const { id, body } = command.payload
      notes.set(id, { id, body, version: noteVersions.bump(id) })
      return { id, version: noteVersions.current(id) }
    }
  })

  bus.register<{ body: string }, { id: string; body: string; version: number }>('note.update', {
    apply: ({ command }) => {
      const id = command.target.slice('note:'.length)
      const note = notes.get(id)
      if (!note) throw new CommandError('not_found', `no note ${id}`)
      note.body = command.payload.body
      note.version = noteVersions.bump(id)
      return { id, body: note.body, version: note.version }
    }
  })

  bus.register<{ id: string; title: string }, { id: string; version: number }>('task.create', {
    ignoreVersion: true,
    apply: ({ command }) => {
      const { id, title } = command.payload
      tasks.set(id, { id, title, version: taskVersions.bump(id) })
      return { id, version: taskVersions.current(id) }
    }
  })

  bus.register('note.fail_step', {
    apply: () => {
      throw new CommandError('invalid', 'step failed intentionally')
    }
  })

  actors.register({ id: 'user', type: 'user', label: 'Human', transport: 'ipc' })
  actors.register({ id: 'agent-1', type: 'agent', label: 'Agent 1', transport: 'cli' })
  actors.register({ id: 'agent-2', type: 'agent', label: 'Agent 2', transport: 'cli' })

  return { bus, locks, journal, actors, notes, tasks, entries, noteVersions, taskVersions }
}

describe('CommandFlow — flow.transact (Multi-step atomic transactions)', () => {
  test('executes multi-command plan atomically and produces single journal commit', async () => {
    const { bus, notes, tasks, entries } = createTransactionHarness()

    const txRes = await bus.transact([
      {
        actorId: 'user',
        type: 'note.create',
        target: 'note:n1',
        payload: { id: 'n1', body: 'Specification' }
      },
      {
        actorId: 'user',
        type: 'task.create',
        target: 'task:t1',
        payload: { id: 't1', title: 'Implement Spec' }
      },
      {
        actorId: 'user',
        type: 'note.update',
        target: 'note:n1',
        baseVersion: 1,
        payload: { body: 'Specification linked to task t1' }
      }
    ])

    assert.equal(txRes.ok, true)
    assert.equal(notes.get('n1')?.body, 'Specification linked to task t1')
    assert.equal(notes.get('n1')?.version, 2)
    assert.equal(tasks.get('t1')?.title, 'Implement Spec')

    // Single intent and commit in journal for the transaction
    assert.equal(entries.length, 2)
    assert.equal(entries[0].phase, 'intent')
    assert.equal(entries[0].type, 'flow.transact')
    assert.equal(entries[1].phase, 'commit')
    assert.equal(entries[1].type, 'flow.transact')
  })

  test('all-or-nothing rollback when a step fails mid-plan', async () => {
    const { bus, notes, entries, locks } = createTransactionHarness()

    // Step 1 would create note n1, but step 2 fails
    const txRes = await bus.transact([
      {
        actorId: 'agent-1',
        type: 'note.create',
        target: 'note:n1',
        payload: { id: 'n1', body: 'Draft' }
      },
      {
        actorId: 'agent-1',
        type: 'note.fail_step',
        target: 'note:n1',
        payload: {}
      }
    ])

    assert.equal(txRes.ok, false)
    assert.equal(txRes.code, 'invalid')
    assert.equal(txRes.message, 'step failed intentionally')

    // Journal records abort
    const abortEntry = entries.find((e) => e.phase === 'abort')
    assert.ok(abortEntry)
    assert.equal(abortEntry.type, 'flow.transact')

    // Locks are fully released
    assert.equal(locks.holder('note:n1'), undefined)
  })

  test('pre-execution version conflict rejects entire transaction before any command runs', async () => {
    const { bus, notes, entries } = createTransactionHarness()

    await bus.submit({
      actorId: 'user',
      type: 'note.create',
      target: 'note:n1',
      payload: { id: 'n1', body: 'v1' }
    })

    // Transaction expects note:n1 to be at baseVersion 99 (stale)
    const txRes = await bus.transact([
      {
        actorId: 'user',
        type: 'task.create',
        target: 'task:t1',
        payload: { id: 't1', title: 'Task 1' }
      },
      {
        actorId: 'user',
        type: 'note.update',
        target: 'note:n1',
        baseVersion: 99,
        payload: { body: 'Updated' }
      }
    ])

    assert.equal(txRes.ok, false)
    assert.equal(txRes.code, 'conflict')
    // No task t1 created because pre-check failed
    const taskFound = entries.some((e) => e.type === 'task.create' && e.phase === 'commit')
    assert.equal(taskFound, false)
  })

  test('pre-execution lock conflict rejects entire transaction if any target is held by another actor', async () => {
    const { bus, locks } = createTransactionHarness()

    // Agent 2 holds task:t1
    locks.acquire({ resource: 'task:t1', actorId: 'agent-2', reason: 'working' })

    const txRes = await bus.transact([
      {
        actorId: 'agent-1',
        type: 'note.create',
        target: 'note:n1',
        payload: { id: 'n1', body: 'Note' }
      },
      {
        actorId: 'agent-1',
        type: 'task.create',
        target: 'task:t1',
        payload: { id: 't1', title: 'Conflict' }
      }
    ])

    assert.equal(txRes.ok, false)
    assert.equal(txRes.code, 'locked')
    assert.equal(locks.holder('note:n1'), undefined, 'no locks leaked for unheld targets')
  })

  test('transactions and single commands serialize cleanly in turn order', async () => {
    const { bus, notes } = createTransactionHarness()

    const order: string[] = []

    const p1 = bus.transact([
      {
        actorId: 'user',
        type: 'note.create',
        target: 'note:n1',
        payload: { id: 'n1', body: 'tx-1' }
      }
    ]).then(() => order.push('tx-1'))

    const p2 = bus.submit({
      actorId: 'user',
      type: 'note.update',
      target: 'note:n1',
      baseVersion: 1,
      payload: { body: 'submit-2' }
    }).then(() => order.push('submit-2'))

    const p3 = bus.transact([
      {
        actorId: 'user',
        type: 'note.update',
        target: 'note:n1',
        baseVersion: 2,
        payload: { body: 'tx-3' }
      }
    ]).then(() => order.push('tx-3'))

    await Promise.all([p1, p2, p3])
    assert.deepEqual(order, ['tx-1', 'submit-2', 'tx-3'])
    assert.equal(notes.get('n1')?.body, 'tx-3')
    assert.equal(notes.get('n1')?.version, 3)
  })
})
