import { strict as assert } from 'node:assert'
import { test, describe } from 'node:test'
import { AssistantEngine } from './engine.ts'
import { parsePlan } from './planner.ts'
import type { PlanStep, RunDeps, RunState } from './types.ts'

/**
 * The engine with every outside effect faked. Nothing here touches a bus, a
 * model or a disk — the point is the loop: does it checkpoint every step, stop
 * at the gate, skip a busy resource, replan on conflict, and refuse to repeat
 * a destructive step that already landed?
 */
function harness(
  overrides: Partial<RunDeps> & { plan?: RunDeps['plan'] } = {}
): {
  engine: AssistantEngine
  executed: PlanStep[]
  checkpoints: RunState[]
  locked: Set<string>
  held: Set<string>
} {
  const executed: PlanStep[] = []
  const checkpoints: RunState[] = []
  const locked = new Set<string>()
  const held = new Set<string>()

  const deps: RunDeps = {
    plan: async () => [{ command: 'note.update', target: 'note:n1', payload: {}, summary: 'edit note' }],
    execute: async (_state, step) => {
      executed.push(step)
      return { ok: true, data: null }
    },
    observe: async () => null,
    acquire: (_state, resource) => {
      if (locked.has(resource)) return false
      held.add(resource)
      return true
    },
    release: (_state, resource) => void held.delete(resource),
    checkpoint: (state) => void checkpoints.push(structuredClone(state)),
    ...overrides
  }
  return { engine: new AssistantEngine(deps), executed, checkpoints, locked, held }
}

const run = (engine: AssistantEngine, goal = 'do the thing'): Promise<RunState> =>
  engine.run(engine.newRun({ goal, actorId: 'assistant' }))

describe('AssistantEngine — the loop', () => {
  test('a plan runs to completion and every step is checkpointed', async () => {
    const { engine, executed, checkpoints } = harness({
      plan: async () => [
        { command: 'note.create', target: 'note:new', payload: {}, summary: 'write a note' },
        { command: 'widget.create', target: 'widget:new', payload: {}, summary: 'place a widget' }
      ]
    })
    const state = await run(engine)

    assert.equal(state.status, 'done')
    assert.deepEqual(executed.map((s) => s.summary), ['write a note', 'place a widget'])
    // plan, then (lock, act, observe, reflect) twice — one checkpoint each.
    assert.equal(checkpoints.length, state.step)
    assert.ok(checkpoints.every((cp) => typeof cp.currentNode === 'string'))
  })

  test('an empty plan finishes instead of spinning', async () => {
    const { engine, executed } = harness({ plan: async () => [] })
    const state = await run(engine)
    assert.equal(state.status, 'done')
    assert.deepEqual(executed, [])
  })

  test('a runaway plan is stopped by the step ceiling', async () => {
    // A reflect node that always replans is the shape of a livelock.
    const { engine } = harness({
      plan: async () => [{ command: 'note.update', target: 'note:n1', payload: {}, summary: 'retry' }],
      execute: async () => ({ ok: false, error: 'stale', code: 'conflict' })
    })
    const state = await run(engine)
    assert.equal(state.status, 'failed')
    assert.match(String(state.error), /exceeded/)
  })

  test('a node that throws fails the run instead of crashing the process', async () => {
    const { engine } = harness({
      plan: async () => {
        throw new Error('the planner is down')
      }
    })
    const state = await run(engine)
    assert.equal(state.status, 'failed')
    assert.match(String(state.error), /planner is down/)
  })
})

describe('AssistantEngine — locks', () => {
  test('a resource another actor holds is skipped, never forced', async () => {
    const { engine, executed, locked } = harness({
      plan: async () => [
        { command: 'note.update', target: 'note:busy', payload: {}, summary: 'edit the busy note' },
        { command: 'note.update', target: 'note:free', payload: {}, summary: 'edit the free note' }
      ]
    })
    locked.add('note:busy')
    const state = await run(engine)

    assert.equal(state.status, 'done')
    assert.deepEqual(executed.map((s) => s.target), ['note:free'])
    assert.match(state.log.join('\n'), /note:busy is busy/)
  })

  test('every lock is released by the time the run ends', async () => {
    const { engine, held } = harness({
      plan: async () => [
        { command: 'note.update', target: 'note:a', payload: {}, summary: 'a' },
        { command: 'note.update', target: 'note:b', payload: {}, summary: 'b' }
      ]
    })
    await run(engine)
    assert.deepEqual(Array.from(held), [])
  })

  test('a failed run does not leave locks behind either', async () => {
    const { engine, held } = harness({
      plan: async () => [{ command: 'note.update', target: 'note:a', payload: {}, summary: 'a' }],
      observe: async () => {
        throw new Error('observation blew up')
      }
    })
    const state = await run(engine)
    assert.equal(state.status, 'failed')
    assert.deepEqual(Array.from(held), [])
  })
})

