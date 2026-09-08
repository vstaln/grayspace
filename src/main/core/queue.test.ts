import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { ActorRegistry } from './actors.ts'
import { CommandFlow } from './flow.ts'
import { Journal } from './journal.ts'
import { LockManager } from './locks.ts'
import { ActorRateLimiter, PriorityCommandQueue } from './queue.ts'

describe('Priority Queue, Rate Limiter and Backpressure', () => {
  test('high priority commands jump ahead of normal and low priority in queue', async () => {
    const queue = new PriorityCommandQueue()
    const log: string[] = []

    let unblockFirst!: () => void
    const firstHeld = new Promise<void>((r) => {
      unblockFirst = r
    })


    const p1 = queue.enqueue({
      id: 'task-1',
      actorId: 'agent',
      priority: 'normal',
      run: async () => {
        await firstHeld
        log.push('first')
      }
    })


    const pLow = queue.enqueue({
      id: 'task-low',
      actorId: 'agent',
      priority: 'low',
      run: async () => {
        log.push('low')
      }
    })

    const pNormal = queue.enqueue({
      id: 'task-normal',
      actorId: 'agent',
      priority: 'normal',
      run: async () => {
        log.push('normal')
      }
    })

    const pHigh = queue.enqueue({
      id: 'task-user-high',
      actorId: 'user',
      priority: 'high',
      run: async () => {
        log.push('high')
      }
    })


    unblockFirst()
    await Promise.all([p1, pLow, pNormal, pHigh])


    assert.deepEqual(log, ['first', 'high', 'normal', 'low'])
  })

  test('ActorRateLimiter enforces token bucket limits', () => {
    let now = 1000
    const limiter = new ActorRateLimiter({ capacity: 3, refillPerSec: 1, now: () => now })


    assert.equal(limiter.tryConsume('agent-1'), true)
    assert.equal(limiter.tryConsume('agent-1'), true)
    assert.equal(limiter.tryConsume('agent-1'), true)
    assert.equal(limiter.tryConsume('agent-1'), false, 'exhausted')


    now += 2000
    assert.equal(limiter.tryConsume('agent-1'), true)
    assert.equal(limiter.tryConsume('agent-1'), true)
    assert.equal(limiter.tryConsume('agent-1'), false)
  })

  test('CommandFlow responds with rate_limited (429) when agent exceeds rate quota', async () => {
    const actors = new ActorRegistry()
    const locks = new LockManager()
    const journal = new Journal()
    const bus = new CommandFlow({
      actors,
      locks,
      journal,
      rateLimitBurst: 2,
      rateLimitPerSec: 1
    })

    actors.register({ id: 'agent-burst', type: 'agent', label: 'Agent', transport: 'cli' })
    bus.register('test.cmd', {
      ignoreVersion: true,
      requiresLock: false,
      apply: () => ({ status: 'ok' })
    })

    const r1 = await bus.submit({ actorId: 'agent-burst', type: 'test.cmd', target: 'system:test', payload: {} })
    const r2 = await bus.submit({ actorId: 'agent-burst', type: 'test.cmd', target: 'system:test', payload: {} })
    const r3 = await bus.submit({ actorId: 'agent-burst', type: 'test.cmd', target: 'system:test', payload: {} })

    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    assert.equal(r3.ok, false)
    assert.equal(r3.code, 'rate_limited')
  })
})
