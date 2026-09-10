import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { TerminalStreamBatcher } from './terminalBatcher.ts'

describe('TerminalStreamBatcher (Frame Batching & High-Throughput Protection)', () => {
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
    assert.ok(Buffer.byteLength(batches[0].chunk, 'utf8') <= 100)
    assert.ok(!/[\ud800-\udbff]$/.test(batches[0].chunk))
    assert.ok(!/^[\udc00-\udfff]/.test(batches[0].chunk))

    batcher.dispose()
  })
})
