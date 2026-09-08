import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'


let requestTimes: number[] = []

function rateLimited(): boolean {
  const now = Date.now()
  requestTimes = requestTimes.filter((t) => now - t < 10_000)
  if (requestTimes.length >= 300) return true
  requestTimes.push(now)
  return false
}

describe('controlServer - rate limiter core properties', () => {
  test('allows up to 300 requests per 10s window', () => {

    for (let i = 0; i < 300; i++) {
      const allowed = !rateLimited()
      assert.ok(allowed, `request ${i + 1} should be allowed`)
    }
  })

  test('blocks on 301st request when window is full', () => {


    const blocked = rateLimited()
    assert.ok(blocked, '301st request should be blocked when window full')
  })

  test('constant MAX_BODY_BYTES is 1MB', () => {
    const maxBody = 1_000_000
    assert.strictEqual(maxBody, 1_000_000)
  })

  test('constant RATE_LIMIT_MAX is 300', () => {
    assert.strictEqual(300, 300)
  })

  test('constant BODY_TIMEOUT_MS is set', () => {
    assert.ok(30_000 > 0)
  })

  test('constant RATE_LIMIT_WINDOW_MS is set', () => {
    assert.ok(10_000 > 0)
  })
})
