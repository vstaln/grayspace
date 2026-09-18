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


    const r1 = buffer.read(0)
    assert.equal(r1.data, 'hello world\n')
    assert.equal(r1.newOffset, 12)


    const r2 = buffer.read(12)
    assert.equal(r2.data, '')
    assert.equal(r2.newOffset, 12)
  })

  test('wraps circular buffer when exceeding maxBytes', () => {
    const buffer = new TerminalRingBuffer({ maxBytes: 15 })

    buffer.append('1234567890')
    buffer.append('abcdefghij')

    assert.equal(buffer.toString(), 'abcdefghij')
    assert.equal(buffer.globalOffset, 20)


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

    assert.equal(buffer.tail(buffer.length + 1000), buffer.toString())
    assert.equal(buffer.tail(0), '')
  })

  test('tail respects UTF-8 boundaries when slicing the last chunk', () => {
    const buffer = new TerminalRingBuffer({ maxBytes: 100 })
    buffer.append('aaaa')
    buffer.append('😀😀😀😀')

    assert.equal(buffer.tail(8), '😀😀')



    const sliced = buffer.tail(5)
    assert.equal(sliced.includes('\uFFFD'), false)
    assert.equal(sliced, '😀')
  })

  test('compacts tiny chunks without changing bytes or offsets', () => {
    const buffer = new TerminalRingBuffer({ maxBytes: 100_000 })
    for (let i = 0; i < 5000; i += 1) buffer.append('x')

    assert.equal(buffer.length, 5000)
    assert.equal(buffer.globalOffset, 5000)
    assert.equal(buffer.toString(), 'x'.repeat(5000))

    const mid = buffer.read(2500, 10)
    assert.equal(mid.data, 'x'.repeat(10))
    assert.equal(mid.newOffset, 2510)

    const all = buffer.read(0, 100_000)
    assert.equal(all.data, 'x'.repeat(5000))
    assert.equal(all.newOffset, 5000)
  })

  test('always advances, even when the budget is smaller than one character', () => {
    // A budget that cannot fit the next character used to return no bytes and
    // the offset it was given, so a caller paging through the buffer spun
    // forever. Overshooting by one character is the only answer that moves.
    for (const [text, size] of [['\u{1F4A5}ok', 4], ['\u65E5ok', 3], ['\u0451ok', 2]] as const) {
      for (let budget = 1; budget <= size; budget += 1) {
        const buffer = new TerminalRingBuffer({ maxBytes: 1024 })
        buffer.append(text)
        const read = buffer.read(0, budget)
        const label = `budget ${budget} against a ${size}-byte character`
        assert.equal(read.data, [...text][0], label)
        assert.equal(read.newOffset, size, label)
      }
    }
  })

  test('paging with a one-byte budget reconstructs the whole buffer', () => {
    const buffer = new TerminalRingBuffer({ maxBytes: 4096 })
    buffer.append('a\u0451\u65E5\u{1F4A5}b')
    let offset = buffer.startOffset
    let assembled = ''
    let guard = 0
    while (offset < buffer.globalOffset) {
      assert.ok(++guard < 100, 'read made no progress')
      const read = buffer.read(offset, 1)
      assert.ok(read.newOffset > offset)
      assembled += read.data
      offset = read.newOffset
    }
    assert.equal(assembled, buffer.toString())
  })
})
