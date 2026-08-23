import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { applyLoopbackCors, isLoopbackHost, isLoopbackRequest, isLoopbackUrl, secretsEqual } from './netGuard.ts'

describe('netGuard - Loopback host detection', () => {
  test('localhost returns true', () => {
    assert.ok(isLoopbackHost('localhost'))
  })

  test('127.0.0.1 returns true', () => {
    assert.ok(isLoopbackHost('127.0.0.1'))
  })

  test('::1 (IPv6 loopback) returns true', () => {
    assert.ok(isLoopbackHost('::1'))
  })

  test('0:0:0:0:0:0:0:1 (IPv6 loopback bare) returns true', () => {
    assert.ok(isLoopbackHost('0:0:0:0:0:0:0:1'))
  })

  test('localhost:7421 strips port and returns true', () => {
    assert.ok(isLoopbackHost('localhost:7421'))
  })

  test('127.0.0.1:7421 strips port and returns true', () => {
    assert.ok(isLoopbackHost('127.0.0.1:7421'))
  })

  test('[::1]:7421 bracketed IPv6 strips port and returns true', () => {
    assert.ok(isLoopbackHost('[::1]:7421'))
  })

  test('non-loopback returns false', () => {
    assert.ok(!isLoopbackHost('192.168.1.1'))
    assert.ok(!isLoopbackHost('10.0.0.1'))
    assert.ok(!isLoopbackHost('8.8.8.8'))
    assert.ok(!isLoopbackHost('google.com'))
  })

  test('empty string returns false', () => {
    assert.ok(!isLoopbackHost(''))
  })
})

describe('netGuard - Loopback URL detection', () => {
  test('http://localhost:7421 is loopback', () => {
    assert.ok(isLoopbackUrl('http://localhost:7421'))
  })

  test('http://127.0.0.1:7421 is loopback', () => {
    assert.ok(isLoopbackUrl('http://127.0.0.1:7421'))
  })

  test('http://[::1]:7421 is loopback', () => {
    assert.ok(isLoopbackUrl('http://[::1]:7421'))
  })

  test('http://example.com is not loopback', () => {
    assert.ok(!isLoopbackUrl('http://example.com'))
  })

  test('malformed URL returns false', () => {
    assert.ok(!isLoopbackUrl('not-a-url'))
  })
})

describe('netGuard - isLoopbackRequest', () => {
  test('accepts loopback host with no origin', () => {
    assert.ok(isLoopbackRequest({ headers: { host: '127.0.0.1:47933' } }))
  })

  test('accepts loopback host with loopback origin', () => {
    assert.ok(
      isLoopbackRequest({
        headers: { host: '127.0.0.1:47933', origin: 'http://127.0.0.1:5174' }
      })
    )
  })

  test('rejects a non-loopback origin even on loopback host', () => {
    assert.ok(
      !isLoopbackRequest({
        headers: { host: '127.0.0.1:47933', origin: 'https://evil.example' }
      })
    )
  })

  test('rejects Origin null (file:// / sandboxed iframe)', () => {
    assert.ok(!isLoopbackRequest({ headers: { host: '127.0.0.1:47933', origin: 'null' } }))
  })
})

describe('netGuard - applyLoopbackCors', () => {
  test('echoes only a loopback origin', () => {
    const headers: Record<string, string> = {}
    applyLoopbackCors(
      { headers: { origin: 'http://localhost:5174' } },
      { setHeader: (k, v) => { headers[k] = v } }
    )
    assert.equal(headers['Access-Control-Allow-Origin'], 'http://localhost:5174')
  })

  test('does not echo a foreign origin', () => {
    const headers: Record<string, string> = {}
    applyLoopbackCors(
      { headers: { origin: 'https://evil.example' } },
      { setHeader: (k, v) => { headers[k] = v } }
    )
    assert.equal(headers['Access-Control-Allow-Origin'], undefined)
  })
})

describe('netGuard - secretsEqual', () => {
  test('equal secrets return true', () => {
    assert.ok(secretsEqual('my-secret-key', 'my-secret-key'))
  })

  test('different secrets return false', () => {
    assert.ok(!secretsEqual('my-secret-key', 'different-key'))
  })

  test('same secret with different case returns false', () => {
    assert.ok(!secretsEqual('My-Secret-Key', 'my-secret-key'))
  })
})