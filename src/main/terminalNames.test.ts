import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  isDefaultTerminalTitle,
  isAutomaticTerminalName,
  isLegacyNumberedAutomaticTerminalName,
  makeUniqueTitle,
  normalizeTerminalName,
  normalizeTerminalNameList,
  pickTerminalName,
  randomTerminalName
} from './terminalNames.ts'

describe('terminalNames', () => {
  test('normalizeTerminalName accepts English names only', () => {
    assert.equal(normalizeTerminalName('backend'), 'backend')
    assert.equal(normalizeTerminalName('  api-2_x '), 'api-2_x')
    assert.equal(normalizeTerminalName('2fast'), null)
    assert.equal(normalizeTerminalName('my shell'), null)
    assert.equal(normalizeTerminalName('бэк'), null)
    assert.equal(normalizeTerminalName('a'.repeat(33)), null)
    assert.equal(normalizeTerminalName('a'.repeat(32)), 'a'.repeat(32))
    assert.equal(normalizeTerminalName(''), null)
    assert.equal(normalizeTerminalName(42), null)
  })

  test('normalizeTerminalNameList dedupes case-insensitively and caps length', () => {
    assert.deepEqual(normalizeTerminalNameList(['backend', 'Backend', 'nope!', 'api']), ['backend', 'api'])
    assert.deepEqual(normalizeTerminalNameList('backend'), [])
    assert.equal(normalizeTerminalNameList(Array.from({ length: 40 }, (_, i) => `name${i}`)).length, 32)
  })

  test('isDefaultTerminalTitle detects placeholder titles', () => {
    assert.equal(isDefaultTerminalTitle('Terminal 3'), true)
    assert.equal(isDefaultTerminalTitle('Agent Terminal 12'), true)
    assert.equal(isDefaultTerminalTitle('terminal 1'), true)
    assert.equal(isDefaultTerminalTitle('Terminal  7'), true)
    assert.equal(isDefaultTerminalTitle('backend'), false)
    assert.equal(isDefaultTerminalTitle('Terminal X'), false)
    assert.equal(isDefaultTerminalTitle('my Terminal 1 backup'), false)
  })

  test('randomTerminalName is an English male first name', () => {
    assert.equal(randomTerminalName(() => 0), 'James')
    assert.match(randomTerminalName(), /^[A-Z][a-z]+$/)
  })

  test('recognizes names reserved for automatic terminal titles', () => {
    assert.equal(isAutomaticTerminalName('Jonathan'), true)
    assert.equal(isAutomaticTerminalName('jonathan'), true)
    assert.equal(isAutomaticTerminalName('backend'), false)
    assert.equal(isLegacyNumberedAutomaticTerminalName('Jonathan-2'), true)
    assert.equal(isLegacyNumberedAutomaticTerminalName('Jonathan-1'), false)
    assert.equal(isLegacyNumberedAutomaticTerminalName('backend-2'), false)
  })

  test('pickTerminalName prefers the first free favorite', () => {
    assert.equal(pickTerminalName({ favorites: ['backend', 'frontend'], taken: [] }), 'backend')
    assert.equal(pickTerminalName({ favorites: ['backend', 'frontend'], taken: ['BACKEND'] }), 'frontend')
  })

  test('makeUniqueTitle keeps free titles and suffixes taken ones', () => {
    assert.equal(makeUniqueTitle('backend', new Set()), 'backend')
    assert.equal(makeUniqueTitle('backend', new Set(['BACKEND'])), 'backend-2')
    assert.equal(makeUniqueTitle('backend', new Set(['backend', 'backend-2'])), 'backend-3')
    assert.equal(makeUniqueTitle('agent: demo', new Set(['agent: demo'])), 'agent: demo-2')
    const long = makeUniqueTitle('a'.repeat(32), new Set(['a'.repeat(32)]))
    assert.ok(long.length <= 32)
    assert.notEqual(long, 'a'.repeat(32))
  })

  test('pickTerminalName never adds numeric suffixes to automatic names', () => {
    const random = pickTerminalName({ favorites: [], taken: [], rand: () => 0 })
    assert.equal(random, 'James')
    assert.equal(pickTerminalName({ taken: ['JAMES'], rand: () => 0 }), 'Henry')
    const taken: string[] = []
    for (let i = 0; i < 64; i += 1) {
      const name = pickTerminalName({ taken, rand: () => 0 })
      assert.match(name, /^[A-Z][a-z]+$/)
      taken.push(name)
    }
    assert.equal(new Set(taken).size, 64)
    const overflow = pickTerminalName({ taken, rand: () => 0 })
    assert.equal(overflow, 'JamesHenry')
    assert.match(overflow, /^[A-Z][a-z]+[A-Z][a-z]+$/)
    assert.doesNotMatch(overflow, /\d/)
  })
})
