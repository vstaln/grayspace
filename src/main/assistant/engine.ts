import { EventEmitter } from 'events'
import type { AssistantNode, NodeId, NodeResult, RunDeps, RunState } from './types.ts'

/** A run may not take more steps than this; a loop that replans forever stops here. */
export const MAX_STEPS = 60

/**
 * The assistant's execution engine: a loop over plain functions.
 *
 * Take the node, run it, apply its patch, write a checkpoint, move to `next`.
 * That is the entire mechanism, and it is a few hundred lines rather than a
 * dependency because the two hard parts are already solved elsewhere —
 * persistence is the command journal, and every side effect goes through the
 * bus, which serialises and locks it.
 *
 * The three properties borrowed from LangGraph, and nothing else:
 *
 * 1. state is one typed object flowing through the steps;
 * 2. a checkpoint after every step, so a crash resumes rather than restarts;
 * 3. a human gate the graph can stop at and later resume from.
 */
export class AssistantEngine extends EventEmitter {
  private readonly deps: RunDeps
  private readonly nodes: Record<NodeId, AssistantNode>
  private readonly now: () => number
  /** Runs currently executing, so the same run is never driven twice at once. */
  private readonly active = new Set<string>()

  constructor(deps: RunDeps) {
    super()
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.nodes = {
      plan: this.planNode,
      acquire_lock: this.acquireLockNode,
      act: this.actNode,
      observe: this.observeNode,
      reflect: this.reflectNode,
      human_gate: this.humanGateNode,
      done: this.terminalNode,
      failed: this.terminalNode
    }
  }

  newRun(input: { runId?: string; goal: string; actorId: string }): RunState {
    const at = this.now()
    return {
      runId: input.runId ?? `run-${at}-${Math.random().toString(36).slice(2, 7)}`,
      goal: input.goal,
      actorId: input.actorId,
      step: 0,
      status: 'running',
      currentNode: 'plan',
      plan: [],
      cursor: 0,
      held: [],
      scratch: {},
      log: [],
      startedAt: at,
      updatedAt: at
    }
  }

  /**
   * Drives a run until it finishes, fails, or stops at the human gate.
   *
   * The same method resumes an interrupted run — there is no separate resume
   * path, because a checkpoint is a complete `RunState` and the loop does not
   * care whether it was produced a millisecond or a restart ago.
   */
  async run(initial: RunState): Promise<RunState> {
    if (this.active.has(initial.runId)) throw new Error(`run ${initial.runId} is already executing`)
    this.active.add(initial.runId)
    let state: RunState = { ...initial, status: 'running' }
    try {
      while (state.status === 'running') {
        if (state.step >= MAX_STEPS) {
          state = this.advance(state, { next: 'failed', patch: { error: `run exceeded ${MAX_STEPS} steps` } })
          break
        }
        const node = this.nodes[state.currentNode]
        let result: NodeResult
        try {
          result = await node(state)
        } catch (err) {
          result = { next: 'failed', patch: { error: String(err) } }
        }
        state = this.advance(state, result)
        // The checkpoint lands after the patch and before the next node, so a
        // crash always resumes at a node boundary rather than mid-step.
        this.deps.checkpoint(state)
        this.emit('step', state)
      }
    } finally {
      this.active.delete(initial.runId)
    }

    if (state.status !== 'waiting_human') this.releaseAll(state)
    this.emit('finished', state)
    return state
  }

  /** Answers the question a run stopped on and continues from the same node. */
  async resumeWithAnswer(state: RunState, answer: { approved: boolean; note?: string }): Promise<RunState> {
    const resumed: RunState = {
      ...state,
      status: 'running',
      question: undefined,
      // Approved: run the step that was waiting. Declined: drop it and take up
      // the next one — replanning instead would propose the same thing and
      // stop at the same gate, asking the human a question they just answered.
      currentNode: answer.approved ? 'act' : 'acquire_lock',
      scratch: { ...state.scratch, humanAnswer: answer },
      log: [...state.log, answer.approved ? 'human approved the step' : `human declined: ${answer.note ?? 'no reason given'}`]
    }
    if (!answer.approved) resumed.plan = state.plan.filter((_, index) => index !== state.cursor)
    return this.run(resumed)
  }

  private advance(state: RunState, result: NodeResult): RunState {
    const next: RunState = {
      ...state,
      ...result.patch,
      step: state.step + 1,
      currentNode: result.next,
      updatedAt: this.now()
    }
    if (result.next === 'done') next.status = 'done'
    else if (result.next === 'failed') next.status = 'failed'
    // Entering the gate is not the same as being stopped at it: the gate node
    // still has to run, to work out what it is asking the human. It parks the
    // run by pointing at itself, which is the second time through this branch.
    else if (result.next === 'human_gate' && state.currentNode === 'human_gate') next.status = 'waiting_human'
    return next
  }

