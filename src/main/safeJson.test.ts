import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { safeParseJson, sanitizeParsed } from './safeJson.ts'

describe('safeParseJson — prototype-pollution defense', () => {
  test('rejects poisoned __proto__ keys without polluting Object.prototype', () => {

    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined)
    const input = JSON.stringify({ a: 1, __proto__: { polluted: 'yes' } })
    const parsed = safeParseJson<Record<string, unknown>>(input)
    assert.ok(parsed)
    assert.equal(parsed?.a, 1)


    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined)
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
  })

  test('rejects poisoned constructor keys', () => {
    const input = JSON.stringify({ constructor: { prototype: { pwn: true } } })
    const parsed = safeParseJson<Record<string, unknown>>(input)
    assert.ok(parsed)
    assert.equal((Object.prototype as Record<string, unknown>).pwn, undefined)
  })

  test('rejects nested poisoned values', () => {
    const input = JSON.stringify({ outer: { inner: { __proto__: { leaked: 'x' } } } })
    const parsed = safeParseJson<{ outer: { inner: Record<string, unknown> } }>(input)
    assert.ok(parsed)
    assert.equal((Object.prototype as Record<string, unknown>).leaked, undefined)
  })

  test('rejects poisoned entries inside arrays', () => {
    const input = JSON.stringify([{ __proto__: { arrPwn: 1 } }, { safe: 2 }])
    const parsed = safeParseJson<Array<Record<string, unknown>>>(input)
    assert.ok(parsed)
    assert.equal(parsed?.length, 2)
    assert.equal(parsed?.[1].safe, 2)
    assert.equal((Object.prototype as Record<string, unknown>).arrPwn, undefined)
  })

  test('preserves well-formed primitives and deep data', () => {
    const input = JSON.stringify({ name: 'a', count: 3, ok: true, list: [1, 2, 3] })
    const parsed = safeParseJson<Record<string, unknown>>(input)
    assert.deepEqual(parsed, { name: 'a', count: 3, ok: true, list: [1, 2, 3] })
  })

  test('returns null on garbage input instead of throwing', () => {
    assert.equal(safeParseJson('not json'), null)
    assert.equal(safeParseJson(''), null)
    assert.equal(safeParseJson(undefined as unknown as string), null)
  })

  test('sanitizeParsed neutralizes already-parsed data', () => {


    const target: Record<string, unknown> = {}
    const polluted = JSON.parse('{"__proto__":{"stillHere":42}}')
    Object.assign(target, polluted)
    sanitizeParsed(target)
    assert.equal((Object.prototype as Record<string, unknown>).stillHere, undefined)
  })
})
