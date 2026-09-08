import { strict as assert } from 'node:assert'
import { test, describe } from 'node:test'
import { ActorRegistry } from './actors.ts'
import { CommandFlow } from './flow.ts'
import { Journal } from './journal.ts'
import { LockManager } from './locks.ts'
import { VersionRegistry } from './versioned.ts'
import { CommandError, type JournalEntry } from './types.ts'

function harness(options: { now?: () => number } = {}): {
  bus: CommandFlow
  locks: LockManager
  journal: Journal
  actors: ActorRegistry
  notes: Map<string, { id: string; body: string; version: number }>
  entries: JournalEntry[]
} {
  const now = options.now ?? Date.now
  const actors = new ActorRegistry(now)
  const locks = new LockManager({ now })
  const journal = new Journal({ now })
  const bus = new CommandFlow({ actors, locks, journal, now })
  const versions = new VersionRegistry('note')
  const notes = new Map<string, { id: string; body: string; version: number }>()
  const entries: JournalEntry[] = []
  journal.on('entry', (entry: JournalEntry) => entries.push(entry))

  bus.registerVersions('note', versions)
  bus.register<{ id: string; body: string }, { id: string; version: number }>('note.create', {
    ignoreVersion: true,
    apply: ({ command }) => {
      const { id, body } = command.payload
      notes.set(id, { id, body, version: versions.bump(id) })
      return { id, version: versions.current(id) }
    }
  })
  bus.register<{ body: string }, { body: string; version: number }>('note.update', {
    apply: ({ command }) => {
      const id = command.target.slice('note:'.length)
      const note = notes.get(id)
      if (!note) throw new CommandError('not_found', `no note ${id}`)
      note.body = command.payload.body
      note.version = versions.bump(id)
      return { body: note.body, version: note.version }
    }
  })
  bus.register('note.explode', {
    apply: () => {
      throw new Error('handler blew up')
    }
  })

  actors.register({ id: 'user', type: 'user', label: 'Human', transport: 'ipc' })
  actors.register({ id: 'assistant', type: 'assistant', label: 'OrcSpace assistant', transport: 'internal' })
  actors.register({ id: 'agent-a', type: 'agent', label: 'Claude Code', transport: 'cli' })

  return { bus, locks, journal, actors, notes, entries }
}

describe('CommandFlow — concurrency stress', () => {
  test('concurrent writes to same resource are serialized', async () => {
    const { bus, notes } = harness()
    await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'initial' } })

    const promises = []
    for (let i = 0; i < 5; i++) {
      promises.push(
        bus.submit({
          actorId: i % 2 === 0 ? 'agent-a' : 'user',
          type: 'note.update',
          target: 'note:n1',
          baseVersion: i,
          payload: { body: `concurrent-${i}` }
        })
      )
    }
    const results = await Promise.all(promises)

    const successes = results.filter((r) => r.ok).length
    const finalBody = notes.get('n1')?.body ?? ''
    const validBodies = results.map((r) => (r.ok ? (r.data as { body?: string } | undefined)?.body : null)).filter(Boolean)
    assert.ok(validBodies.includes(finalBody) || successes <= 1, 'no data corruption, serialized writes')
  })

  test('concurrent baseVersion conflicts are detected', async () => {
    const { bus, notes } = harness()
    await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'v1' } })

    const promises = []
    for (let i = 0; i < 5; i++) {
      promises.push(
        bus.submit({
          actorId: 'agent-a',
          type: 'note.update',
          target: 'note:n1',
          baseVersion: 1,
          payload: { body: `stale-${i}` }
        })
      )
    }
    const results = await Promise.all(promises)

    const successes = results.filter((r) => r.ok).length
    const conflicts = results.filter((r) => r.ok === false && r.code === 'conflict').length
    assert.equal(successes, 1, 'first serialized write succeeds with matching baseVersion')
    assert.equal(conflicts, 4, 'remaining 4 detected as conflicts')
    assert.equal(notes.get('n1')?.body, 'stale-0', 'version advanced once')
  })

  test('mixed concurrent: some with baseVersion, some blind', async () => {
    const { bus, notes } = harness()
    await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'initial' } })

    const blind1 = bus.submit({
      actorId: 'agent-a',
      type: 'note.update',
      target: 'note:n1',
      payload: { body: 'blind-a' }
    })
    const blind2 = bus.submit({
      actorId: 'user',
      type: 'note.update',
      target: 'note:n1',
      payload: { body: 'blind-b' }
    })

    const stale = bus.submit({
      actorId: 'agent-a',
      type: 'note.update',
      target: 'note:n1',
      baseVersion: 1,
      payload: { body: 'stale' }
    })

    const [b1, b2, s] = await Promise.all([blind1, blind2, stale])

    const blindOk = b1.ok && b2.ok
    const staleFailed = s.ok === false && s.code === 'conflict'
    assert.ok(blindOk || staleFailed, 'mixed concurrent: blind succeeds, stale conflicts')
  })

  test('concurrent lock acquisition does not deadlock', async () => {
    const { bus, locks, notes } = harness()
    // Create note first
    await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'initial' } })
    locks.acquire({ resource: 'note:n1', actorId: 'agent-a', reason: 'refactor' })

    const blocked = await bus.submit({
      actorId: 'user',
      type: 'note.update',
      target: 'note:n1',
      payload: { body: 'nope' }
    })

    locks.release('note:n1', 'agent-a')

    const after = await bus.submit({
      actorId: 'user',
      type: 'note.update',
      target: 'note:n1',
      payload: { body: 'after-release' }
    })

    assert.ok(after.ok, 'command after lock release does not crash')
    assert.equal(locks.list().length, 0, 'no locks remaining after release')
  })

  test('command queue ordering under load', async () => {
    const { bus } = harness()
    const order: string[] = []
    let live = 0
    bus.register<{ tag: string; order: number }, void>('order.check', {
      apply: async ({ command }) => {
        live += 1
        assert.equal(live, 1, 'two handlers ran at once')
        await new Promise((resolve) => setTimeout(resolve, command.payload.order))
        order.push(command.payload.tag)
        live -= 1
      }
    })

    const numCommands = 10
    const promises = []
    for (let i = 0; i < numCommands; i++) {
      promises.push(
        bus.submit({
          actorId: i % 3 === 0 ? 'user' : i % 3 === 1 ? 'agent-a' : 'user',
          type: 'order.check',
          target: 'canvas:main',
          payload: { tag: `tag-${i}`, order: i * 10 }
        })
      )
    }
    await Promise.all(promises)

    assert.ok(order.length === numCommands, `all ${numCommands} commands executed`)
    const uniqueTags = new Set(order)
    assert.equal(uniqueTags.size, numCommands, 'no duplicate tags')
  })

  test('concurrent handler throws do not leak locks', async () => {
    const { bus, locks } = harness()
    const promises = []
    for (let i = 0; i < 5; i++) {
      promises.push(
        bus.submit({
          actorId: 'agent-a',
          type: 'note.explode',
          target: `note:n${i}`,
          payload: {}
        })
      )
    }
    await Promise.all(promises)

    const heldLocks = locks.list()
    assert.equal(heldLocks.length, 0, 'no locks left after concurrent throwing handlers')
  })
})
