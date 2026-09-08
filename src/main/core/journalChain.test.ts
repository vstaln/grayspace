import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { Journal } from './journal.ts'

describe('Journal Cryptographic Hash-Chain (Tamper-Evidence)', () => {
  test('generates cryptographic hash-chain across all entries', () => {
    const journal = new Journal()

    const e1 = journal.append({
      phase: 'commit',
      actorId: 'user',
      type: 'note.create',
      target: 'note:n1',
      payload: { title: 'First' }
    })

    const e2 = journal.append({
      phase: 'commit',
      actorId: 'user',
      type: 'note.update',
      target: 'note:n1',
      payload: { title: 'Second' }
    })

    assert.ok(e1.hash)
    assert.ok(e2.hash)
    assert.equal(e2.prevHash, e1.hash)


    const verification = journal.verifyIntegrity()
    assert.equal(verification.valid, true)
    assert.equal(verification.totalEntries, 2)
  })

  test('detects tampered payload in journal chain', () => {
    const journal = new Journal()

    journal.append({ phase: 'commit', actorId: 'user', type: 'note.create', target: 'note:n1', payload: { v: 1 } })
    journal.append({ phase: 'commit', actorId: 'user', type: 'note.update', target: 'note:n1', payload: { v: 2 } })

    const entries = journal.all()
    const firstPayload = entries[0].payload as { v: number }
    firstPayload.v = 999

    const verification = journal.verifyIntegrity(entries)
    assert.equal(verification.valid, false)
    assert.equal(verification.brokenSeq, 1)
  })
})
