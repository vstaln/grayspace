import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { Journal } from './journal.ts'
import type { JournalEntry } from './types.ts'

function entry(seq: number, phase: JournalEntry['phase'] = 'commit'): JournalEntry {
  return { seq, at: seq, phase, actorId: 'assistant', type: 'run.checkpoint', target: 'run:1' }
}

describe('Journal seed', () => {
  test('restart continues sequence from the disk tail and keeps entries queryable', () => {
    const journal = new Journal({
      startSeq: 7,
      seed: [entry(6, 'intent'), entry(7, 'commit')]
    })
    assert.equal(journal.lastSeq, 7)
    assert.equal(journal.recent().length, 2)
    assert.equal(journal.unfinished().length, 0)

    const next = journal.append({
      phase: 'intent',
      actorId: 'user',
      type: 'note.update',
      target: 'note:1'
    })
    assert.equal(next.seq, 8)
  })

  test('two intents of the same command stay unfinished until each commit', () => {
    const journal = new Journal()
    journal.append({ phase: 'intent', actorId: 'assistant', type: 'note.update', target: 'note:1' })
    journal.append({ phase: 'intent', actorId: 'assistant', type: 'note.update', target: 'note:1' })
    journal.append({ phase: 'commit', actorId: 'assistant', type: 'note.update', target: 'note:1' })
    const open = journal.unfinished()
    assert.equal(open.length, 1)
    assert.equal(open[0].seq, 1)
  })

  test('seed with an open intent is visible to unfinished()', () => {
    const journal = new Journal({
      startSeq: 3,
      seed: [entry(2, 'commit'), entry(3, 'intent')]
    })
    const open = journal.unfinished()
    assert.equal(open.length, 1)
    assert.equal(open[0].seq, 3)
  })
})
