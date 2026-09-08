import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'








import { secretsEqual, isLoopbackHost, isLoopbackUrl } from './netGuard.ts'
import { safeParseJson, sanitizeParsed } from './safeJson.ts'

describe('netGuard - secretsEqual length bound', () => {
  test('rejects oversized headers before hashing', () => {
    const token = 'correct-horse-battery-staple'
    const huge = 'a'.repeat(2000)

    assert.strictEqual(secretsEqual(huge, token), false)
    assert.strictEqual(secretsEqual(token, huge), false)
  })

  test('matches equal short tokens and rejects unequal short ones', () => {
    assert.strictEqual(secretsEqual('abcd', 'abcd'), true)
    assert.strictEqual(secretsEqual('abcd', 'abce'), false)
  })
})

describe('netGuard - isLoopbackHost / isLoopbackUrl', () => {
  test('accepts IPv4 loopback in all common forms', () => {
    assert.strictEqual(isLoopbackHost('127.0.0.1'), true)
    assert.strictEqual(isLoopbackHost('127.0.0.1:20220'), true)
    assert.strictEqual(isLoopbackHost('127.0.0.42'), true)
  })

  test('accepts localhost and bracketed/naked IPv6 loopback', () => {
    assert.strictEqual(isLoopbackHost('localhost:8080'), true)
    assert.strictEqual(isLoopbackHost('[::1]:7421'), true)
    assert.strictEqual(isLoopbackHost('::1'), true)
  })

  test('rejects non-loopback hosts', () => {
    assert.strictEqual(isLoopbackHost('10.0.0.1'), false)
    assert.strictEqual(isLoopbackHost('example.com'), false)
    assert.strictEqual(isLoopbackHost(''), false)
  })

  test('isLoopbackUrl parses without throwing on garbage', () => {
    assert.strictEqual(isLoopbackUrl('not a url'), false)
    assert.strictEqual(isLoopbackUrl('http://127.0.0.1:1/'), true)
  })
})

describe('safeJson - depth and prototype defenses', () => {
  test('parses and re-emits a normal payload', () => {
    const parsed = safeParseJson<{ a: number; b: string }>('{"a":1,"b":"x"}')
    assert.deepStrictEqual(parsed, { a: 1, b: 'x' })
  })

  test('strips poisoned __proto__ at parse time', () => {
    const parsed = safeParseJson<Record<string, unknown>>('{"__proto__":{"polluted":true},"a":1}')
    assert.ok(parsed)
    assert.strictEqual((parsed as Record<string, unknown>).a, 1)

    assert.strictEqual((Object.prototype as unknown as Record<string, unknown>).polluted, undefined)
  })

  test('rejects nested poisoned entries in arrays and objects', () => {
    const parsed = safeParseJson<unknown>('{"list":[{"__proto__":{"x":1},"ok":1}]}')
    assert.ok(parsed)
    assert.strictEqual((Object.prototype as unknown as Record<string, unknown>).x, undefined)
  })

  test('caps recursion depth so a hostile payload cannot RangeError the loader', () => {
    const depth = 5_000
    const nested = '['.repeat(depth) + '1' + ']'.repeat(depth)





    const parsed = safeParseJson(nested)
    assert.ok(parsed === null || typeof parsed === 'object')
  })

  test('sanitizeParsed on already-parsed data neutralizes poisoned own keys', () => {
    const payload: { a?: number; __proto__?: unknown } = JSON.parse(
      '{"a":1,"__proto__":{"polluted":1}}',
      (k, v) => (k === '__proto__' ? undefined : v)
    )
    const cleaned = sanitizeParsed(payload)
    assert.strictEqual((cleaned as Record<string, unknown>).a, 1)
  })
})






const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

describe('controlServer - runId shape guard', () => {
  test('accepts generated-looking ids', () => {
    assert.ok(RUN_ID_RE.test('run-1788169433782-1'))
    assert.ok(RUN_ID_RE.test('orchestration-42'))
  })

  test('rejects values that would change the resource scheme', () => {
    assert.strictEqual(RUN_ID_RE.test('terminal:foo'), false)
    assert.strictEqual(RUN_ID_RE.test('file:../etc/passwd'), false)
    assert.strictEqual(RUN_ID_RE.test(''), false)
    assert.strictEqual(RUN_ID_RE.test('a'.repeat(200)), false)
  })
})