describe('AssistantEngine — the human gate', () => {
  test('a destructive step stops and waits instead of running', async () => {
    const { engine, executed } = harness({
      plan: async () => [
        { command: 'widget.remove', target: 'widget:w1', payload: {}, summary: 'delete the widget', needsApproval: true }
      ]
    })
    const state = await run(engine)

    assert.equal(state.status, 'waiting_human')
    assert.match(String(state.question), /delete the widget/)
    assert.deepEqual(executed, [], 'nothing ran before the human answered')
  })

  test('approval resumes from the same step', async () => {
    const { engine, executed } = harness({
      plan: async () => [
        { command: 'widget.remove', target: 'widget:w1', payload: {}, summary: 'delete the widget', needsApproval: true }
      ]
    })
    const paused = await run(engine)
    const finished = await engine.resumeWithAnswer(paused, { approved: true })

    assert.equal(finished.status, 'done')
    assert.deepEqual(executed.map((s) => s.summary), ['delete the widget'])
  })

  test('a declined step is dropped rather than proposed again', async () => {
    const { engine, executed } = harness({
      plan: async () => [
        { command: 'widget.remove', target: 'widget:w1', payload: {}, summary: 'delete the widget', needsApproval: true }
      ]
    })
    const paused = await run(engine)
    const finished = await engine.resumeWithAnswer(paused, { approved: false, note: 'I still need it' })

    assert.equal(finished.status, 'done')
    assert.deepEqual(executed, [])
    assert.match(finished.log.join('\n'), /human declined/)
  })
})

describe('AssistantEngine — recovery and idempotency', () => {
  test('a destructive step whose effect already landed is not repeated', async () => {
    const { engine, executed } = harness({
      plan: async () => [
        { command: 'widget.remove', target: 'widget:gone', payload: {}, summary: 'delete the widget' }
      ],
      // The crash happened after the delete but before the commit.
      alreadyDone: async () => true
    })
    const state = await run(engine)

    assert.equal(state.status, 'done')
    assert.deepEqual(executed, [], 'the half-finished delete was not replayed')
    assert.match(state.log.join('\n'), /already applied/)
  })

  test('a checkpoint is a complete state, so resuming needs nothing else', async () => {
    const { engine, checkpoints } = harness({
      plan: async () => [
        { command: 'note.update', target: 'note:a', payload: {}, summary: 'a' },
        { command: 'note.update', target: 'note:b', payload: {}, summary: 'b' }
      ]
    })
    await run(engine)
    const midway = checkpoints[3]
    // Everything the loop reads on entry is present in the checkpoint.
    for (const key of ['runId', 'goal', 'actorId', 'step', 'status', 'currentNode', 'plan', 'cursor', 'held']) {
      assert.ok(key in midway, `checkpoint is missing ${key}`)
    }
  })

  test('a conflict replans instead of retrying the stale write', async () => {
    let attempts = 0
    const { engine } = harness({
      plan: async () => {
        attempts += 1
        return attempts === 1
          ? [{ command: 'note.update', target: 'note:a', payload: {}, summary: 'stale edit' }]
          : []
      },
      execute: async () => ({ ok: false, error: 'moved on', code: 'conflict' })
    })
    const state = await run(engine)
    assert.equal(state.status, 'done')
    assert.equal(attempts, 2, 'the planner was asked again with current state')
  })

  test('the same run cannot be driven twice at once', async () => {
    const { engine } = harness({
      plan: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return []
      }
    })
    const state = engine.newRun({ goal: 'x', actorId: 'assistant' })
    const first = engine.run(state)
    await assert.rejects(() => engine.run(state), /already executing/)
    await first
  })
})

describe('planner output parsing', () => {
  test('a fenced JSON reply is understood', () => {
    const steps = parsePlan('Sure!\n```json\n{"steps":[{"command":"note.create","target":"note:new","payload":{"title":"x"},"summary":"make a note"}]}\n```')
    assert.equal(steps.length, 1)
    assert.equal(steps[0].command, 'note.create')
  })

  test('a command outside the allowed set is dropped', () => {
    const steps = parsePlan('{"steps":[{"command":"terminal.dispose","target":"terminal:t1","summary":"kill it"},{"command":"note.create","target":"note:new","summary":"ok"}]}')
    assert.deepEqual(steps.map((s) => s.command), ['note.create'])
  })

  test('destructive commands come back marked for approval', () => {
    const steps = parsePlan('{"steps":[{"command":"widget.remove","target":"widget:w1","summary":"remove"}]}')
    assert.equal(steps[0].needsApproval, true)
  })

  test('a malformed target is dropped rather than submitted', () => {
    assert.deepEqual(parsePlan('{"steps":[{"command":"note.update","target":"n1","summary":"x"}]}'), [])
  })

  test('an unparsable reply yields an empty plan, not a crash', () => {
    assert.deepEqual(parsePlan('I am afraid I cannot do that.'), [])
    assert.deepEqual(parsePlan('{"steps": ['), [])
  })
})
