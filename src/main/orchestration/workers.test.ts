import { strict as assert } from 'assert'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { test, describe, beforeEach, afterEach } from 'node:test'
import { OrchestrationStore } from './store.ts'
import { detectRunning, listWorkers, resolveRecipient, resolveWorker } from './workers.ts'


function fakeTerminals(
  rows: { id: string; title: string; cwd?: string; alive?: boolean; output?: string; activeAt?: number }[]
): never {
  return {
    list: () => rows.map((r) => ({ cwd: '', alive: true, ...r, running: true })),
    fullOutput: (id: string) => rows.find((r) => r.id === id)?.output ?? null,
    lastDataAt: (id: string) => rows.find((r) => r.id === id)?.activeAt ?? 0
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

  const deps = (rows: { id: string; title: string; cwd?: string; alive?: boolean; output?: string; activeAt?: number }[]): never =>
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

  test('reports cwd, aliveness and a shell fallback when nothing is detected', () => {
    const d = deps([{ id: 'term-1', title: 'backend', cwd: 'C:\\proj', alive: true }])
    const [w] = listWorkers(d)
    assert.equal(w.cwd, 'C:\\proj')
    assert.equal(w.alive, true)
    assert.equal(w.busy, false)
    assert.equal(w.running, 'shell')
    assert.equal(w.taskTitle, undefined)
  })

  test('a dispatched worker reports its agent and task title as fact', () => {
    const runId = orchestration.createRun({ objective: 'x', coordinator: 'coord' }).id
    const task = orchestration.createTask({ runId, spec: 'a', title: 'Build API', createdBy: 'coord' })
    orchestration.createDispatch({ taskId: task.id, terminalId: 'term-1', agent: 'claude', preamble: 'p' })
    const [w] = listWorkers(deps([{ id: 'term-1', title: 'claude: Build API' }]))
    assert.equal(w.busy, true)
    assert.equal(w.agent, 'claude')
    assert.equal(w.running, 'claude')
    assert.equal(w.taskTitle, 'Build API')
  })

  test('an undispatched terminal guesses its tool from output, marked uncertain', () => {
    const d = deps([{ id: 'term-1', title: 'Agent Terminal 1', output: '$ antigravity chat\nhello' }])
    const [w] = listWorkers(d)
    assert.equal(w.busy, false)
    assert.equal(w.agent, undefined)
    assert.equal(w.running, '~antigravity')
  })

  test('detectRunning reads title prefixes and strips ANSI from output', () => {
    assert.equal(detectRunning('codex: fix tests', null), '~codex')
    assert.equal(detectRunning('Agent Terminal 1', '\x1b[32mGemini\x1b[0m ready'), '~gemini')
    assert.equal(detectRunning('Agent Terminal 1', 'plain bash prompt $ '), undefined)
    assert.equal(detectRunning('random: stuff', null), undefined)
  })

  test('detectRunning does not match substrings or prose words', () => {
    assert.equal(detectRunning('Agent Terminal 1', 'request declined by server'), undefined)
    assert.equal(detectRunning('Agent Terminal 1', 'move cursor position 0,0'), undefined)
    assert.equal(detectRunning('Agent Terminal 1', 'myclaudefork ready'), undefined)
    assert.equal(detectRunning('Agent Terminal 1', 'welcome to claude!'), '~claude')

    assert.equal(detectRunning('cursor: fix login', null), '~cursor')
    assert.equal(detectRunning('cline: refactor', null), '~cline')
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


      const d = deps([{ id: 'term-1', title: 'claude' }])
      assert.equal(resolveRecipient(d, '@claude'), '@claude')

      assert.equal(resolveRecipient(d, 'claude'), 'term-1')
    })

    test('a typo fails at send time rather than becoming undeliverable mail', () => {
      assert.throws(() => resolveRecipient(deps(three), 'backned'), /no worker called/)
    })

    test('a known actor with no terminal is still addressable', () => {


      const d = { terminals: fakeTerminals(three), orchestration, knownActor: (id: string) => id === 'gone-worker' }
      assert.equal(resolveRecipient(d as never, 'gone-worker'), 'gone-worker')

      assert.throws(() => resolveRecipient(d as never, 'never-existed'), /no worker called/)
    })
  })
})
