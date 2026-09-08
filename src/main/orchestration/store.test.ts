import { strict as assert } from 'assert'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { test, describe, beforeEach, afterEach } from 'node:test'
import { OrchestrationStore } from './store.ts'

describe('OrchestrationStore', () => {
  let dir: string
  let store: OrchestrationStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orc-test-'))
    store = new OrchestrationStore({ file: join(dir, 'orchestration.json') })
  })

  afterEach(() => {
    store.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const run = (): string => store.createRun({ objective: 'ship it', coordinator: 'coord' }).id

  describe('the task DAG', () => {
    test('a task with no dependencies is immediately dispatchable', () => {
      const task = store.createTask({ runId: run(), spec: 'do the thing', createdBy: 'coord' })
      assert.equal(task.status, 'ready')
      assert.equal(task.title, 'do the thing', 'title falls back to the spec’s first line')
    })

    test('a dependent task waits, then is promoted when its dependency completes', () => {
      const runId = run()
      const first = store.createTask({ runId, spec: 'lay foundation', createdBy: 'coord' })
      const second = store.createTask({ runId, spec: 'build wall', deps: [first.id], createdBy: 'coord' })
      assert.equal(second.status, 'pending')

      const dispatch = store.createDispatch({
        taskId: first.id,
        terminalId: 'term-1',
        agent: 'claude',
        preamble: 'p'
      })
      assert.equal(store.requireTask(first.id).status, 'dispatched')

      const settled = store.settleDispatch(dispatch.id, 'succeeded')
      assert.equal(settled.task.status, 'completed')
      assert.deepEqual(settled.promoted, [second.id])
      assert.equal(store.requireTask(second.id).status, 'ready')
    })

    test('a failed dependency does not promote what depends on it', () => {
      const runId = run()
      const first = store.createTask({ runId, spec: 'a', createdBy: 'coord' })
      const second = store.createTask({ runId, spec: 'b', deps: [first.id], createdBy: 'coord' })
      const dispatch = store.createDispatch({ taskId: first.id, terminalId: 't', agent: 'claude', preamble: 'p' })

      const settled = store.settleDispatch(dispatch.id, 'failed')
      assert.equal(settled.task.status, 'failed')
      assert.deepEqual(settled.promoted, [])
      assert.equal(store.requireTask(second.id).status, 'pending')
    })

    test('an unknown dependency is refused rather than silently dropped', () => {
      assert.throws(
        () => store.createTask({ runId: run(), spec: 'x', deps: ['otask-999'], createdBy: 'coord' }),
        /not a task/
      )
    })
  })

  describe('dispatches', () => {
    test('one task cannot have two workers on it at once', () => {
      const task = store.createTask({ runId: run(), spec: 'a', createdBy: 'coord' })
      store.createDispatch({ taskId: task.id, terminalId: 't1', agent: 'claude', preamble: 'p' })
      assert.throws(
        () => store.createDispatch({ taskId: task.id, terminalId: 't2', agent: 'codex', preamble: 'p' }),
        /already has a running dispatch/
      )
    })

    test('a second worker_done is refused — the report is once, or it is not a report', () => {
      const task = store.createTask({ runId: run(), spec: 'a', createdBy: 'coord' })
      const dispatch = store.createDispatch({ taskId: task.id, terminalId: 't', agent: 'claude', preamble: 'p' })
      store.settleDispatch(dispatch.id, 'succeeded')
      assert.throws(() => store.settleDispatch(dispatch.id, 'failed'), /already settled/)
    })

    test('a settled worker stays unaccounted until it is retained or released', () => {
      const task = store.createTask({ runId: run(), spec: 'a', createdBy: 'coord' })
      const dispatch = store.createDispatch({ taskId: task.id, terminalId: 't', agent: 'claude', preamble: 'p' })
      store.settleDispatch(dispatch.id, 'succeeded')
      assert.deepEqual(store.unaccountedDispatches().map((d) => d.id), [dispatch.id])

      store.setDispatchState(dispatch.id, 'released')
      assert.deepEqual(store.unaccountedDispatches(), [])
    })

    test('a running worker cannot be released out from under itself', () => {
      const task = store.createTask({ runId: run(), spec: 'a', createdBy: 'coord' })
      const dispatch = store.createDispatch({ taskId: task.id, terminalId: 't', agent: 'claude', preamble: 'p' })
      assert.throws(() => store.setDispatchState(dispatch.id, 'released'), /still running/)
    })
  })

  describe('the inbox', () => {
    test('mail addressed to the coordinator handle reaches the run’s coordinator', () => {
      const runId = run()
      store.send({ runId, type: 'worker_done', from: 'term-1', to: '@coordinator', subject: 'done' })
      assert.equal(store.inbox('coord').length, 1)
      assert.equal(store.inbox('someone-else').length, 0)
    })

    test('reading does not consume; only an ack does', () => {
      const runId = run()
      const message = store.send({ runId, type: 'escalation', from: 'term-1', to: '@coordinator' })
      assert.equal(store.inbox('coord').length, 1)
      assert.equal(store.inbox('coord').length, 1, 'a second read still sees it')

      store.ack(message.id, 'coord')
      assert.equal(store.inbox('coord').length, 0)
      assert.equal(store.inbox('coord', { includeAcked: true }).length, 1)
    })

    test('a sender does not receive its own directed mail', () => {
      const runId = run()
      store.send({ runId, type: 'note', from: 'coord', to: 'term-1' })
      assert.equal(store.inbox('coord').length, 0)
      assert.equal(store.inbox('term-1').length, 1)
    })

    test('types filter the wait, so a coordinator blocks on what it cares about', () => {
      const runId = run()
      store.send({ runId, type: 'heartbeat', from: 'term-1', to: '@coordinator' })
      store.send({ runId, type: 'worker_done', from: 'term-1', to: '@coordinator' })
      const found = store.inbox('coord', { types: ['worker_done'] })
      assert.equal(found.length, 1)
      assert.equal(found[0].type, 'worker_done')
    })

    test('a reply is findable by the ask it answers', () => {
      const runId = run()
      const ask = store.send({ runId, type: 'ask', from: 'term-1', to: '@coordinator', body: 'which db?' })
      assert.equal(store.replyTo(ask.id), undefined)
      store.send({ runId, type: 'reply', from: 'coord', to: 'term-1', body: 'postgres', replyTo: ask.id })
      assert.equal(store.replyTo(ask.id)?.body, 'postgres')
    })

    test('permission requests stay pending until an explicit reply', () => {
      const runId = run()
      const permission = store.send({
        runId,
        type: 'permission',
        from: 'term-1',
        to: '@coordinator',
        subject: 'permission_request',
        body: 'May I run the migration?'
      })
      assert.equal(store.replyTo(permission.id), undefined)
      assert.equal(store.inbox('coord').some((message) => message.id === permission.id), true)

      store.send({
        runId,
        type: 'reply',
        from: 'coord',
        to: 'term-1',
        subject: 'permission_granted',
        body: 'allow',
        replyTo: permission.id
      })
      assert.equal(store.replyTo(permission.id)?.subject, 'permission_granted')
    })
  })

  describe('decision gates', () => {
    test('opening a gate blocks its task and resolving it unblocks', () => {
      const runId = run()
      const task = store.createTask({ runId, spec: 'a', createdBy: 'coord' })
      const gate = store.createGate({ runId, taskId: task.id, question: 'ship?', options: ['yes', 'no'], createdBy: 'coord' })
      assert.equal(store.requireTask(task.id).status, 'blocked')

      store.resolveGate(gate.id, 'yes')
      assert.equal(store.requireTask(task.id).status, 'ready')
    })

    test('a resolution outside the offered options is refused', () => {
      const runId = run()
      const gate = store.createGate({ runId, question: 'ship?', options: ['yes', 'no'], createdBy: 'coord' })
      assert.throws(() => store.resolveGate(gate.id, 'maybe'), /must be one of/)
    })

    test('a gate is answered once', () => {
      const runId = run()
      const gate = store.createGate({ runId, question: 'ship?', createdBy: 'coord' })
      store.resolveGate(gate.id, 'yes')
      assert.throws(() => store.resolveGate(gate.id, 'no'), /already resolved/)
    })
  })

  describe('persistence', () => {



    test('state survives a restart, and ids do not collide afterwards', () => {
      const own = mkdtempSync(join(tmpdir(), 'orc-persist-'))
      const file = join(own, 'orchestration.json')
      const first = new OrchestrationStore({ file })
      const runId = first.createRun({ objective: 'ship it', coordinator: 'coord' }).id
      const task = first.createTask({ runId, spec: 'survive me', createdBy: 'coord' })
      first.send({ runId, type: 'note', from: 'coord', to: '@all', body: 'hello' })
      first.dispose()

      const reopened = new OrchestrationStore({ file })
      try {
        assert.equal(reopened.requireTask(task.id).spec, 'survive me')
        assert.equal(reopened.listMessages().length, 1)

        const next = reopened.createTask({ runId, spec: 'after restart', createdBy: 'coord' })
        assert.notEqual(next.id, task.id)
      } finally {
        reopened.dispose()
        rmSync(own, { recursive: true, force: true })
      }
    })
  })

  describe('run resolution', () => {
    test('the active run is the newest open one', () => {
      const first = run()
      const second = run()
      assert.equal(store.activeRun()?.id, second)
      store.closeRun(second)
      assert.equal(store.activeRun()?.id, first)
    })

    test('acting without a run is refused with a command that fixes it', () => {
      assert.throws(() => store.requireRun('run-nope'), /no run/)
    })
  })
})
