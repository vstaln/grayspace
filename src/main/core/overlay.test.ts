import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { ActorRegistry } from './actors.ts'
import { CommandFlow } from './flow.ts'
import { Journal } from './journal.ts'
import { LockManager } from './locks.ts'
import { VersionRegistry } from './versioned.ts'
import { OverlayManager } from './overlay.ts'
import { CommandError } from './types.ts'

function createOverlayHarness() {
  const actors = new ActorRegistry()
  const locks = new LockManager()
  const journal = new Journal()
  const bus = new CommandFlow({ actors, locks, journal })
  const noteVersions = new VersionRegistry('note')
  const notes = new Map<string, { id: string; body: string; version: number }>()

  bus.registerVersions('note', noteVersions)

  bus.register<{ id: string; body: string }, { id: string; body: string; version: number }>('note.create', {
    ignoreVersion: true,
    apply: ({ command, overlayId }) => {
      const { id, body } = command.payload
      const version = noteVersions.bump(id, overlayId)
      if (!overlayId) notes.set(id, { id, body, version })
      return { id, body, version }
    }
  })

  bus.register<{ body: string }, { id: string; body: string; version: number }>('note.update', {
    apply: ({ command, overlayId }) => {
      const id = command.target.slice('note:'.length)
      const note = notes.get(id)
      if (!note) throw new CommandError('not_found', `no note ${id}`)
      const version = noteVersions.bump(id, overlayId)
      if (!overlayId) {
        note.body = command.payload.body
        note.version = version
      }
      return { id, body: command.payload.body, version }
    }
  })

  actors.register({ id: 'user', type: 'user', label: 'Human', transport: 'ipc' })
  actors.register({ id: 'agent-1', type: 'agent', label: 'Agent 1', transport: 'cli' })

  return { bus, locks, journal, actors, notes, noteVersions }
}

describe('Shadow Store Overlay — VersionRegistry overlay, Dry-Run, Speculation, Discard', () => {
  test('VersionRegistry overlay isolates bumps and reads base + overlay', () => {
    const versions = new VersionRegistry('note')
    versions.seed([{ id: 'n1', version: 5 }])

    assert.equal(versions.current('n1'), 5)


    versions.createOverlay('shadow-1')
    assert.equal(versions.current('n1', 'shadow-1'), 5, 'reads base version initially')


    const shadowV1 = versions.bump('n1', 'shadow-1')
    assert.equal(shadowV1, 6)
    assert.equal(versions.current('n1', 'shadow-1'), 6, 'shadow sees bumped version')
    assert.equal(versions.current('n1'), 5, 'base remains unchanged at version 5')


    versions.commit('shadow-1')
    assert.equal(versions.current('n1'), 6, 'base now reflects committed version')
  })

  test('OverlayManager reads composite state: base + overlay with deletion support', () => {
    const manager = new OverlayManager()
    const overlay = manager.create('overlay-test')

    const baseNote = { id: 'n1', title: 'Base Note', version: 1 }


    assert.deepEqual(manager.readComposite('note:n1', baseNote, 'overlay-test'), baseNote)


    overlay.set('note:n1', { id: 'n1', title: 'Overlaid Note', version: 2 }, 2)
    assert.equal(manager.readComposite('note:n1', baseNote, 'overlay-test')?.title, 'Overlaid Note')


    overlay.delete('note:n1', 3)
    assert.equal(manager.readComposite('note:n1', baseNote, 'overlay-test'), undefined)


    manager.discard('overlay-test')
    assert.deepEqual(manager.readComposite('note:n1', baseNote, 'overlay-test'), baseNote)
  })

  test('Feature 1: Dry-Run executes without mutating persistent base store or main journal', async () => {
    const { bus, notes, journal } = createOverlayHarness()

    await bus.submit({
      actorId: 'user',
      type: 'note.create',
      target: 'note:n1',
      payload: { id: 'n1', body: 'Base version' }
    })

    const initialJournalSeq = journal.lastSeq


    const dryRunResult = await bus.dryRun<{ id: string; body: string; version: number }>({
      actorId: 'user',
      type: 'note.update',
      target: 'note:n1',
      baseVersion: 1,
      payload: { body: 'Hypothetical change' }
    })

    assert.equal(dryRunResult.ok, true)
    assert.equal(dryRunResult.data?.body, 'Hypothetical change')
    assert.equal(dryRunResult.diff.length, 1)
    assert.equal(dryRunResult.diff[0].target, 'note:n1')
    assert.equal(dryRunResult.diff[0].op, 'put')


    assert.equal(notes.get('n1')?.body, 'Base version')
    assert.equal(notes.get('n1')?.version, 1)
    assert.equal(journal.lastSeq, initialJournalSeq, 'no permanent journal entries written')
  })

  test('Feature 2: Speculative parallel execution of two alternative plans', async () => {
    const { bus, notes } = createOverlayHarness()

    await bus.submit({
      actorId: 'user',
      type: 'note.create',
      target: 'note:n1',
      payload: { id: 'n1', body: 'Original text' }
    })


    const speculation = await bus.speculate<{ id: string; body: string; version: number }>({
      'plan-a': [
        {
          actorId: 'agent-1',
          type: 'note.update',
          target: 'note:n1',
          baseVersion: 1,
          payload: { body: 'Plan A: Incremental refactor' }
        }
      ],
      'plan-b': [
        {
          actorId: 'agent-1',
          type: 'note.update',
          target: 'note:n1',
          baseVersion: 1,
          payload: { body: 'Plan B: Clean rewrite' }
        }
      ]
    })

    assert.equal(speculation['plan-a'].ok, true)
    const planAValue = speculation['plan-a'].diff[0].value as { body: string }
    assert.equal(planAValue.body, 'Plan A: Incremental refactor')

    assert.equal(speculation['plan-b'].ok, true)
    const planBValue = speculation['plan-b'].diff[0].value as { body: string }
    assert.equal(planBValue.body, 'Plan B: Clean rewrite')


    assert.equal(notes.get('n1')?.body, 'Original text')
  })

  test('Feature 3: "Try & Rollback" with discard(overlayId) in O(1)', async () => {
    const { bus, noteVersions } = createOverlayHarness()

    const overlayId = 'try-experimental-features'
    const overlay = bus.createOverlay(overlayId)


    const result = await bus.submit<{ id: string; body: string; version: number }>(
      {
        actorId: 'user',
        type: 'note.create',
        target: 'note:experimental',
        payload: { id: 'experimental', body: 'Experimental data' }
      },
      { overlayId }
    )

    assert.equal(result.ok, true)
    assert.equal(overlay.has('note:experimental'), true)
    assert.equal(noteVersions.current('experimental', overlayId), 1)
    assert.equal(noteVersions.current('experimental'), 0)


    const discarded = bus.discardOverlay(overlayId)
    assert.equal(discarded, true)
    assert.equal(bus.hasOverlay(overlayId), false)
    assert.equal(noteVersions.hasOverlay(overlayId), false)
    assert.equal(noteVersions.current('experimental'), 0)
  })
})
