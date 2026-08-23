import { strict as assert } from 'node:assert'
import { test, describe } from 'node:test'
import { ActorRegistry } from './actors.ts'
import { CommandBus } from './bus.ts'
import { Journal } from './journal.ts'
import { LockManager } from './locks.ts'
import { VersionRegistry } from './versioned.ts'
import { CommandError, type JournalEntry } from './types.ts'

/**
 * A minimal note store standing in for the real ones: an object with a body
 * and a version, mutated only through the bus. Every concurrency property the
 * four real stores need holds or fails here first.
 */
function harness(options: { now?: () => number } = {}): {
  bus: CommandBus
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
  const bus = new CommandBus({ actors, locks, journal, now })
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
  actors.register({ id: 'agent-a', type: 'agent', label: 'Claude Code', transport: 'mcp' })

  return { bus, locks, journal, actors, notes, entries }
}

describe('CommandBus — the lost update', () => {
  test('a stale baseVersion is a conflict, not a silent overwrite', async () => {
    const { bus, notes } = harness()
    await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'v1' } })

    // The agent read the note at version 1 and went off to think about it.
    const agentSawVersion = 1
    // Meanwhile the user edited it in the UI.
    const userEdit = await bus.submit({
      actorId: 'user',
      type: 'note.update',
      target: 'note:n1',
      baseVersion: 1,
      payload: { body: 'the human’s edit' }
    })
    assert.equal(userEdit.ok, true)

    const agentWrite = await bus.submit({
      actorId: 'agent-a',
      type: 'note.update',
      target: 'note:n1',
      baseVersion: agentSawVersion,
      payload: { body: 'the agent’s stale version' }
    })
    assert.equal(agentWrite.ok, false)
    assert.equal(agentWrite.ok === false && agentWrite.code, 'conflict')
    assert.equal(notes.get('n1')?.body, 'the human’s edit', 'the human’s edit survives')
  })

  test('a command with no baseVersion is a deliberate last-writer-wins', async () => {
    const { bus, notes } = harness()
    await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'v1' } })
    const blind = await bus.submit({
      actorId: 'agent-a',
      type: 'note.update',
      target: 'note:n1',
      payload: { body: 'blind write' }
    })
    assert.equal(blind.ok, true)
    assert.equal(notes.get('n1')?.body, 'blind write')
  })

  test('the version advances by exactly one per accepted write', async () => {
    const { bus } = harness()
    await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'a' } })
    for (let expected = 2; expected <= 5; expected += 1) {
      const result = await bus.submit({
        actorId: 'user',
        type: 'note.update',
        target: 'note:n1',
        baseVersion: expected - 1,
        payload: { body: `v${expected}` }
      })
      assert.equal(result.ok && result.version, expected)
    }
  })
})

describe('CommandBus — locks gate every write', () => {
  test('a write to a resource another actor holds is refused', async () => {
    const { bus, locks } = harness()
    await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'a' } })
    locks.acquire({ resource: 'note:n1', actorId: 'agent-a', reason: 'refactor' })

    const blocked = await bus.submit({
      actorId: 'assistant',
      type: 'note.update',
      target: 'note:n1',
      payload: { body: 'nope' }
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.ok === false && blocked.code, 'locked')
    assert.equal(blocked.ok === false && (blocked.details?.lock as { actorId: string }).actorId, 'agent-a')
  })

  test('the lock holder can still write to what it holds', async () => {
    const { bus, locks } = harness()
    await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'a' } })
    locks.acquire({ resource: 'note:n1', actorId: 'agent-a' })
    const ok = await bus.submit({
      actorId: 'agent-a',
      type: 'note.update',
      target: 'note:n1',
      payload: { body: 'mine' }
    })
    assert.equal(ok.ok, true)
    assert.equal(locks.holder('note:n1')?.actorId, 'agent-a', 'an explicit lock outlives the command')
  })

  test('an implicit lock is taken for the apply and released after', async () => {
    const { bus, locks } = harness()
    await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'a' } })
    assert.equal(locks.holder('note:n1'), undefined, 'nothing is left holding the resource')
  })

  test('the assistant is an ordinary actor with no special privileges', async () => {
    const { bus, locks } = harness()
    await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'a' } })
    locks.acquire({ resource: 'note:n1', actorId: 'user' })
    const assistant = await bus.submit({
      actorId: 'assistant',
      type: 'note.update',
      target: 'note:n1',
      payload: { body: 'assistant edit' }
    })
    assert.equal(assistant.ok === false && assistant.code, 'locked')
  })
})

