import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { registerTerminalIpc } from './ipc/terminals.ts'
import type { IpcDeps } from './ipc/types.ts'
import { clearMountedTerminals, isTerminalMounted } from './ipc/terminalFocus.ts'

for (const rejects of [false, true]) {
  test(`late spawn ${rejects ? 'rejection' : 'failure'} does not detach the replacement widget`, async () => {
    const handlers = new Map<string, (...args: any[]) => any>()
    const globals = globalThis as typeof globalThis & { __electronMock?: unknown }
    const previous = globals.__electronMock
    globals.__electronMock = { ipcMain: {
      handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
      on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn)
    } }
    clearMountedTerminals()
    let fail!: () => void
    let first = true
    const deps = { terminals: { resetRendererOutput: () => {} }, core: { flow: { submit: () => {
      if (!first) return Promise.resolve({ ok: true, data: { ok: true } })
      first = false
      return new Promise((resolve, reject) => {
        fail = () => rejects ? reject(new Error('spawn failed')) : resolve({ ok: false, message: 'spawn failed' })
      })
    } } } } as unknown as IpcDeps
    try {
      registerTerminalIpc(deps)
      const create = handlers.get('terminal:create')!
      const detach = handlers.get('terminal:detach')!
      const pending = create({}, 'term-1')
      detach({}, 'term-1')
      await create({}, 'term-1')
      fail()
      await pending
      assert.equal(isTerminalMounted('term-1'), true)
      detach({}, 'term-1')
      assert.equal(isTerminalMounted('term-1'), false)
    } finally {
      globals.__electronMock = previous
      clearMountedTerminals()
    }
  })
}