  private releaseAll(state: RunState): void {
    for (const resource of state.held) {
      try {
        this.deps.release(state, resource)
      } catch {
        /* an expired lock is already released */
      }
    }
    state.held = []
  }

  // ---- nodes --------------------------------------------------------------

  private planNode = async (state: RunState): Promise<NodeResult> => {
    const plan = await this.deps.plan(state)
    if (plan.length === 0) {
      return { next: 'done', patch: { log: [...state.log, 'nothing to do'] } }
    }
    return {
      next: 'acquire_lock',
      patch: { plan, cursor: 0, log: [...state.log, `planned ${plan.length} step(s)`] }
    }
  }

  private acquireLockNode = async (state: RunState): Promise<NodeResult> => {
    const step = state.plan[state.cursor]
    if (!step) return { next: 'done', patch: {} }
    if (state.held.includes(step.target)) return { next: step.needsApproval ? 'human_gate' : 'act', patch: {} }

    const got = this.deps.acquire(state, step.target, `assistant run ${state.runId}`)
    if (!got) {
      // Somebody else is working on this resource. Skipping is deliberate: an
      // assistant that waits blocks its own queue, and one that forces the
      // lock is exactly the fourth write path this architecture removed.
      return {
        next: 'reflect',
        patch: {
          scratch: { ...state.scratch, lastResult: { ok: false, error: `${step.target} is locked by another actor` } },
          log: [...state.log, `skipped ${step.summary}: ${step.target} is busy`]
        }
      }
    }
    return {
      next: step.needsApproval ? 'human_gate' : 'act',
      patch: { held: [...state.held, step.target], log: [...state.log, `locked ${step.target}`] }
    }
  }

  /**
   * Runs one step. The idempotency rule from the spec lives here: the intent
   * is already in the journal by the time the bus applies it, so on a replay
   * after a crash the engine asks whether the effect is present *before*
   * executing, and a half-finished delete is not run twice.
   */
  private actNode = async (state: RunState): Promise<NodeResult> => {
    const step = state.plan[state.cursor]
    if (!step) return { next: 'done', patch: {} }

    if (this.deps.alreadyDone && (await this.deps.alreadyDone(state, step))) {
      return {
        next: 'observe',
        patch: {
          scratch: { ...state.scratch, lastResult: { ok: true, data: 'already applied' } },
          log: [...state.log, `${step.summary}: already applied, not repeated`]
        }
      }
    }

    const result = await this.deps.execute(state, step)
    return {
      next: 'observe',
      patch: {
        scratch: { ...state.scratch, lastResult: result },
        log: [...state.log, `${result.ok ? 'did' : 'failed'}: ${step.summary}${result.ok ? '' : ` — ${result.error}`}`]
      }
    }
  }

  private observeNode = async (state: RunState): Promise<NodeResult> => {
    const step = state.plan[state.cursor]
    if (!step) return { next: 'reflect', patch: {} }
    const observation = await this.deps.observe(state, step)
    return { next: 'reflect', patch: { scratch: { ...state.scratch, lastObservation: observation } } }
  }

  private reflectNode = async (state: RunState): Promise<NodeResult> => {
    const last = state.scratch.lastResult as { ok?: boolean; code?: string } | undefined
    const step = state.plan[state.cursor]

    // A conflict means the world moved under the plan: replanning against
    // current state is right, retrying the same stale write never is.
    if (last?.ok === false && last.code === 'conflict') {
      return { next: 'plan', patch: { log: [...state.log, 'state moved on — replanning'] } }
    }

    if (step) this.freeStep(state, step)

    const cursor = state.cursor + 1
    if (cursor >= state.plan.length) {
      return { next: 'done', patch: { cursor, log: [...state.log, 'plan complete'] } }
    }
    return { next: 'acquire_lock', patch: { cursor } }
  }

  /**
   * The interrupt point. It is not optional: this agent deletes widgets and
   * types into shells, and an autonomous loop with no place to stop is a
   * safety problem rather than a UX one.
   */
  private humanGateNode = async (state: RunState): Promise<NodeResult> => {
    const step = state.plan[state.cursor]
    return {
      next: 'human_gate',
      patch: {
        question: step ? `Allow: ${step.summary}?` : 'Continue?',
        log: [...state.log, `waiting for the human: ${step?.summary ?? 'continue?'}`]
      }
    }
  }

  private terminalNode = async (state: RunState): Promise<NodeResult> => ({
    next: state.currentNode,
    patch: {}
  })

  /** Drops the lock for a finished step, keeping `held` honest for recovery. */
  private freeStep(state: RunState, step: { target: string }): void {
    if (!state.held.includes(step.target)) return
    try {
      this.deps.release(state, step.target)
    } catch {
      /* already gone */
    }
    state.held = state.held.filter((resource) => resource !== step.target)
  }
}