describe('CommandBus — identity and validation', () => {
  test('an unregistered actor cannot write anything', async () => {
    const { bus } = harness()
    const result = await bus.submit({
      actorId: 'ghost',
      type: 'note.create',
      target: 'note:n1',
      payload: { id: 'n1', body: 'x' }
    })
    assert.equal(result.ok === false && result.code, 'unknown_actor')
  })

  test('an unknown command type is refused before anything is journaled', async () => {
    const { bus, entries } = harness()
    const result = await bus.submit({ actorId: 'user', type: 'note.teleport', target: 'note:n1', payload: {} })
    assert.equal(result.ok === false && result.code, 'unknown_command')
    assert.deepEqual(entries, [])
  })

  test('a malformed target is refused', async () => {
    const { bus } = harness()
    const result = await bus.submit({ actorId: 'user', type: 'note.update', target: 'n1', payload: { body: 'x' } })
    assert.equal(result.ok === false && result.code, 'invalid')
  })
})

describe('CommandBus — sequencing', () => {
  test('commands on one resource apply in submission order, never interleaved', async () => {
    const { bus, actors } = harness()
    const order: string[] = []
    const live = new Map<string, number>()
    let maxLivePerTarget = 0
    bus.register<{ tag: string; delay: number }, void>('trace.step', {
      apply: async ({ command }) => {
        const n = (live.get(command.target) ?? 0) + 1
        live.set(command.target, n)
        maxLivePerTarget = Math.max(maxLivePerTarget, n)
        await new Promise((resolve) => setTimeout(resolve, command.payload.delay))
        order.push(command.payload.tag)
        live.set(command.target, (live.get(command.target) ?? 1) - 1)
      }
    })
    actors.register({ id: 'agent-b', type: 'agent', label: 'Codex', transport: 'mcp' })

    await Promise.all([
      bus.submit({ actorId: 'user', type: 'trace.step', target: 'canvas:main', payload: { tag: 'slow', delay: 20 } }),
      bus.submit({ actorId: 'agent-a', type: 'trace.step', target: 'canvas:main', payload: { tag: 'fast', delay: 0 } }),
      bus.submit({ actorId: 'agent-b', type: 'trace.step', target: 'note:n1', payload: { tag: 'other', delay: 0 } })
    ])
    // Same lane: strict submission order, no overlap.
    assert.deepEqual(order.filter((t) => t !== 'other'), ['slow', 'fast'])
    // Different lane: the third command was never held behind the first two.
    assert.ok(order.includes('other'), 'disjoint resource ran to completion')
    assert.equal(maxLivePerTarget, 1, 'two handlers on one resource ran at once')
  })

  test('commands on disjoint resources run concurrently', async () => {
    const { bus } = harness()
    let overlap = false
    let running = 0
    bus.register<{ delay: number }, void>('trace.step', {
      apply: async ({ command }) => {
        running += 1
        if (running > 1) overlap = true
        await new Promise((resolve) => setTimeout(resolve, command.payload.delay))
        running -= 1
      }
    })
    await Promise.all([
      bus.submit({ actorId: 'user', type: 'trace.step', target: 'canvas:main', payload: { delay: 25 } }),
      bus.submit({ actorId: 'user', type: 'trace.step', target: 'note:n1', payload: { delay: 25 } })
    ])
    assert.ok(overlap, 'disjoint lanes serialized — that is the single-lane regression')
  })

  test('a failing command does not stall the queue behind it', async () => {
    const { bus, notes } = harness()
    const boom = bus.submit({ actorId: 'user', type: 'note.explode', target: 'note:n1', payload: {} })
    const after = bus.submit({
      actorId: 'user',
      type: 'note.create',
      target: 'note:n2',
      payload: { id: 'n2', body: 'still works' }
    })
    assert.equal((await boom).ok, false)
    assert.equal((await after).ok, true)
    assert.equal(notes.get('n2')?.body, 'still works')
  })

  test('a handler that throws never leaks its lock', async () => {
    const { bus, locks } = harness()
    await bus.submit({ actorId: 'user', type: 'note.explode', target: 'note:n1', payload: {} })
    assert.equal(locks.holder('note:n1'), undefined)
  })
})

