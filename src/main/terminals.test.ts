import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { TerminalManager } from './terminals.ts'

describe('TerminalManager', () => {
  test('reserve assigns distinct IDs and names agent terminals sequentially', () => {
    const manager = new TerminalManager()

    const term1 = manager.reserve({ title: 'My Shell' })
    assert.ok(term1.id.startsWith('term-'))
    assert.equal(term1.title, 'My Shell')
    assert.equal(term1.alive, false)

    const agent1 = manager.reserve({ prefix: 'agent', title: 'Custom Agent' })
    assert.ok(agent1.id.startsWith('agent-'))
    assert.equal(agent1.title, 'Agent Terminal 1')

    const agent2 = manager.reserve({ prefix: 'agent' })
    assert.equal(agent2.title, 'Agent Terminal 2')

    // Dispose agent 1 and verify number reuse
    manager.dispose(agent1.id)
    const agent3 = manager.reserve({ prefix: 'agent' })
    assert.equal(agent3.title, 'Agent Terminal 1')

    manager.disposeAll()
  })

  test('setTitle updates title safely', () => {
    const manager = new TerminalManager()
    const term = manager.reserve({ title: 'Initial' })
    assert.equal(term.title, 'Initial')

    manager.setTitle(term.id, 'Renamed')
    assert.equal(manager.list().find((t) => t.id === term.id)?.title, 'Renamed')

    // Empty title ignored
    manager.setTitle(term.id, '   ')
    assert.equal(manager.list().find((t) => t.id === term.id)?.title, 'Renamed')

    manager.disposeAll()
  })

  test('an agent read stays on unread bytes after the buffer drops old chunks', () => {
    const manager = new TerminalManager()
    const term = manager.reserve()

    manager.appendOutput(term.id, 'hello')
    assert.equal(manager.readOutput(term.id, true), 'hello')

    // Enough output to push the earlier chunks past the retained window.
    for (let i = 0; i < 200; i += 1) manager.appendOutput(term.id, 'x'.repeat(1_000))
    const unread = manager.readOutput(term.id, true)
    assert.ok(unread && unread.length > 0)
    // Nothing new since the drain.
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

    // Clear advances offset for agent reads
    assert.equal(manager.readOutput(term.id, true), 'hello world\n')
    assert.equal(manager.readOutput(term.id, false), '')

    // More output arrives
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
})
