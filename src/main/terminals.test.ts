import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import * as fs from 'node:fs'
import { TerminalManager, normalizeDeliveryText, windowsShellArgs } from './terminals.ts'
import { defaultShell } from './config.ts'

describe('TerminalManager', () => {
  test('Ctrl+C reaches the backend while ordinary input awaits an ACK', async () => {
    const manager = new TerminalManager()
    const writes: string[] = []
    let finish!: (value: { ok: true }) => void
    manager.write = async (_id, data) => {
      writes.push(data)
      if (data === 'blocked') return new Promise((resolve) => { finish = resolve })
      return { ok: true }
    }
    const pending = manager.writeLine('test', 'blocked')
    await new Promise<void>((resolve) => setImmediate(resolve))
    const queued = manager.writeInput('test', 'stale input')
    try {
      const interrupt = manager.writeInput('test', '\x03')
      assert.deepEqual(writes, ['blocked', '\x03'])
      assert.equal((await interrupt).ok, true)
    } finally {
      finish({ ok: true })
      assert.equal((await pending).ok, false)
      assert.equal((await queued).ok, false)
      assert.deepEqual(writes, ['blocked', '\x03'], 'interrupt cancels pending Enter and queued text')
      manager.disposeAll()
    }
  })

  test('expired queued input is rejected and never typed out of order', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const manager = new TerminalManager()
    let finish!: (value: { ok: true }) => void
    const writes: string[] = []
    manager.write = async (_id, data) => {
      writes.push(data)
      return new Promise((resolve) => { finish = resolve })
    }
    const first = manager.writeInput('test', 'blocked')
    await new Promise<void>((resolve) => setImmediate(resolve))
    const second = manager.writeInput('test', 'expired')
    t.mock.timers.tick(5_001)
    assert.equal((await second).ok, false)
    finish({ ok: true })
    await first
    assert.deepEqual(writes, ['blocked'])
    manager.disposeAll()
  })

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
    assert.match(agent2.title, /^[A-Z][a-z]+$/)


    manager.dispose(agent1.id)
    const agent3 = manager.reserve({ prefix: 'agent' })
    assert.match(agent3.title, /^[A-Z][a-z]+$/)
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
    assert.match(third.title, /^[A-Z][a-z]+$/)

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

  test('write validates terminal state before attempting pty write', async () => {
    const manager = new TerminalManager()
    const term = manager.reserve()

    const notFound = await manager.write('nonexistent-id', 'ls\n')
    assert.equal(notFound.ok, false)
    assert.match((notFound as { error: string }).error, /not found/)

    const notRunning = await manager.write(term.id, 'ls\n')
    assert.equal(notRunning.ok, false)
    assert.match((notRunning as { error: string }).error, /not running/)

    manager.disposeAll()
  })

  test('write refuses an oversized payload instead of silently truncating', async () => {
    const manager = new TerminalManager()
    const term = manager.reserve()
    const tooBig = 'x'.repeat(64 * 1024 + 1)
    const result = await manager.write(term.id, tooBig)
    assert.equal(result.ok, false)
    assert.match((result as { error: string }).error, /exceeds/)
    manager.disposeAll()
  })

  test('write reports an error when the pty write throws', async () => {
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
    const result = await manager.write(term.id, 'ls\n')
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

  test('delivery matching strips OSC sequences on every terminator', () => {
    assert.equal(normalizeDeliveryText('\x1b]0;window title\x07run tests'), 'run tests')
    assert.equal(normalizeDeliveryText('\x1b]8;;https://example.com\x1b\\link'), 'link')
    assert.equal(normalizeDeliveryText('\x1b]0;title\x9cafter'), 'after')
  })

  test('unterminated OSC introducers stay linear instead of backtracking', () => {
    // `cat` on a binary file emits ESC ] pairs with no terminator. With a body
    // class that could swallow them, matching was quadratic: 50KB — the size
    // of the output buffer this runs over during a delivery — blocked the main
    // thread for well over half a second per scan. The budget here is loose
    // enough not to be flaky and still two orders of magnitude under that.
    const started = Date.now()
    assert.equal(normalizeDeliveryText('\x1b]'.repeat(25_000)), '')
    assert.ok(Date.now() - started < 150, `took ${Date.now() - started}ms`)
  })

  test('split delivery echo is confirmed promptly after the final data event', async () => {
    const manager = new TerminalManager()
    const term = manager.reserve()
    const record = (manager as unknown as { terminals: Map<string, { pty: unknown }> }).terminals.get(term.id)!
    record.pty = { write: () => {} }
    const emit = (text: string): void => {
      manager.appendOutput(term.id, text)
      manager.emit('data', term.id, text)
    }
    const timers: ReturnType<typeof setTimeout>[] = []
    try {
      const delivery = manager.deliverLine(term.id, 'hello world', { pressEnter: false, timeoutMs: 2000 })
      timers.push(setTimeout(() => { emit('hello '); emit('world') }, 30))
      const result = await Promise.race([
        delivery,
        new Promise<null>((resolve) => timers.push(setTimeout(() => resolve(null), 700)))
      ])
      assert.ok(result?.ok, 'confirmation must not wait for the two-second timeout')
    } finally {
      timers.forEach(clearTimeout)
      manager.disposeAll()
    }
  })

  test('cancelled queued messages never type into the terminal', async () => {
    const manager = new TerminalManager()
    const term = manager.reserve()
    const writes: string[] = []
    const record = (manager as unknown as { terminals: Map<string, { pty: unknown }> }).terminals.get(term.id)!
    record.pty = { write: (data: string) => writes.push(data) }
    const controller = new AbortController()
    try {
      const first = manager.writeLine(term.id, 'first')
      const second = manager.writeLine(term.id, 'cancelled', { signal: controller.signal })
      const third = manager.deliverLine(term.id, 'also cancelled', { signal: controller.signal })
      controller.abort()
      assert.equal((await first).ok, true)
      assert.equal((await second).ok, false)
      assert.equal((await third).ok, false)
      assert.deepEqual(writes, ['first', '\r'])
    } finally {
      manager.disposeAll()
    }
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

  test('a Rust PTY request error surfaces without destroying the session', async () => {
    class FakeRustPty extends EventEmitter {
      spawnCalls = 0
      spawn(): { ok: true } { this.spawnCalls += 1; return { ok: true } }
      write(): { ok: true } { return { ok: true } }
      resize(): { ok: true } { return { ok: true } }
      dispose(): { ok: true } { return { ok: true } }
      beginClose(): void {}
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
    const errors: unknown[] = []
    manager.on('backend-error', (error: unknown) => errors.push(error))
    const exits: Array<{ id: string; code: number }> = []
    manager.on('exit', (id: string, code: number) => exits.push({ id, code }))

    // A slow write must not silently replace the shell: that orphaned the
    // live child, whose reader kept interleaving output into the new
    // session while input went elsewhere — indistinguishable from a hang.
    assert.equal(manager.isRunning(term.id), true)
    sidecar.emit('request-error', term.id, new Error('input timed out'))

    assert.equal(sidecar.spawnCalls, 0)
    assert.equal(manager.isRunning(term.id), true)
    assert.equal(errors.length, 1)
    assert.deepEqual(exits, [])
    assert.equal((await manager.write(term.id, 'x')).ok, true)
    manager.disposeAll()
  })

  test('an engine error that means the session is gone is reported as an exit', () => {
    class FakeRustPty extends EventEmitter {
      spawnCalls = 0
      spawn(): { ok: true } { this.spawnCalls += 1; return { ok: true } }
      write(): { ok: true } { return { ok: true } }
      resize(): { ok: true } { return { ok: true } }
      dispose(): { ok: true } { return { ok: true } }
      beginClose(): void {}
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

    // "actor stopped" is the engine saying this terminal has no writer thread
    // any more. Leaving the record alive was what made a dead shell look hung:
    // every keystroke was accepted and dropped, with nothing on screen to say
    // so, and only closing the widget helped.
    sidecar.emit('request-error', term.id, new Error(`terminal ${term.id} actor stopped`))

    assert.equal(sidecar.spawnCalls, 0)
    assert.equal(manager.isRunning(term.id), false)
    assert.deepEqual(exits, [{ id: term.id, code: 1 }])
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

  test('respawning after exit does not inherit the previous session output', () => {
    class FakeRustPty extends EventEmitter {
      spawn(): { ok: true } { return { ok: true } }
      write(): { ok: true } { return { ok: true } }
      resize(): { ok: true } { return { ok: true } }
      dispose(): { ok: true } { return { ok: true } }
      beginClose(): void {}
      close(): void {}
    }

    const sidecar = new FakeRustPty()
    const manager = new TerminalManager({ rustPty: sidecar as never })
    const term = manager.reserve()

    assert.equal(manager.spawn(term.id, 80, 24).ok, true)
    manager.appendOutput(term.id, 'stale-session-bytes')
    assert.ok((manager.fullOutput(term.id) ?? '').includes('stale-session-bytes'))

    sidecar.emit('exit', term.id, 0)
    assert.equal(manager.isRunning(term.id), false)

    assert.equal(manager.spawn(term.id, 80, 24).ok, true)
    assert.equal(manager.fullOutput(term.id), '')
    manager.appendOutput(term.id, 'fresh')
    assert.equal(manager.readOutput(term.id, true), 'fresh')

    manager.disposeAll()
  })

  test('a backend restart reuses the last known terminal geometry', () => {
    class FakeRustPty extends EventEmitter {
      spawns: Array<{ cols: number; rows: number }> = []
      spawn(options: { cols: number; rows: number }): { ok: true } {
        this.spawns.push({ cols: options.cols, rows: options.rows })
        return { ok: true }
      }
      write(): { ok: true } { return { ok: true } }
      resize(): { ok: true } { return { ok: true } }
      dispose(): { ok: true } { return { ok: true } }
      beginClose(): void {}
      close(): void {}
    }

    const sidecar = new FakeRustPty()
    const manager = new TerminalManager({ rustPty: sidecar as never })
    const term = manager.reserve()

    assert.equal(manager.spawn(term.id, 80, 24).ok, true)
    manager.resize(term.id, 111, 27)
    sidecar.emit('backend-exit', 1)

    assert.equal(sidecar.spawns.length, 2)
    assert.deepEqual(sidecar.spawns[1], { cols: 111, rows: 27 })
    assert.equal(manager.isRunning(term.id), true)

    manager.disposeAll()
  })

  test('a backend failure during shutdown does not respawn terminals', () => {
    class FakeRustPty extends EventEmitter {
      spawnCalls = 0
      closed = false
      beginCloseCalls = 0
      spawn(): { ok: true } { this.spawnCalls += 1; return { ok: true } }
      write(): { ok: true } { return { ok: true } }
      resize(): { ok: true } { return { ok: true } }
      dispose(): { ok: true } { return { ok: true } }
      beginClose(): void { this.beginCloseCalls += 1 }
      close(): void { this.closed = true }
    }

    const sidecar = new FakeRustPty()
    const manager = new TerminalManager({ rustPty: sidecar as never })
    const term = manager.reserve()
    const record = (
      manager as unknown as { terminals: Map<string, { nativeAlive: boolean }> }
    ).terminals.get(term.id)
    assert.ok(record)
    record.nativeAlive = true

    manager.disposeAll()
    assert.equal(sidecar.beginCloseCalls, 1, 'the sidecar must be told before terminals are released')

    // Quitting closes the engine's stdin, so the writes that release each
    // terminal fail with EPIPE and the sidecar reports the backend as dead.
    // Respawning here would leave fresh orphaned shells behind the closing app.
    sidecar.emit('backend-exit', 1)
    assert.equal(sidecar.spawnCalls, 0, 'no shell may be started while shutting down')
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

  test('windowsShellArgs starts cmd without setup commands', () => {
    // cmd.exe receives no startup command, keeping its prompt on row one.
    if (process.platform !== 'win32') {
      assert.deepEqual(windowsShellArgs('cmd'), [])
      assert.deepEqual(windowsShellArgs('powershell'), [])
      return
    }
    const cmd = windowsShellArgs('cmd')
    assert.deepEqual(cmd, ['/K'], 'cmd.exe must open directly on its first prompt row')

    const ps = windowsShellArgs('powershell')
    assert.ok(ps.includes('-NoExit'), 'the PowerShell session must stay interactive')
    assert.ok(ps.some((arg) => arg.includes('65001')))
    for (const arg of ps) {
      assert.ok(!/[\r\n]/.test(arg), `argv entry must not carry an Enter: ${arg}`)
    }
  })
})
