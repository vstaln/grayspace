import { strict as assert } from 'node:assert'
import { test, describe } from 'node:test'
import { LockManager, DEFAULT_LOCK_TTL_MS, MIN_LOCK_TTL_MS } from './locks.ts'
import { CommandError } from './types.ts'


function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms: number) => void (t += ms) }
}

function setup(): { locks: LockManager; clock: ReturnType<typeof fakeClock> } {
  const clock = fakeClock()
  return { locks: new LockManager({ now: clock.now }), clock }
}

describe('LockManager — two actors at once', () => {
  test('the second actor is refused and told who holds the resource', () => {
    const { locks } = setup()
    locks.acquire({ resource: 'file:src/main/index.ts', actorId: 'agent-a' })

    assert.throws(
      () => locks.acquire({ resource: 'file:src/main/index.ts', actorId: 'agent-b' }),
      (err: unknown) => {
        assert.ok(err instanceof CommandError)
        assert.equal(err.code, 'locked')
        assert.equal((err.details.lock as { actorId: string }).actorId, 'agent-a')
        return true
      }
    )
  })

  test('different resources never collide', () => {
    const { locks } = setup()
    locks.acquire({ resource: 'note:n1', actorId: 'agent-a' })
    locks.acquire({ resource: 'note:n2', actorId: 'agent-b' })
    assert.equal(locks.holder('note:n1')?.actorId, 'agent-a')
    assert.equal(locks.holder('note:n2')?.actorId, 'agent-b')
  })

  test('the same file reached through two spellings is one lock', () => {
    const { locks } = setup()


    locks.acquire({ resource: 'file:C:/src/a.ts', actorId: 'agent-a' })
    assert.throws(() => locks.acquire({ resource: 'file:C:/src/a.ts', actorId: 'agent-b' }))
  })

  test('re-acquiring your own lock extends it instead of failing', () => {
    const { locks, clock } = setup()
    const first = locks.acquire({ resource: 'note:n1', actorId: 'agent-a', ttlMs: 30_000 })
    clock.advance(10_000)
    const second = locks.acquire({ resource: 'note:n1', actorId: 'agent-a', ttlMs: 30_000 })
    assert.equal(second.acquiredAt, first.acquiredAt, 'the original acquisition time is kept')
    assert.equal(second.expiresAt, first.expiresAt + 10_000)
  })

  test('release hands the resource to the next actor', () => {
    const { locks } = setup()
    locks.acquire({ resource: 'git:repo', actorId: 'agent-a' })
    locks.release('git:repo', 'agent-a')
    const next = locks.acquire({ resource: 'git:repo', actorId: 'agent-b' })
    assert.equal(next.actorId, 'agent-b')
  })

  test('a non-owner cannot release someone else’s lock', () => {
    const { locks } = setup()
    locks.acquire({ resource: 'git:repo', actorId: 'agent-a' })
    assert.throws(
      () => locks.release('git:repo', 'agent-b'),
      (err: unknown) => err instanceof CommandError && err.code === 'forbidden'
    )
    assert.equal(locks.holder('git:repo')?.actorId, 'agent-a')
  })
})

describe('LockManager — TTL and heartbeat', () => {
  test('a crashed holder’s lock expires instead of deadlocking forever', () => {
    const { locks, clock } = setup()
    locks.acquire({ resource: 'terminal:t1', actorId: 'agent-dead', ttlMs: DEFAULT_LOCK_TTL_MS })
    clock.advance(DEFAULT_LOCK_TTL_MS + 1)
    assert.equal(locks.holder('terminal:t1'), undefined)
    assert.equal(locks.acquire({ resource: 'terminal:t1', actorId: 'agent-b' }).actorId, 'agent-b')
  })

  test('a live holder keeps the lock across the TTL via heartbeats', () => {
    const { locks, clock } = setup()
    locks.acquire({ resource: 'file:a.ts', actorId: 'agent-a', ttlMs: 30_000 })
    for (let i = 0; i < 10; i += 1) {
      clock.advance(20_000)
      assert.equal(locks.heartbeat('agent-a', 30_000), 1)
    }
    clock.advance(20_000)
    assert.equal(locks.holder('file:a.ts')?.actorId, 'agent-a')
    assert.throws(() => locks.acquire({ resource: 'file:a.ts', actorId: 'agent-b' }))
  })

  test('one heartbeat renews every lock the actor holds', () => {
    const { locks, clock } = setup()
    locks.acquire({ resource: 'file:a.ts', actorId: 'agent-a', ttlMs: 30_000 })
    locks.acquire({ resource: 'file:b.ts', actorId: 'agent-a', ttlMs: 30_000 })
    locks.acquire({ resource: 'file:c.ts', actorId: 'agent-b', ttlMs: 30_000 })
    clock.advance(10_000)
    assert.equal(locks.heartbeat('agent-a', 30_000), 2, 'only this actor’s locks move')
  })

  test('a heartbeat cannot revive a lock that already lapsed', () => {
    const { locks, clock } = setup()
    locks.acquire({ resource: 'file:a.ts', actorId: 'agent-a', ttlMs: 30_000 })
    clock.advance(30_001)

    locks.acquire({ resource: 'file:a.ts', actorId: 'agent-b', ttlMs: 30_000 })
    assert.equal(locks.heartbeat('agent-a', 30_000), 0)
    assert.equal(locks.holder('file:a.ts')?.actorId, 'agent-b')
  })

  test('renewing a lapsed lock fails rather than silently re-taking it', () => {
    const { locks, clock } = setup()
    locks.acquire({ resource: 'note:n1', actorId: 'agent-a', ttlMs: 5_000 })
    clock.advance(5_001)
    assert.throws(
      () => locks.renew('note:n1', 'agent-a'),
      (err: unknown) => err instanceof CommandError && err.code === 'not_found'
    )
  })

  test('sweep emits expiry once and only for lapsed locks', () => {
    const { locks, clock } = setup()
    const expired: string[] = []
    locks.on('expired', (lock: { resource: string }) => expired.push(lock.resource))
    locks.acquire({ resource: 'note:short', actorId: 'a', ttlMs: 1_000 })
    locks.acquire({ resource: 'note:long', actorId: 'a', ttlMs: 60_000 })
    clock.advance(1_001)
    locks.sweep()
    locks.sweep()
    assert.deepEqual(expired, ['note:short'])
  })
})

