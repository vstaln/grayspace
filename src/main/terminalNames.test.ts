import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  isDefaultTerminalTitle,
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

  test('randomTerminalName is a lowercase english pair', () => {
    assert.equal(randomTerminalName(() => 0), 'brave-fox')
    assert.match(randomTerminalName(), /^[a-z]+-[a-z]+$/)
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

  test('pickTerminalName falls back to random and then to a suffix', () => {
    const random = pickTerminalName({ favorites: [], taken: [], rand: () => 0 })
    assert.equal(random, 'brave-fox')
    const suffixed = pickTerminalName({ favorites: ['ab'], taken: ['ab', 'brave-fox'], rand: () => 0 })
    assert.equal(suffixed, 'ab-2')
  })
})
