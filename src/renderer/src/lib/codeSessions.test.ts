import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { getCodeSessionCount, onCodeSessionCount, setCodeSessionCount } from './codeSessions.ts'

describe('codeSessions', () => {
  test('starts at zero and notifies subscribers on change', () => {
    setCodeSessionCount(0)
    assert.equal(getCodeSessionCount(), 0)
    const seen: number[] = []
    const off = onCodeSessionCount((count) => seen.push(count))
    try {
      // Subscribing delivers the current value immediately, so a sidebar
      // mounting after CodeView announced its count still learns it.
      assert.deepEqual(seen, [0])
      setCodeSessionCount(3)
      assert.equal(getCodeSessionCount(), 3)
      assert.deepEqual(seen, [0, 3])
      // Same value is a no-op: no redundant renders downstream.
      setCodeSessionCount(3)
      assert.deepEqual(seen, [0, 3])
    } finally {
      off()
      setCodeSessionCount(0)
    }
  })

  test('clamps negative and fractional counts', () => {
    const seen: number[] = []
    const off = onCodeSessionCount((count) => seen.push(count))
    try {
      setCodeSessionCount(-4)
      assert.equal(getCodeSessionCount(), 0)
      setCodeSessionCount(2.7)
      assert.equal(getCodeSessionCount(), 2)
      // -4 clamps to the already-current 0, so only the immediate value
      // and the change to 2 are delivered.
      assert.deepEqual(seen, [0, 2])
    } finally {
      off()
      setCodeSessionCount(0)
    }
  })

  test('unsubscribed listeners stop receiving updates', () => {
    setCodeSessionCount(0)
    const seen: number[] = []
    const off = onCodeSessionCount((count) => seen.push(count))
    off()
    setCodeSessionCount(5)
    assert.deepEqual(seen, [0])
    setCodeSessionCount(0)
  })

  test('one throwing subscriber does not stop the others', () => {
    setCodeSessionCount(0)
    const seen: number[] = []
    const bad = onCodeSessionCount(() => { throw new Error('boom') })
    const good = onCodeSessionCount((count) => seen.push(count))
    try {
      setCodeSessionCount(1)
      assert.deepEqual(seen, [0, 1])
    } finally {
      bad()
      good()
      setCodeSessionCount(0)
    }
  })
})