describe('LockManager — actor lifecycle', () => {
  test('releaseAllFor drops exactly one actor’s locks', () => {
    const { locks } = setup()
    locks.acquire({ resource: 'file:a.ts', actorId: 'agent-a' })
    locks.acquire({ resource: 'file:b.ts', actorId: 'agent-a' })
    locks.acquire({ resource: 'file:c.ts', actorId: 'agent-b' })
    const dropped = locks.releaseAllFor('agent-a')
    assert.equal(dropped.length, 2)
    assert.equal(locks.list().length, 1)
    assert.equal(locks.holder('file:c.ts')?.actorId, 'agent-b')
  })

  test('releaseAll is the operator escape hatch', () => {
    const { locks } = setup()
    locks.acquire({ resource: 'file:a.ts', actorId: 'agent-a' })
    locks.acquire({ resource: 'git:repo', actorId: 'agent-b' })
    locks.releaseAll()
    assert.deepEqual(locks.list(), [])
  })

  test('locks are in-memory only — there is no persistence entry point', () => {
    const { locks } = setup()


    assert.equal((locks as unknown as { save?: unknown }).save, undefined)
    assert.equal((locks as unknown as { load?: unknown }).load, undefined)
  })
})

describe('LockManager — input validation', () => {
  test('an id without a known scheme is rejected', () => {
    const { locks } = setup()
    for (const bad of ['', 'nonsense', 'unknown:1', ':1', 'file:']) {
      assert.throws(
        () => locks.acquire({ resource: bad, actorId: 'a' }),
        (err: unknown) => err instanceof CommandError && err.code === 'invalid',
        `expected ${JSON.stringify(bad)} to be rejected`
      )
    }
  })

  test('an anonymous lock is impossible', () => {
    const { locks } = setup()
    assert.throws(
      () => locks.acquire({ resource: 'note:n1', actorId: '  ' }),
      (err: unknown) => err instanceof CommandError && err.code === 'invalid'
    )
  })

  test('a wild TTL is clamped rather than trusted', () => {
    const { locks, clock } = setup()
    const forever = locks.acquire({ resource: 'note:n1', actorId: 'a', ttlMs: Number.MAX_SAFE_INTEGER })
    assert.ok(forever.expiresAt - clock.now() <= 10 * 60_000)
    const negative = locks.acquire({ resource: 'note:n2', actorId: 'a', ttlMs: -5 })
    assert.ok(negative.expiresAt > clock.now())
  })

  test('releasing a resource whose lock already expired is a no-op, not a refusal', () => {
    const { locks, clock } = setup()
    locks.acquire({ resource: 'note:n1', actorId: 'agent-a', ttlMs: MIN_LOCK_TTL_MS })
    clock.advance(MIN_LOCK_TTL_MS + 1)

    // `release` must be the first call after expiry, before anything else has
    // a chance to evict the stale entry: `holder`, `acquire` and friends all
    // go through `live`, which drops it as a side effect. Reading the raw map
    // made release the one method that still saw the dead actor as holder.
    assert.doesNotThrow(() => locks.release('note:n1', 'agent-b'))

    // And the rest agree, as they always did.
    assert.equal(locks.holder('note:n1'), undefined)
    assert.equal(locks.isLockedByOther('note:n1', 'agent-b'), false)
  })
})
