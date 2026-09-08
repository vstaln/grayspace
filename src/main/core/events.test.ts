import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { fold, replay, rewind, blame, fork, type EventReducer } from './events.ts'
import type { JournalEntry } from './types.ts'

interface NoteState {
  notes: Map<string, { id: string; title: string; content: string; version: number }>
}

const noteReducer: EventReducer<NoteState> = (state, event) => {
  const next = { notes: new Map(state.notes) }
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const id = event.target.slice('note:'.length)

  if (event.type === 'note.create') {
    next.notes.set(id, {
      id,
      title: String(payload.title ?? ''),
      content: String(payload.content ?? ''),
      version: event.version ?? 1
    })
  } else if (event.type === 'note.update') {
    const current = next.notes.get(id)
    if (current) {
      next.notes.set(id, {
        ...current,
        title: typeof payload.title === 'string' ? payload.title : current.title,
        content: typeof payload.content === 'string' ? payload.content : current.content,
        version: event.version ?? current.version + 1
      })
    }
  } else if (event.type === 'note.delete') {
    next.notes.delete(id)
  }
  return next
}

describe('Event Sourcing Core — fold, replay, rewind, blame, fork', () => {
  const events: JournalEntry[] = [
    {
      seq: 1,
      at: 1000,
      phase: 'commit',
      actorId: 'user',
      type: 'note.create',
      target: 'note:n1',
      payload: { title: 'First Note', content: 'Initial text' },
      version: 1
    },
    {
      seq: 2,
      at: 1100,
      phase: 'commit',
      actorId: 'agent-a',
      type: 'note.create',
      target: 'note:n2',
      payload: { title: 'Second Note', content: 'Agent text' },
      version: 1
    },
    {
      seq: 3,
      at: 1200,
      phase: 'commit',
      actorId: 'user',
      type: 'note.update',
      target: 'note:n1',
      payload: { content: 'Human edited text' },
      version: 2
    },
    {
      seq: 4,
      at: 1300,
      phase: 'commit',
      actorId: 'agent-b',
      type: 'note.update',
      target: 'note:n2',
      payload: { title: 'Updated Agent Note' },
      version: 2
    },
    {
      seq: 5,
      at: 1400,
      phase: 'commit',
      actorId: 'user',
      type: 'note.delete',
      target: 'note:n1',
      version: 3
    }
  ]

  test('fold reduces full journal into current state', () => {
    const state = fold(events, noteReducer, { notes: new Map() })
    assert.equal(state.notes.size, 1)
    assert.equal(state.notes.has('n1'), false, 'n1 was deleted in seq 5')
    assert.equal(state.notes.get('n2')?.title, 'Updated Agent Note')
    assert.equal(state.notes.get('n2')?.version, 2)
  })

  test('replay produces identical deterministic state', () => {
    const state1 = fold(events, noteReducer, { notes: new Map() })
    const state2 = replay(events, noteReducer, { notes: new Map() })
    assert.deepEqual(Array.from(state1.notes.entries()), Array.from(state2.notes.entries()))
  })

  test('rewind reconstructs state at any historical sequence', () => {

    const atSeq1 = rewind(1, events, noteReducer, { snapshotSeq: 0, state: { notes: new Map() } })
    assert.equal(atSeq1.notes.size, 1)
    assert.equal(atSeq1.notes.get('n1')?.content, 'Initial text')


    const atSeq3 = rewind(3, events, noteReducer, { snapshotSeq: 0, state: { notes: new Map() } })
    assert.equal(atSeq3.notes.size, 2)
    assert.equal(atSeq3.notes.get('n1')?.content, 'Human edited text')
    assert.equal(atSeq3.notes.get('n2')?.title, 'Second Note')


    const atSeq4 = rewind(4, events, noteReducer, { snapshotSeq: 0, state: { notes: new Map() } })
    assert.equal(atSeq4.notes.size, 2)
    assert.equal(atSeq4.notes.has('n1'), true)
  })

  test('rewind works with snapshot base', () => {

    const snapshotAtSeq2 = {
      snapshotSeq: 2,
      state: {
        notes: new Map([
          ['n1', { id: 'n1', title: 'First Note', content: 'Initial text', version: 1 }],
          ['n2', { id: 'n2', title: 'Second Note', content: 'Agent text', version: 1 }]
        ])
      }
    }
    const atSeq3 = rewind(3, events, noteReducer, snapshotAtSeq2)
    assert.equal(atSeq3.notes.get('n1')?.content, 'Human edited text')
    assert.equal(atSeq3.notes.get('n2')?.title, 'Second Note')
  })

  test('blame retrieves full audit history for a resource', () => {
    const historyN1 = blame('note:n1', events)
    assert.equal(historyN1.length, 3)
    assert.equal(historyN1[0].type, 'note.create')
    assert.equal(historyN1[0].actorId, 'user')
    assert.equal(historyN1[1].type, 'note.update')
    assert.equal(historyN1[1].actorId, 'user')
    assert.equal(historyN1[2].type, 'note.delete')

    const historyN2 = blame('note:n2', events)
    assert.equal(historyN2.length, 2)
    assert.equal(historyN2[0].actorId, 'agent-a')
    assert.equal(historyN2[1].actorId, 'agent-b')
  })

  test('fork branches state without modifying original', () => {
    const original = fold(events.slice(0, 3), noteReducer, { notes: new Map() })
    const forked = fork('branch-1', original, (s) => ({ notes: new Map(s.notes) }))

    assert.equal(forked.notes.size, 2)
    forked.notes.set('n3', { id: 'n3', title: 'Branch note', content: 'branch', version: 1 })

    assert.equal(forked.notes.size, 3)
    assert.equal(original.notes.size, 2, 'original remains unaffected')
  })
})
