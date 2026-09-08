import { strict as assert } from 'node:assert'
import { describe, test, beforeEach, afterEach } from 'node:test'
import { TerminalManager } from './terminals.ts'

describe('Graceful Shutdown', () => {
  let manager: TerminalManager

  beforeEach(() => {
    manager = new TerminalManager()

    manager.disposeAll()
  })

  afterEach(() => {
    manager.disposeAll()
  })

  test('terminal dispose clears the terminal from the manager', () => {
    const term = manager.reserve({ title: 'Test Terminal' })


    assert.equal(term.alive, false)


    manager.dispose(term.id)


    assert.equal(manager.has(term.id), false)
  })

  test('disposeAll removes all terminals', () => {
    manager.reserve({ title: 'Term 1' })
    manager.reserve({ title: 'Term 2' })

    manager.disposeAll()

    assert.equal(manager.list().length, 0)
  })

  test('terminal reserve gives distinct IDs', () => {
    const t1 = manager.reserve({ title: 'First' })
    const t2 = manager.reserve({ title: 'Second' })

    assert.ok(t1.id !== t2.id)
    assert.ok(t1.id.startsWith('term-'))
    assert.ok(t2.id.startsWith('term-'))
    assert.notEqual(t1.title, t2.title)
  })
})

describe('Native Loader Error Resilience', () => {
  test('terminal manager works without native pty binary', () => {



    const manager = new TerminalManager()
    const term = manager.reserve({ title: 'Test Terminal' })


    assert.ok(term.id.startsWith('term-'))
    assert.equal(term.title, 'Test Terminal')
    assert.equal(term.alive, false)

    manager.dispose(term.id)
  })

  test('terminal readOutput and fullOutput work in sequence', () => {
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
})
