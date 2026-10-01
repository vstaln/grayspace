import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { timerPersist } from './timerPersist.ts'

test('an expired timer that already rang does not ring again after reload', () => {
  const values = new Map<string, string>()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  })

  try {
    timerPersist.set('timer-1', {
      totalMs: 60_000,
      remaining: -1000,
      running: true,
      deadline: Date.now() - 1000,
      rang: true,
      isCustom: false,
      customHours: '0',
      customMinutes: '1',
      customSeconds: '0'
    })

    assert.equal(timerPersist.get('timer-1')?.rang, true)
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
