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
})
