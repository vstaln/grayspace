import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { initialCommandVerdict } from './initialCommandGate.ts'

describe('initial command gate', () => {
  it('types into a shell that is waiting at its prompt', () => {
    assert.equal(initialCommandVerdict({ live: true, bufferType: 'normal' }), 'type')
  })

  it('leaves a live agent alone', () => {
    // The window reloaded, the pty kept running, and the command would land in
    // the agent's composer as text.
    assert.equal(initialCommandVerdict({ live: true, bufferType: 'alternate' }), 'already-running')
  })

  it('leaves a live terminal alone once something is tracking the mouse', () => {
    // The history rotated past the alternate-screen switch, but the TUI's
    // mouse reporting is still in the replayed tail.
    assert.equal(
      initialCommandVerdict({ live: true, bufferType: 'normal', mouseTracking: 'any' }),
      'already-running'
    )
    assert.equal(
      initialCommandVerdict({ live: true, bufferType: 'normal', mouseTracking: 'none' }),
      'type'
    )
  })

  it('always types into a fresh shell, whatever replayed history left behind', () => {
    assert.equal(initialCommandVerdict({ live: false, bufferType: 'alternate' }), 'type')
    assert.equal(initialCommandVerdict({ live: false, bufferType: 'normal' }), 'type')
    assert.equal(
      initialCommandVerdict({ live: false, bufferType: 'alternate', mouseTracking: 'any' }),
      'type'
    )
  })
})
