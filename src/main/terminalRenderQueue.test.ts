import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { TerminalRenderQueue } from '../renderer/src/lib/terminalRenderQueue.ts'

test('slow xterm parser receives only one bounded chunk at a time', () => {
  const writes: string[] = []
  let parsed!: () => void
  const queue = new TerminalRenderQueue((data, done) => { writes.push(data); parsed = done }, () => {}, 32, 8)
  queue.push('abcdefgh12345678')
  queue.flush()
  queue.flush()
  assert.deepEqual(writes, ['abcdefgh'])
  for (let i = 0; i < 1000; i++) queue.push('0123456789')
  assert.ok(queue.pendingLength <= 32)
  queue.flush()
  assert.equal(writes.length, 1)
  parsed()
  queue.flush()
  assert.ok(writes[1].startsWith('\x18\x1b[0m'))
  assert.ok(writes[1].length <= 8 + 5)
  queue.dispose()
  parsed()
  queue.push('ignored')
  queue.flush()
  assert.equal(queue.pendingLength, 0)
  assert.equal(writes.length, 2)
})

test('restore pauses output and chunk boundaries preserve surrogate pairs', () => {
  const writes: string[] = []
  const queue = new TerminalRenderQueue((data, done) => { writes.push(data); done() }, () => {}, 32, 4)
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
