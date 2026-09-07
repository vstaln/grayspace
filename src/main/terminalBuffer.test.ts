import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { TerminalRingBuffer } from './terminalBuffer.ts'

describe('TerminalRingBuffer', () => {
  test('appends chunks and tracks global offset correctly', () => {
    const buffer = new TerminalRingBuffer({ maxBytes: 100 })

    buffer.append('hello ')
    assert.equal(buffer.length, 6)
    assert.equal(buffer.globalOffset, 6)

    buffer.append('world\n')
    assert.equal(buffer.length, 12)
    assert.equal(buffer.globalOffset, 12)

    // Incremental read
    const r1 = buffer.read(0)
    assert.equal(r1.data, 'hello world\n')
    assert.equal(r1.newOffset, 12)

    // Reading from latest offset yields empty data
    const r2 = buffer.read(12)
    assert.equal(r2.data, '')
    assert.equal(r2.newOffset, 12)
  })

  test('wraps circular buffer when exceeding maxBytes', () => {
    const buffer = new TerminalRingBuffer({ maxBytes: 15 })

    buffer.append('1234567890') // 10 bytes
    buffer.append('abcdefghij') // 10 bytes -> total 20 > 100 limit, pops first chunk

    assert.equal(buffer.toString(), 'abcdefghij')
    assert.equal(buffer.globalOffset, 20)

    // Reading from offset 0 starts at remaining buffer
    const readAll = buffer.read(0)
    assert.equal(readAll.data, 'abcdefghij')
  })

  test('enforces the budget in UTF-8 bytes for non-ASCII output', () => {
    const buffer = new TerminalRingBuffer({ maxBytes: 10 })
    buffer.append('😀😀😀')
    assert.ok(buffer.length <= 10)
    assert.equal(buffer.toString(), '😀😀')

    const first = buffer.read(0, 4)
    assert.equal(first.data, '😀')
    // The first retained emoji begins at global byte offset 4; a reader that
    // fell behind is advanced past that prefix as well as the returned data.
    assert.equal(first.newOffset, 8)
    const second = buffer.read(first.newOffset, 4)
    assert.equal(second.data, '😀')
    assert.equal(second.newOffset, 12)
  })

  test('tail returns the last bytes without ever joining the full buffer', () => {
    const buffer = new TerminalRingBuffer({ maxBytes: 10_000 })
    for (let i = 0; i < 50; i += 1) buffer.append(`line-${i.toString().padStart(2, '0')}\n`)
    const tail = buffer.tail(80)
    assert.equal(tail.endsWith('line-49\n'), true)
    // Sanity: asking for more than the buffer holds returns everything.
    assert.equal(buffer.tail(buffer.length + 1000), buffer.toString())
    assert.equal(buffer.tail(0), '')
  })

  test('tail respects UTF-8 boundaries when slicing the last chunk', () => {
    const buffer = new TerminalRingBuffer({ maxBytes: 100 })
    buffer.append('aaaa')
    buffer.append('😀😀😀😀')
    // The last 8 bytes are 2 emoji (4 bytes each).
    assert.equal(buffer.tail(8), '😀😀')
    // Asking for 5 must NOT split the emoji — the implementation walks back to
    // the last code-point boundary, so we get one full emoji instead of a
    // replacement char.
    const sliced = buffer.tail(5)
    assert.equal(sliced.includes('\uFFFD'), false)
    assert.equal(sliced, '😀')
  })
})
