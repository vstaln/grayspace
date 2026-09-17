import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { TerminalStreamBatcher } from './terminalBatcher.ts'

describe('TerminalStreamBatcher (Frame Batching & High-Throughput Protection)', () => {
  test('default delivery coalesces one I/O turn without waiting for a frame timer', async () => {
    const batcher = new TerminalStreamBatcher()
    const batches: string[] = []
    batcher.on('batch', (_id, chunk) => batches.push(chunk))
    batcher.push('input', 'a')
    batcher.push('input', 'b')
    assert.deepEqual(batches, [])
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(batches, ['ab'])
    batcher.push('input', 'discarded')
    batcher.dispose()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(batches, ['ab'])
  })
  test('batches micro-chunks into single consolidated frame dispatch', async () => {
    const batcher = new TerminalStreamBatcher({ frameIntervalMs: 20 })
    const batches: Array<{ id: string; chunk: string }> = []

    batcher.on('batch', (id, chunk) => {
      batches.push({ id, chunk })
    })


    for (let i = 0; i < 50; i += 1) {
      batcher.push('term-1', `chunk-${i}; `)
    }


    assert.equal(batches.length, 0)


    await new Promise((r) => setTimeout(r, 40))

    assert.equal(batches.length, 1)
    assert.equal(batches[0].id, 'term-1')
    assert.ok(batches[0].chunk.startsWith('chunk-0;'))
    assert.ok(batches[0].chunk.includes('chunk-49;'))

    batcher.dispose()
  })

  test('immediately flushes when batch threshold size is exceeded', () => {
    const batcher = new TerminalStreamBatcher({ maxBatchBytes: 100 })
    const batches: Array<{ id: string; chunk: string }> = []

    batcher.on('batch', (id, chunk) => {
      batches.push({ id, chunk })
    })


    batcher.push('term-2', 'A'.repeat(60))
    assert.equal(batches.length, 0)

    batcher.push('term-2', 'B'.repeat(60))
    assert.equal(batches.length, 1)
    assert.equal(batches[0].chunk.length, 120)

    batcher.dispose()
  })

  test('accounts multibyte output in bytes without splitting surrogates', () => {
    const batcher = new TerminalStreamBatcher({ frameIntervalMs: 10_000, maxBatchBytes: 1_000_000, maxPendingBytes: 100 })
    const batches: Array<{ id: string; chunk: string }> = []
    batcher.on('batch', (id, chunk) => {
      batches.push({ id, chunk })
    })

    batcher.push('term-3', '😀'.repeat(100))
    batcher.flush('term-3')
    assert.equal(batches.length, 1)
    const prefix = '\x18\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l' +
      '\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2026l\x1b[?25h\x1b[0m'
    const payload = batches[0].chunk.startsWith(prefix) ? batches[0].chunk.slice(prefix.length) : batches[0].chunk
    assert.ok(Buffer.byteLength(payload, 'utf8') <= 100)
    assert.ok(!/[\ud800-\udbff]$/.test(payload))
    assert.ok(!/^[\udc00-\udfff]/.test(payload))

    batcher.dispose()
  })

  test('prefixes a resync marker when pressure drops the oldest chunks', () => {
    const batcher = new TerminalStreamBatcher({ frameIntervalMs: 10_000, maxBatchBytes: 1_000_000, maxPendingBytes: 10 })
    const batches: Array<{ id: string; chunk: string }> = []
    batcher.on('batch', (id, chunk) => {
      batches.push({ id, chunk })
    })

    batcher.push('term-9', 'aaaaaaaaaa')
    batcher.push('term-9', 'bbbbbbbbbb')
    batcher.flush('term-9')

    assert.equal(batches.length, 1)
    assert.ok(batches[0].chunk.startsWith('\x18\x1b[?9l\x1b[?1000l'))
    assert.ok(batches[0].chunk.includes('\x1b[?1006l'))
    assert.ok(batches[0].chunk.includes('\x1b[?2026l'))
    assert.ok(batches[0].chunk.includes('bbbbbbbbbb'))
    assert.ok(!batches[0].chunk.includes('a'))

    batcher.dispose()
  })

  test('emits no resync marker when nothing was dropped', () => {
    const batcher = new TerminalStreamBatcher({ frameIntervalMs: 10_000 })
    const batches: Array<{ id: string; chunk: string }> = []
    batcher.on('batch', (id, chunk) => {
      batches.push({ id, chunk })
    })

    batcher.push('term-10', 'hello')
    batcher.flush('term-10')

    assert.equal(batches.length, 1)
    assert.equal(batches[0].chunk, 'hello')

    batcher.dispose()
  })
})
