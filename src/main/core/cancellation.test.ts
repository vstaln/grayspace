import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { ActorRegistry } from './actors.ts'
import { CommandFlow } from './flow.ts'
import { Journal } from './journal.ts'
import { LockManager } from './locks.ts'

describe('In-Flight Command Cancellation (bus.cancel)', () => {
  test('cancelling in-flight command aborts execution and writes abort to journal', async () => {
    const actors = new ActorRegistry()
    const locks = new LockManager()
    const journal = new Journal()
    const bus = new CommandFlow({ actors, locks, journal })

    actors.register({ id: 'user', type: 'user', label: 'User', transport: 'ipc' })

    let wasAborted = false

    bus.register('long.task', {
      ignoreVersion: true,
      requiresLock: false,
      apply: async ({ signal }) => {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            wasAborted = true
            reject(new Error('aborted by signal'))
          })
        })
      }
    })

    const cmdPromise = bus.submit({
      id: 'cmd-to-cancel',
      actorId: 'user',
      type: 'long.task',
      target: 'system:long',
      payload: {}
    })


    await new Promise((r) => setTimeout(r, 10))
    const cancelled = bus.cancel('cmd-to-cancel', 'User clicked stop')
    assert.equal(cancelled, true)

    const res = await cmdPromise
    assert.equal(res.ok, false)
    assert.equal(wasAborted, true)

    const abortEntry = journal.all().find((e) => e.phase === 'abort')
    assert.ok(abortEntry)
  })
})
