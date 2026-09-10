import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { TerminalOutputGate } from './terminalStream.ts'

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('TerminalOutputGate', () => {
  test('paces live output across frames', async () => {
    const batches: string[] = []
    const gate = new TerminalOutputGate((_id, chunk) => batches.push(chunk), {
      intervalMs: 10,
      maxDispatchBytes: 4,
      maxPendingBytes: 1024
    })

    try {
      gate.enqueue('term-1', 'abcdefghijklmno')
      assert.equal(batches.length, 0)
      await waitFor(() => batches.join('').length >= 4)
      assert.equal(batches.join(''), 'abcd')
      await waitFor(() => batches.join('') === 'abcdefghijklmno')
    } finally {
      gate.dispose()
    }
  })

  test('drops oldest output when pending exceeds the cap', async () => {
    const batches: string[] = []
    const gate = new TerminalOutputGate((_id, chunk) => batches.push(chunk), {
      intervalMs: 1000,
      maxDispatchBytes: 4,
      maxPendingBytes: 10
    })

    try {
      gate.enqueue('term-1', 'abcdefghijklmno')
      gate.flush('term-1')
      assert.equal(batches.join(''), 'fghijklmno')
    } finally {
      gate.dispose()
    }
  })

  test('keeps multi-byte characters intact when truncating', async () => {
    const batches: string[] = []
    const gate = new TerminalOutputGate((_id, chunk) => batches.push(chunk), {
      intervalMs: 1000,
      maxDispatchBytes: 1024,
      maxPendingBytes: 8
    })

    try {
      gate.enqueue('term-1', 'abcdef😀gh')
      gate.flush('term-1')
      const out = batches.join('')
      assert.ok(!out.includes('�'))
      assert.equal(Buffer.byteLength(out, 'utf8') <= 8, true)
    } finally {
      gate.dispose()
    }
  })

  test('flushes queued output before an exit marker', () => {
    const batches: string[] = []
    const gate = new TerminalOutputGate((_id, chunk) => batches.push(chunk), { maxDispatchBytes: 2 })
    gate.enqueue('term-1', 'hello')
    gate.flush('term-1')
    assert.equal(batches.join(''), 'hello')
    gate.dispose()
  })
})
