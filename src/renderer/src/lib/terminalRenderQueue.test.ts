import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { TerminalRenderQueue } from './terminalRenderQueue.ts'

/**
 * A harness that never auto-completes a write, so a test decides exactly when
 * the parser reports back. That ordering is the whole contract here: the queue
 * hands xterm one chunk per scheduled frame and must not start the next until
 * the previous one is done.
 */
function harness(limit?: number, chunkSize?: number) {
  const writes: string[] = []
  let pendingDone: (() => void) | null = null
  let scheduled = 0
  const queue = new TerminalRenderQueue(
    (data, done) => {
      writes.push(data)
      pendingDone = done
    },
    () => {
      scheduled += 1
    },
    limit,
    chunkSize
  )
  return {
    queue,
    writes,
    get scheduled() {
      return scheduled
    },
    /** Report the in-flight write as parsed, the way xterm's callback does. */
    complete(): void {
      const done = pendingDone
      pendingDone = null
      done?.()
    }
  }
}

describe('TerminalRenderQueue', () => {
  test('output is delivered in order, one chunk per flush', () => {
    const h = harness(1024, 4)
    h.queue.push('abcdefghij')
    h.queue.flush()
    assert.deepStrictEqual(h.writes, ['abcd'])

    h.complete()
    h.queue.flush()
    assert.deepStrictEqual(h.writes, ['abcd', 'efgh'])

    h.complete()
    h.queue.flush()
    assert.deepStrictEqual(h.writes.join(''), 'abcdefghij')
  })

  test('a second flush is refused while the parser still owns the first chunk', () => {
    const h = harness(1024, 4)
    h.queue.push('abcdefgh')
    h.queue.flush()
    h.queue.flush()
    assert.deepStrictEqual(h.writes, ['abcd'], 'writing again before done would reorder output')
  })

  test('a completed write asks for another frame only while data is left', () => {
    const h = harness(1024, 4)
    h.queue.push('abcd')
    h.queue.flush()
    const before = h.scheduled
    h.complete()
    assert.equal(h.scheduled, before, 'the queue drained, so nothing more to schedule')
  })

  test('nothing is written while paused, and resuming asks for a frame', () => {
    const h = harness(1024, 4)
    h.queue.pause(true)
    h.queue.push('abcd')
    h.queue.flush()
    assert.deepStrictEqual(h.writes, [])

    h.queue.pause(false)
    h.queue.flush()
    assert.deepStrictEqual(h.writes, ['abcd'])
  })

  test('overflowing the backlog drops the oldest bytes and marks the resync once', () => {
    const h = harness(8, 64)
    h.queue.push('aaaaaaaa')
    h.queue.push('bbbbbbbb')
    h.queue.flush()

    const RESYNC = '\x18\x1b[0m'
    const written = h.writes[0]
    assert.ok(written.startsWith(RESYNC), 'a drop must announce itself so a halved sequence cannot bleed')
    assert.equal(written.slice(RESYNC.length), 'bbbbbbbb', 'the newest output is what survives')

    h.complete()
    h.queue.push('cc')
    h.queue.flush()
    assert.equal(h.writes[1], 'cc', 'the marker belongs to the drop, not to every later write')
  })

  test('a surrogate pair is never split across two chunks', () => {
    // Four astral characters, two UTF-16 units each. A chunkSize that lands
    // mid-pair must back off rather than emit a lone high surrogate.
    const h = harness(1024, 3)
    h.queue.push('😀😀😀😀')
    h.queue.flush()
    assert.equal(h.writes[0], '😀', 'a 3-unit budget may only carry one whole pair')
    assert.ok(!/[\uD800-\uDBFF]$/.test(h.writes[0]), 'a trailing high surrogate would render as a replacement char')
  })

  test('a disposed queue accepts nothing further', () => {
    const h = harness(1024, 4)
    h.queue.push('abcd')
    h.queue.dispose()
    h.queue.flush()
    h.queue.push('efgh')
    h.queue.flush()
    assert.deepStrictEqual(h.writes, [], 'the widget is gone; writing into its terminal would throw')
  })

  test('a throwing parser clears the backlog instead of wedging the queue', () => {
    const writes: string[] = []
    let fail = true
    const queue = new TerminalRenderQueue(
      (data, done) => {
        if (fail) throw new Error('parser exploded')
        writes.push(data)
        done()
      },
      () => {},
      1024,
      4
    )
    queue.push('abcd')
    queue.flush()
    assert.deepStrictEqual(writes, [])

    // busy must have been released, or nothing would ever be written again.
    fail = false
    queue.push('efgh')
    queue.flush()
    assert.deepStrictEqual(writes, ['efgh'])
  })
})
