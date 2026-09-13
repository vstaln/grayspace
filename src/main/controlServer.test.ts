import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { ActorRateLimiter } from './core/queue.ts'
import { rateLimitKey } from './controlServer.ts'

/**
 * These exercise the real limiter the control server uses.
 *
 * The previous version of this file declared its own copy of the rate-limit
 * function and tested that — with a different limit (300) from the one the
 * server actually applied (600). A test that reimplements its subject cannot
 * fail when the subject changes, which is how the global-window problem below
 * survived: nothing was watching the real code.
 */

/** A limiter configured as the control server configures it. */
function apiLimiter(now: () => number): ActorRateLimiter {
  return new ActorRateLimiter({ capacity: 120, refillPerSec: 60, now })
}

describe('control server rate limiting', () => {
  test('a caller may burst up to its bucket and is then refused', () => {
    let clock = 0
    const limiter = apiLimiter(() => clock)

    for (let i = 0; i < 120; i++) {
      assert.ok(limiter.tryConsume('agent:alice'), `request ${i + 1} should be allowed`)
    }
    assert.equal(limiter.tryConsume('agent:alice'), false, 'the bucket is empty')
  })

  /**
   * The reason this limiter is per caller at all. One agent in a retry loop
   * used to exhaust a single global window and take every other agent — and
   * the coordinator trying to unblock it — down with it.
   */
  test('one caller exhausting its budget does not affect another', () => {
    let clock = 0
    const limiter = apiLimiter(() => clock)

    while (limiter.tryConsume('agent:runaway')) {
      // drain it
    }
    assert.equal(limiter.tryConsume('agent:runaway'), false, 'guard: it is drained')

    assert.ok(
      limiter.tryConsume('agent:bystander'),
      'a second agent must still be served'
    )
    assert.ok(limiter.tryConsume('anonymous'), 'and so must the app itself')
  })

  test('a bucket refills over time rather than staying dead', () => {
    let clock = 0
    const limiter = apiLimiter(() => clock)
    while (limiter.tryConsume('agent:alice')) {
      // drain it
    }

    clock += 100 // 100ms at 60/s buys 6 tokens
    let allowed = 0
    while (limiter.tryConsume('agent:alice')) allowed += 1
    assert.ok(allowed >= 5 && allowed <= 7, `expected about 6 refilled, got ${allowed}`)
  })

  test('a refilling bucket never exceeds its capacity', () => {
    let clock = 0
    const limiter = apiLimiter(() => clock)
    limiter.tryConsume('agent:alice')

    clock += 10 * 60_000 // ten idle minutes
    let allowed = 0
    while (limiter.tryConsume('agent:alice')) allowed += 1
    assert.equal(allowed, 120, 'an idle caller banks a full bucket, not an unbounded one')
  })
})

describe('control server rate-limit keys', () => {
  test('each named agent gets its own bucket', () => {
    assert.equal(rateLimitKey('alice'), 'agent:alice')
    assert.notEqual(rateLimitKey('alice'), rateLimitKey('bob'))
  })

  test('callers that name no agent share one bucket rather than being exempt', () => {
    assert.equal(rateLimitKey(undefined), 'anonymous')
    assert.equal(rateLimitKey(''), 'anonymous')
    assert.equal(rateLimitKey('   '), 'anonymous')
    assert.equal(rateLimitKey(null), 'anonymous')
  })

  /**
   * The key is prefixed so a caller cannot claim the anonymous bucket, or any
   * other reserved name, by choosing its agent id.
   */
  test('an agent cannot name itself into another bucket', () => {
    assert.notEqual(rateLimitKey('anonymous'), 'anonymous')
    assert.equal(rateLimitKey('anonymous'), 'agent:anonymous')
  })

  test('a non-string agent id does not crash the key', () => {
    assert.equal(rateLimitKey(42), 'agent:42')
    assert.equal(rateLimitKey({}), 'agent:[object Object]')
  })
})
