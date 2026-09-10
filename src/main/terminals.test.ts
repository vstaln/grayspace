import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import * as fs from 'node:fs'
import { TerminalManager, normalizeDeliveryText } from './terminals.ts'
import { defaultShell } from './config.ts'

describe('TerminalManager', () => {
  test('reserve keeps explicit agent names and numbers unnamed agents', () => {
    const manager = new TerminalManager()

    const term1 = manager.reserve({ title: 'My Shell' })
    assert.ok(term1.id.startsWith('term-'))
    assert.equal(term1.title, 'My Shell')
    assert.equal(term1.alive, false)

    const agent1 = manager.reserve({ prefix: 'agent', title: 'Custom Agent' })
    assert.ok(agent1.id.startsWith('agent-'))
    assert.equal(agent1.title, 'Custom Agent')

    const agent2 = manager.reserve({ prefix: 'agent' })
    assert.match(agent2.title, /^[a-z]+-[a-z]+$/)


    manager.dispose(agent1.id)
    const agent3 = manager.reserve({ prefix: 'agent' })
    assert.match(agent3.title, /^[a-z]+-[a-z]+$/)
    assert.notEqual(agent3.title, agent2.title)

    manager.disposeAll()
  })

  test('reserve assigns favorite names first and replaces placeholder titles', () => {
    const manager = new TerminalManager({ getFavoriteNames: () => ['backend', 'frontend'] })

    const first = manager.reserve({})
    assert.equal(first.title, 'backend')

    const second = manager.reserve({ prefix: 'agent' })
    assert.equal(second.title, 'frontend')

    const third = manager.reserve({})
    assert.match(third.title, /^[a-z]+-[a-z]+$/)

    const placeholder = manager.reserve({ title: 'Terminal 9' })
    assert.notEqual(placeholder.title, 'Terminal 9')

    manager.disposeAll()
  })

  test('reserve suffixes duplicate explicit titles', () => {
    const manager = new TerminalManager()

    const first = manager.reserve({ title: 'backend' })
    assert.equal(first.title, 'backend')

    const second = manager.reserve({ title: 'Backend' })
    assert.equal(second.title, 'Backend-2')

    manager.disposeAll()
  })

  test('setTitle maps placeholders to auto names and emits title', () => {
    const manager = new TerminalManager({ getFavoriteNames: () => ['backend'] })
    const term = manager.reserve({ title: 'backend' })

    const seen: Array<{ id: string; title: string }> = []
    manager.on('title', (id: string, title: string) => seen.push({ id, title }))

    manager.setTitle(term.id, 'Terminal 3')
    const renamed = manager.list().find((t) => t.id === term.id)?.title ?? ''
    assert.notEqual(renamed, 'Terminal 3')
    assert.deepEqual(seen, [{ id: term.id, title: renamed }])

    manager.setTitle(term.id, '   ')
    assert.equal(manager.list().find((t) => t.id === term.id)?.title, renamed)

    manager.disposeAll()
  })

  test('setTitle updates title safely', () => {
    const manager = new TerminalManager()
    const term = manager.reserve({ title: 'Initial' })
    assert.equal(term.title, 'Initial')

    manager.setTitle(term.id, 'Renamed')
    assert.equal(manager.list().find((t) => t.id === term.id)?.title, 'Renamed')


    manager.setTitle(term.id, '   ')
    assert.equal(manager.list().find((t) => t.id === term.id)?.title, 'Renamed')

    manager.disposeAll()
  })

  test('an agent read stays on unread bytes after the buffer drops old chunks', () => {
    const manager = new TerminalManager()
    const term = manager.reserve()

    manager.appendOutput(term.id, 'hello')
    assert.equal(manager.readOutput(term.id, true), 'hello')


    for (let i = 0; i < 200; i += 1) manager.appendOutput(term.id, 'x'.repeat(1_000))
    const unread = manager.readOutput(term.id, true)
    assert.ok(unread && unread.length > 0)

    assert.equal(manager.readOutput(term.id, false), '')

    manager.appendOutput(term.id, 'tail')
    assert.equal(manager.readOutput(term.id, false), 'tail')

    manager.disposeAll()
  })

  test('readOutput advances read offset on clear without losing fullOutput', () => {
    const manager = new TerminalManager()
    const term = manager.reserve()

    manager.appendOutput(term.id, 'hello world\n')
    assert.equal(manager.readOutput(term.id, false), 'hello world\n')
    assert.equal(manager.readOutput(term.id, false), 'hello world\n')


    assert.equal(manager.readOutput(term.id, true), 'hello world\n')
    assert.equal(manager.readOutput(term.id, false), '')


    manager.appendOutput(term.id, 'next command output\n')
    assert.equal(manager.readOutput(term.id, false), 'next command output\n')
    assert.equal(manager.fullOutput(term.id), 'hello world\nnext command output\n')

    manager.disposeAll()
  })

  test('write validates terminal state before attempting pty write', () => {
    const manager = new TerminalManager()
    const term = manager.reserve()

    const notFound = manager.write('nonexistent-id', 'ls\n')
    assert.equal(notFound.ok, false)
    assert.match((notFound as { error: string }).error, /not found/)

    const notRunning = manager.write(term.id, 'ls\n')
    assert.equal(notRunning.ok, false)
    assert.match((notRunning as { error: string }).error, /not running/)

    manager.disposeAll()
  })

  test('write refuses an oversized payload instead of silently truncating', () => {
    const manager = new TerminalManager()
    const term = manager.reserve()
    const tooBig = 'x'.repeat(64 * 1024 + 1)
    const result = manager.write(term.id, tooBig)
    assert.equal(result.ok, false)
    assert.match((result as { error: string }).error, /exceeds/)
    manager.disposeAll()
  })

  test('write reports an error when the pty write throws', () => {
    const manager = new TerminalManager()
    const term = manager.reserve()
    const record = (
      manager as unknown as { terminals: Map<string, { pty: { write(data: string): void } | null }> }
    ).terminals.get(term.id)
    assert.ok(record)
    record.pty = {
      write: () => {
        throw new Error('EIO')
      }
    }
    const result = manager.write(term.id, 'ls\n')
    assert.equal(result.ok, false)
    manager.disposeAll()
  })

  test('deliverLine only succeeds after the target terminal echoes the message', async () => {
    const manager = new TerminalManager()
    const term = manager.reserve()
    const writes: string[] = []
    const record = (
      manager as unknown as { terminals: Map<string, { pty: { write(data: string): void } | null }> }
    ).terminals.get(term.id)
    assert.ok(record)
    record.pty = { write: (data: string) => writes.push(data) }

    try {
      const delivery = manager.deliverLine(term.id, 'hello world', { timeoutMs: 2000 })
      setTimeout(() => {
        manager.appendOutput(term.id, '\x1b[2Khello world\r\n')
        manager.emit('data', term.id, '\x1b[2Khello world\r\n')
      }, 50)
      const result = await delivery

      assert.equal(result.ok, true)
      assert.deepEqual(writes, ['hello world', '\r'])
    } finally {
      manager.disposeAll()
    }
  })

  test('raw input waits for an in-flight delivery on the same terminal', async () => {
    const manager = new TerminalManager()
    const term = manager.reserve()
    const writes: string[] = []
    const record = (
      manager as unknown as { terminals: Map<string, { pty: { write(data: string): void } | null }> }
    ).terminals.get(term.id)
    assert.ok(record)
    record.pty = { write: (data: string) => writes.push(data) }

    try {
      const delivery = manager.deliverLine(term.id, 'serialized message', { timeoutMs: 2000 })
      const rawInput = manager.writeInput(term.id, ' ')
      setTimeout(() => {
        manager.appendOutput(term.id, 'serialized message\r\n')
        manager.emit('data', term.id, 'serialized message\r\n')
      }, 50)

      assert.equal((await delivery).ok, true)
      assert.equal((await rawInput).ok, true)
      assert.deepEqual(writes, ['serialized message', '\r', ' '])
    } finally {
      manager.disposeAll()
    }
  })

  test('deliverLine reports not sent when only Enter is observed', async () => {
    const manager = new TerminalManager()
    const term = manager.reserve()
    const record = (
      manager as unknown as { terminals: Map<string, { pty: { write(data: string): void } | null }> }
    ).terminals.get(term.id)
    assert.ok(record)
    record.pty = { write: () => {} }

    try {
      const delivery = manager.deliverLine(term.id, 'must arrive', { timeoutMs: 2000 })
      setTimeout(() => {
        manager.appendOutput(term.id, '\r\n> ')
        manager.emit('data', term.id, '\r\n> ')
      }, 50)
      const result = await delivery

      assert.equal(result.ok, false)
      assert.match((result as { error: string }).error, /not sent/)
    } finally {
      manager.disposeAll()
    }
  })

  test('delivery matching ignores ANSI paint and wrapped whitespace', () => {
    assert.equal(normalizeDeliveryText('\x1b[31mhello\x1b[0m\r\n world'), 'hello world')
  })

  test('dispose prevents resurrecting banned terminal IDs', () => {
    const manager = new TerminalManager()
    const term = manager.reserve()

    manager.dispose(term.id)
    assert.equal(manager.has(term.id), false)

    const spawnResult = manager.spawn(term.id)
    assert.equal(spawnResult.ok, false)
    assert.match(spawnResult.error || '', /terminal was closed/)

    manager.disposeAll()
  })

  test('a Rust PTY request error does not leave a zombie terminal', () => {
    class FakeRustPty extends EventEmitter {
      spawnCalls = 0
      spawn(): { ok: true } { this.spawnCalls += 1; return { ok: true } }
      write(): { ok: true } { return { ok: true } }
      resize(): { ok: true } { return { ok: true } }
      dispose(): { ok: true } { return { ok: true } }
      close(): void {}
    }

    const sidecar = new FakeRustPty()
    const manager = new TerminalManager({ rustPty: sidecar as never })
    const term = manager.reserve()
    const record = (
      manager as unknown as { terminals: Map<string, { nativeAlive: boolean }> }
    ).terminals.get(term.id)
    assert.ok(record)
    record.nativeAlive = true
    const exits: Array<{ id: string; code: number }> = []
    manager.on('exit', (id: string, code: number) => exits.push({ id, code }))

    assert.equal(manager.isRunning(term.id), true)
    sidecar.emit('request-error', term.id, new Error('input timed out'))

    assert.equal(sidecar.spawnCalls, 1)
    assert.equal(manager.isRunning(term.id), true)
    assert.deepEqual(exits, [])
    assert.equal(manager.write(term.id, 'x').ok, true)
    manager.disposeAll()
  })

  test('a stale pty exit does not tear down the replacement shell', () => {
    const manager = new TerminalManager()
    const term = manager.reserve()
    const record = (
      manager as unknown as { terminals: Map<string, { pty: { pid: number } | null; rootPid?: number }> }
    ).terminals.get(term.id)
    assert.ok(record)

    const oldPty = { pid: 11 }
    const newPty = { pid: 22 }
    record.pty = newPty
    record.rootPid = 22

    const exits: number[] = []
    manager.on('exit', (_id: string, code: number) => exits.push(code))

    manager.handlePtyExit(term.id, oldPty as never, 1)
    assert.equal(record.pty, newPty)
    assert.equal(exits.length, 0)
    assert.equal(manager.isRunning(term.id), true)

    manager.handlePtyExit(term.id, newPty as never, 0)
    assert.equal(record.pty, null)
    assert.deepEqual(exits, [0])
    assert.equal(manager.isRunning(term.id), false)

    manager.disposeAll()
  })

  test('markPreferred sets focus for target resolution', () => {
    const manager = new TerminalManager()
    const term1 = manager.reserve()
    const term2 = manager.reserve()

    manager.markPreferred(term2.id)
    assert.equal(manager.has(term1.id), true)
    assert.equal(manager.has(term2.id), true)

    manager.disposeAll()
  })

  test('defaultShell resolves existing absolute executable on Windows', () => {
    const cmd = defaultShell('cmd')
    assert.ok(cmd)
    const ps = defaultShell('powershell')
    assert.ok(ps)
    if (process.platform === 'win32') {
      assert.ok(fs.existsSync(cmd), `cmd path must exist: ${cmd}`)
      assert.ok(fs.existsSync(ps), `powershell path must exist: ${ps}`)
      assert.match(ps.toLowerCase(), /powershell\.exe|pwsh\.exe/)
    }
  })
})
