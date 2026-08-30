import { strict as assert } from 'assert'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { test, describe, beforeEach, afterEach } from 'node:test'
import { OrchestrationStore } from './store.ts'
import { listWorkers, resolveRecipient, resolveWorker } from './workers.ts'

/** Just enough TerminalManager for the resolver: it only reads `list()`. */
function fakeTerminals(rows: { id: string; title: string }[]): never {
  return {
    list: () => rows.map((r) => ({ ...r, cwd: '', running: true }))
  } as never
}

describe('worker resolution', () => {
  let dir: string
  let orchestration: OrchestrationStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orc-workers-'))
    orchestration = new OrchestrationStore({ file: join(dir, 'o.json') })
  })

  afterEach(() => {
    orchestration.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const deps = (rows: { id: string; title: string }[]): never =>
    ({ terminals: fakeTerminals(rows), orchestration }) as never

  const three = [
    { id: 'term-1', title: 'backend' },
    { id: 'term-2', title: 'frontend' },
    { id: 'term-3', title: 'term-3' }
  ]

  test('lists every open terminal and marks the caller', () => {
    const workers = listWorkers(deps(three), 'term-2')
    assert.equal(workers.length, 3)
    assert.deepEqual(
      workers.map((w) => w.self),
      [false, true, false]
    )
    assert.equal(workers[2].name, 'term-3', 'an unnamed terminal falls back to its id')
  })

  test('resolves by exact name, id, @handle, case and prefix', () => {
    const d = deps(three)
    assert.equal(resolveWorker(d, 'backend').id, 'term-1')
    assert.equal(resolveWorker(d, 'term-1').id, 'term-1')
    assert.equal(resolveWorker(d, '@backend').id, 'term-1')
    assert.equal(resolveWorker(d, 'BACKEND').id, 'term-1')
    assert.equal(resolveWorker(d, 'back').id, 'term-1')
  })

  test('`self` resolves to the calling terminal', () => {
    assert.equal(resolveWorker(deps(three), 'self', 'term-2').id, 'term-2')
    assert.throws(() => resolveWorker(deps(three), 'self'), /not an OrcSpace terminal/)
  })

  test('an ambiguous name is an error, never a guess', () => {
    const d = deps([
      { id: 'term-1', title: 'claude' },
      { id: 'term-2', title: 'claude' }
    ])
    assert.throws(() => resolveWorker(d, 'claude'), /matches several workers/)
  })

  test('an ambiguous prefix is an error too', () => {
    const d = deps([
      { id: 'term-1', title: 'backend-api' },
      { id: 'term-2', title: 'backend-worker' }
    ])
    assert.throws(() => resolveWorker(d, 'backend'), /matches several workers/)
    // …but the full name still resolves.
    assert.equal(resolveWorker(d, 'backend-api').id, 'term-1')
  })

  test('an exact name wins over a prefix that also matches', () => {
    const d = deps([
      { id: 'term-1', title: 'api' },
      { id: 'term-2', title: 'api-tests' }
    ])
    assert.equal(resolveWorker(d, 'api').id, 'term-1')
  })

  test('an unknown name lists what is actually open', () => {
    assert.throws(() => resolveWorker(deps(three), 'nope'), /backend, frontend/)
  })

  describe('recipients', () => {
    test('group handles pass through untouched', () => {
      const d = deps(three)
      assert.equal(resolveRecipient(d, '@all'), '@all')
      assert.equal(resolveRecipient(d, '@idle'), '@idle')
      assert.equal(resolveRecipient(d, '@coordinator'), '@coordinator')
      assert.equal(resolveRecipient(d, undefined), '@coordinator', 'unaddressed mail goes to the coordinator')
    })

    test('a name becomes a concrete terminal id', () => {
      assert.equal(resolveRecipient(deps(three), 'frontend'), 'term-2')
    })

    test('an agent handle stays a group even when a worker shares the name', () => {
      const runId = orchestration.createRun({ objective: 'x', coordinator: 'coord' }).id
      const task = orchestration.createTask({ runId, spec: 'a', createdBy: 'coord' })
      orchestration.createDispatch({ taskId: task.id, terminalId: 'term-9', agent: 'claude', preamble: 'p' })

      // A terminal literally named "claude" must not shadow the @claude group.
      const d = deps([{ id: 'term-1', title: 'claude' }])
      assert.equal(resolveRecipient(d, '@claude'), '@claude')
      // Without the @, the name still means that one terminal.
      assert.equal(resolveRecipient(d, 'claude'), 'term-1')
    })

    test('a typo fails at send time rather than becoming undeliverable mail', () => {
      assert.throws(() => resolveRecipient(deps(three), 'backned'), /no worker called/)
    })

    test('a known actor with no terminal is still addressable', () => {
      // The case this exists for: a worker asked a question, then its pane was
      // closed. Refusing the reply would leave that ask blocked forever.
      const d = { terminals: fakeTerminals(three), orchestration, knownActor: (id: string) => id === 'gone-worker' }
      assert.equal(resolveRecipient(d as never, 'gone-worker'), 'gone-worker')
      // An unknown name is still an error — the fallback is not a free pass.
      assert.throws(() => resolveRecipient(d as never, 'never-existed'), /no worker called/)
    })
  })
})
