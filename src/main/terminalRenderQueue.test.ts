import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { TerminalRenderQueue } from '../renderer/src/lib/terminalRenderQueue.ts'

test('slow xterm parser receives one bounded chunk at a time without losing output', () => {
  const writes: string[] = []
  let parsed!: () => void
  const queue = new TerminalRenderQueue((data, done) => { writes.push(data); parsed = done }, () => {}, 8)
  const burst = 'abcdefgh12345678' + '0123456789'.repeat(1000)
  queue.push(burst)
  queue.flush()
  queue.flush()
  assert.deepEqual(writes, ['abcdefgh'])
  assert.equal(writes.length, 1)
  assert.equal(queue.pendingLength, burst.length - 8)
  while (queue.pendingLength) {
    parsed()
    queue.flush()
  }
  parsed()
  assert.equal(writes.join(''), burst)
  assert.ok(writes.every((chunk) => chunk.length <= 8))
  const writtenBeforeDispose = writes.length
  queue.dispose()
  queue.push('ignored')
  queue.flush()
  assert.equal(queue.pendingLength, 0)
  assert.equal(writes.length, writtenBeforeDispose)
})

test('restore pauses output and chunk boundaries preserve surrogate pairs', () => {
  const writes: string[] = []
  const queue = new TerminalRenderQueue((data, done) => { writes.push(data); done() }, () => {}, 4)
  queue.pause(true)
  queue.push('abc🌍def')
  queue.flush()
  assert.equal(writes.length, 0)
  queue.pause(false)
  while (queue.pendingLength) queue.flush()
  assert.equal(writes.join(''), 'abc🌍def')
  assert.equal(writes[0], 'abc')
  assert.equal(writes[1], '🌍de')
})