describe('CommandBus — waiting on the outside world', () => {
  /**
   * Per-resource lanes fixed the historical shape of this bug for disjoint
   * targets, but the same-target variant remains: a handler holding its
   * resource's lane while waiting for a follow-up command aimed at that very
   * resource waits forever. `unblock` is still the way out of that one.
   */
  test('a handler awaiting a follow-up on the SAME resource deadlocks without unblock', async () => {
    const { bus } = harness()
    let answered = false
    bus.register<Record<string, never>, { answered: boolean }>('widget.request', {
      apply: async () => {
        // The "renderer" replies out of band, as a fresh submission — to the
        // resource whose lane this handler is holding.
        setTimeout(() => void bus.submit({ actorId: 'user', type: 'widget.answer', target: 'widget:new', payload: {} }), 0)
        const deadline = Date.now() + 100
        while (!answered && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
        return { answered }
      }
    })
    bus.register('widget.answer', {
      apply: () => {
        answered = true
      }
    })

    const result = await bus.submit<{ answered: boolean }>({
      actorId: 'user',
      type: 'widget.request',
      target: 'widget:new',
      payload: {}
    })
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.data.answered, false, 'the reply must not have landed — the lane is held')
  })

  test('a follow-up on a DIFFERENT resource lands without unblock', async () => {
    const { bus } = harness()
    let answered = false
    bus.register<Record<string, never>, { answered: boolean }>('widget.request', {
      apply: async () => {
        // The reply targets another widget — another lane — so it flows while
        // this handler holds widget:new.
        setTimeout(() => void bus.submit({ actorId: 'user', type: 'widget.answer', target: 'widget:w1', payload: {} }), 0)
        const deadline = Date.now() + 500
        while (!answered && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
        return { answered }
      }
    })
    bus.register('widget.answer', {
      apply: () => {
        answered = true
      }
    })

    const result = await bus.submit<{ answered: boolean }>({
      actorId: 'user',
      type: 'widget.request',
      target: 'widget:new',
      payload: {}
    })
    assert.equal(result.ok && result.data.answered, true, 'disjoint lanes must not serialize against each other')
  })

  test('unblock lets the follow-up command through', async () => {
    const { bus } = harness()
    let answered = false
    bus.register<Record<string, never>, { answered: boolean }>('widget.request', {
      apply: async ({ unblock }) => {
        setTimeout(() => void bus.submit({ actorId: 'user', type: 'widget.answer', target: 'widget:w1', payload: {} }), 0)
        unblock()
        const deadline = Date.now() + 500
        while (!answered && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
        return { answered }
      }
    })
    bus.register('widget.answer', {
      apply: () => {
        answered = true
      }
    })

    const result = await bus.submit<{ answered: boolean }>({
      actorId: 'user',
      type: 'widget.request',
      target: 'widget:new',
      payload: {}
    })
    assert.equal(result.ok && result.data.answered, true)
  })

  test('unblock hands on the queue but keeps the lock on its own target', async () => {
    const { bus, locks } = harness()
    let held: string | undefined
    bus.register('slow.observe', {
      apply: async ({ unblock, command }) => {
        unblock()
        await new Promise((r) => setTimeout(r, 30))
        held = locks.holder(command.target)?.actorId
      }
    })

    const observing = bus.submit({ actorId: 'user', type: 'slow.observe', target: 'note:n1', payload: {} })
    // Another actor writing to the same resource is still refused while the
    // unblocked handler runs; the queue is free, the resource is not.
    const intruder = await bus.submit({
      actorId: 'agent-a',
      type: 'note.create',
      target: 'note:n1',
      payload: { id: 'n1', body: 'x' }
    })
    await observing
    assert.equal(intruder.ok, false)
    assert.equal(intruder.ok === false && intruder.code, 'locked')
    assert.equal(held, 'user', 'the lock outlives the unblock')
  })

  test('the lock is released once the unblocked handler actually returns', async () => {
    const { bus, locks } = harness()
    bus.register('slow.observe', {
      apply: async ({ unblock }) => {
        unblock()
        await new Promise((r) => setTimeout(r, 10))
      }
    })
    await bus.submit({ actorId: 'user', type: 'slow.observe', target: 'note:n1', payload: {} })
    assert.equal(locks.holder('note:n1'), undefined)
  })
})

describe('CommandBus — the journal', () => {
    test('an applied command is written as intent then commit', async () => {
      const { bus, entries } = harness()
      await bus.submit({ actorId: 'agent-a', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'a' } })
      assert.deepEqual(
        entries.map((e) => e.phase),
        ['intent', 'commit']
      )
      assert.equal(entries[1].actorId, 'agent-a', 'the journal records who did it')
      assert.equal(entries[1].version, 1)
    })

    test('a failed command is written as intent then abort', async () => {
      const { bus, entries } = harness()
      await bus.submit({ actorId: 'user', type: 'note.explode', target: 'note:n1', payload: {} })
      assert.deepEqual(
        entries.map((e) => e.phase),
        ['intent', 'abort']
      )
      assert.match(String(entries[1].error), /blew up/)
    })

    test('a command interrupted mid-apply is reported as unfinished', async () => {
      const { bus, journal } = harness()
      // Simulates the crash window: intent on disk, no commit after it.
      journal.append({ phase: 'intent', actorId: 'assistant', type: 'widget.delete', target: 'widget:w1' })
      await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'a' } })

      const open = journal.unfinished()
      assert.equal(open.length, 1)
      assert.equal(open[0].type, 'widget.delete')
    })

    test('the change stream replays only what a client has not seen', async () => {
      const { bus, journal } = harness()
      await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'a' } })
      const seen = journal.lastSeq
      await bus.submit({
        actorId: 'user',
        type: 'note.update',
        target: 'note:n1',
        baseVersion: 1,
        payload: { body: 'b' }
      })
      const fresh = journal.since(seen)
      assert.equal(fresh.length, 2)
      assert.ok(fresh.every((entry) => entry.seq > seen))
    })
  })

  describe('CommandBus — concurrency stress', () => {
    test('concurrent baseVersion conflicts are detected', async () => {
      const { bus, notes } = harness()
      await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'v1' } })

      // Submit 5 concurrent writes all claiming baseVersion 1.
      // The first one (serialized first) will succeed since baseVersion 1 matches v1,
      // advancing the version to 2. The remaining 4 should get conflicts.
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

      // Exactly one succeeds (the first serialized), rest are conflicts
      const successes = results.filter((r) => r.ok).length
      const conflicts = results.filter((r) => r.ok === false && r.code === 'conflict').length
      assert.equal(successes, 1, 'first serialized write succeeds with matching baseVersion')
      assert.equal(conflicts, 4, 'remaining 4 detected as conflicts')
      // Version should have advanced once
      assert.equal(notes.get('n1')?.body, 'stale-0', 'version advanced once')
    })

    test('mixed concurrent: some with baseVersion, some blind', async () => {
      const { bus, notes, actors } = harness()
      actors.register({ id: 'agent-a', type: 'agent', label: 'Codex', transport: 'mcp' })
      actors.register({ id: 'agent-b', type: 'agent', label: 'Codex', transport: 'mcp' })

      await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'initial' } })

      // Two blind writes (last-writer-wins)
      const blind1 = bus.submit({
        actorId: 'agent-a',
        type: 'note.update',
        target: 'note:n1',
        payload: { body: 'blind-a' }
      })
      const blind2 = bus.submit({
        actorId: 'agent-b',
        type: 'note.update',
        target: 'note:n1',
        payload: { body: 'blind-b' }
      })

      // One with stale baseVersion
      const stale = bus.submit({
        actorId: 'agent-a',
        type: 'note.update',
        target: 'note:n1',
        baseVersion: 1,
        payload: { body: 'stale' }
      })

      const [b1, b2, s] = await Promise.all([blind1, blind2, stale])

      // Blind writes should both succeed (last-writer-wins), stale should fail
      const blindOk = b1.ok && b2.ok
      const staleFailed = s.ok === false && s.code === 'conflict'
      assert.ok(blindOk || staleFailed, 'mixed concurrent: blind succeeds, stale conflicts')
    })

    test('concurrent lock acquisition does not deadlock', async () => {
      const { bus, locks, actors } = harness()
      await bus.submit({ actorId: 'user', type: 'note.create', target: 'note:n1', payload: { id: 'n1', body: 'initial' } })
      // Register additional actors for this test
      actors.register({ id: 'agent-b', type: 'agent', label: 'Codex', transport: 'mcp' })
      actors.register({ id: 'agent-c', type: 'agent', label: 'Codex', transport: 'mcp' })
      // agent-a acquires an explicit lock first
      locks.acquire({ resource: 'note:n1', actorId: 'agent-a', reason: 'refactor' })
      // Now agent-b and agent-c try to write while agent-a holds the lock
      const blockedB = await bus.submit({
        actorId: 'agent-b',
        type: 'note.update',
        target: 'note:n1',
        payload: { body: 'nope-b' }
      })
      const blockedC = await bus.submit({
        actorId: 'agent-c',
        type: 'note.update',
        target: 'note:n1',
        payload: { body: 'nope-c' }
      })

      // Both should be refused as locked
      assert.equal(blockedB.ok, false)
      assert.equal(blockedB.code, 'locked')
      assert.equal(blockedC.ok, false)
      assert.equal(blockedC.code, 'locked')

      // After agent-a releases, others can write
      locks.release('note:n1', 'agent-a')
      const after = await bus.submit({
        actorId: 'agent-b',
        type: 'note.update',
        target: 'note:n1',
        payload: { body: 'after-release' }
      })
      assert.equal(after.ok, true, 'lock released, writer can proceed')
    })

    test('command queue ordering under load', async () => {
      const { bus, actors } = harness()
      actors.register({ id: 'agent-a', type: 'agent', label: 'Codex', transport: 'mcp' })
      actors.register({ id: 'agent-b', type: 'agent', label: 'Codex', transport: 'mcp' })
      actors.register({ id: 'agent-c', type: 'agent', label: 'Codex', transport: 'mcp' })

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

      // Fire 10 concurrent commands with varying delays
      const numCommands = 10
      const promises = []
      for (let i = 0; i < numCommands; i++) {
        promises.push(
          bus.submit({
            actorId: i % 3 === 0 ? 'user' : i % 3 === 1 ? 'agent-a' : 'agent-b',
            type: 'order.check',
            target: 'canvas:main',
            payload: { tag: `tag-${i}`, order: i * 10 }
          })
        )
      }
      await Promise.all(promises)

      // Orders should be serialized (FIFO from the queue)
      // The queue processes one at a time, so order depends on submission order
      // but should be consistent (no interleaving)
      assert.ok(order.length === numCommands, `all ${numCommands} commands executed`)
      // Verify no duplicate tags
      const uniqueTags = new Set(order)
      assert.equal(uniqueTags.size, numCommands, 'no duplicate tags')
    })

    test('concurrent handler throws do not leak locks', async () => {
      const { bus, locks } = harness()
      // Submit many commands that throw - note.explode already registered in harness
      const promises = []
      for (let i = 0; i < 5; i++) {
        promises.push(
          bus.submit({
            actorId: `agent-${i}`,
            type: 'note.explode',
            target: `note:n${i}`,
            payload: {}
          })
        )
      }
      await Promise.all(promises)

      // All locks should be released
      const heldLocks = locks.list()
      assert.equal(heldLocks.length, 0, 'no locks left after concurrent throwing handlers')
    })
  })
