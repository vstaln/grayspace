import { EventEmitter } from 'events'
import type { BrainStore } from '../brain'
import type { CanvasStore } from '../canvasState'
import type { CoordinationStore } from '../coordination'
import type { TerminalManager } from '../terminals'
import type { Core, JournalEntry } from '../core/index.ts'
import { AssistantEngine } from './engine.ts'
import { createPlanner } from './planner.ts'
import type { PlanStep, RunState } from './types.ts'

export { AssistantEngine } from './engine.ts'
export { parsePlan, PLANNABLE } from './planner.ts'
export type { PlanStep, RunState, RunStatus } from './types.ts'

/** The assistant's identity on the bus. An ordinary actor, with no privileges. */
export const ASSISTANT_ACTOR_ID = 'assistant'

export interface AssistantDeps {
  core: Core
  brain: BrainStore
  canvas: CanvasStore
  board: CoordinationStore
  terminals: TerminalManager
  apiKey(): string | undefined
  model(): string | undefined
  workspaceDir(): string | undefined
}

export interface Assistant extends EventEmitter {
  start(goal: string): Promise<RunState>
  answer(runId: string, approved: boolean, note?: string): Promise<RunState | null>
  cancel(runId: string): RunState | null
  get(runId: string): RunState | undefined
  list(): RunState[]
  /** Picks unfinished runs out of the journal after a restart. */
  recover(entries: JournalEntry[]): RunState[]
}

/**
 * The built-in assistant, assembled on top of the finished core.
 *
 * Two rules define it, and both are enforced by construction rather than by
 * discipline:
 *
 * - **It is an ordinary actor.** Every effect it has on the world is a command
 *   submitted as `assistant`, subject to the same locks and version checks as
 *   the human and every external agent.
 * - **The journal is the checkpointer.** There is no second persistence
 *   system: a checkpoint is a `run.checkpoint` command, so a run's history
 *   sits interleaved with the state changes it caused, in one ordered log.
 */
export function createAssistant(deps: AssistantDeps): Assistant {
  const { core, brain, canvas, board, terminals } = deps
  const runs = new Map<string, RunState>()
  const events = new EventEmitter() as Assistant

  core.actors.register({
    id: ASSISTANT_ACTOR_ID,
    type: 'assistant',
    label: 'OrcSpace assistant',
    transport: 'internal'
  })

  // The checkpoint command. `ignoreVersion` because a run's state is owned by
  // exactly one writer — the engine driving it — so there is nothing to
  // conflict with; the point of routing it through the bus is the journal.
  core.bus.register<RunState, { runId: string }>('run.checkpoint', {
    requiresLock: false,
    ignoreVersion: true,
    apply: ({ command }) => {
      runs.set(command.payload.runId, command.payload)
      events.emit('run', command.payload)
      return { runId: command.payload.runId }
    }
  })

  const planner = createPlanner({
    apiKey: deps.apiKey,
    model: deps.model,
    context: () => describeWorkspace(deps)
  })

  const engine = new AssistantEngine({
    plan: (state) => planner(state),

    execute: async (state, step) => {
      const result = await core.bus.submit({
        actorId: state.actorId,
        type: step.command,
        target: step.target,
        payload: step.payload
      })
      return result.ok
        ? { ok: true, data: result.data }
        : { ok: false, error: result.message, code: result.code }
    },

    /**
     * Reading back what actually happened, rather than trusting the command's
     * return value. For terminals this matters most: an external agent's
     * context lives in its own process and dies with it, so whatever it
     * produced has to be pulled out of the scrollback while it is still there.
     */
    observe: async (_state, step) => {
      if (step.target.startsWith('terminal:')) {
        const id = step.target.slice('terminal:'.length)
        // Give the shell a moment to actually emit something.
        await new Promise((resolve) => setTimeout(resolve, 400))
        return { output: (terminals.readOutput(id) ?? '').slice(-4_000) }
      }
      if (step.target.startsWith('note:')) {
        const id = step.target.slice('note:'.length)
        return { note: brain.snapshot().notes.find((note) => note.id === id) ?? null }
      }
      if (step.target.startsWith('widget:')) {
        return { widget: canvas.widget(step.target.slice('widget:'.length)) ?? null }
      }
      return null
    },

    acquire: (state, resource, reason) => {
      try {
        core.locks.acquire({ resource, actorId: state.actorId, reason, ttlMs: 60_000 })
        return true
      } catch {
        return false
      }
    },

    release: (state, resource) => core.locks.release(resource, state.actorId),

    /**
     * The idempotency check the spec requires. After a crash the engine
     * replays the step it was in the middle of; if that step was a delete
     * which half-executed, replaying it is destructive. So the effect is
     * checked first, and "already gone" counts as success.
     */
    alreadyDone: async (_state, step) => {
      if (step.command === 'widget.remove') return canvas.widget(idOf(step)) === undefined
      if (step.command === 'note.delete') {
        const note = brain.snapshot().notes.find((n) => n.id === idOf(step))
        return note === undefined
      }
      if (step.command === 'task.delete') return board.task(idOf(step)) === undefined
      return false
    },

    checkpoint: (state) => {
      void core.bus.submit({
        actorId: state.actorId,
        type: 'run.checkpoint',
        target: `run:${state.runId}`,
        payload: state
      })
    }
  })

  engine.on('step', (state: RunState) => events.emit('step', state))
  engine.on('finished', (state: RunState) => events.emit('finished', state))

  events.start = async (goal: string): Promise<RunState> => {
    const state = engine.newRun({ goal, actorId: ASSISTANT_ACTOR_ID })
    runs.set(state.runId, state)
    // Heartbeat while a run is in flight so its locks do not lapse mid-plan.
    const beat = setInterval(() => core.locks.heartbeat(ASSISTANT_ACTOR_ID), 10_000)
    beat.unref?.()
    try {
      return await engine.run(state)
    } finally {
      clearInterval(beat)
    }
  }

  events.answer = async (runId: string, approved: boolean, note?: string): Promise<RunState | null> => {
    const state = runs.get(runId)
    if (!state || state.status !== 'waiting_human') return null
    return engine.resumeWithAnswer(state, { approved, note })
  }

  events.cancel = (runId: string): RunState | null => {
    const state = runs.get(runId)
    if (!state) return null
    for (const resource of state.held) {
      try {
        core.locks.release(resource, state.actorId)
      } catch {
        /* already released */
      }
    }
    const cancelled: RunState = { ...state, status: 'failed', error: 'cancelled by the user', held: [] }
    runs.set(runId, cancelled)
    events.emit('run', cancelled)
    return cancelled
  }

  events.get = (runId: string): RunState | undefined => runs.get(runId)
  events.list = (): RunState[] => Array.from(runs.values()).sort((a, b) => b.updatedAt - a.updatedAt)

  /**
   * Rebuilds runs from the journal on startup. Anything that was `running`
   * when the process died comes back as `waiting_human`, never as running:
   * resuming an autonomous loop unattended after a crash is precisely when a
   * human should look at it first.
   */
  events.recover = (entries: JournalEntry[]): RunState[] => {
    const recovered: RunState[] = []
    for (const entry of entries) {
      if (entry.type !== 'run.checkpoint' || entry.phase !== 'commit') continue
      const state = entry.payload as RunState | undefined
      if (!state?.runId) continue
      runs.set(state.runId, state)
    }
    for (const state of runs.values()) {
      if (state.status !== 'running') continue
      const paused: RunState = {
        ...state,
        status: 'waiting_human',
        // Locks did not survive the restart, so the run holds nothing.
        held: [],
        question: 'This run was interrupted by a restart. Continue?',
        log: [...state.log, 'interrupted by a restart']
      }
      runs.set(state.runId, paused)
      recovered.push(paused)
    }
    return recovered
  }

  return events
}

function idOf(step: PlanStep): string {
  return step.target.slice(step.target.indexOf(':') + 1)
}

/**
 * What the planner is told about the workspace. Kept small on purpose — the
 * prompt budget is the one memory layer checkpointing does *not* solve, so
 * this is a summary, and anything the assistant needs to remember for longer
 * belongs in a note.
 */
function describeWorkspace(deps: AssistantDeps): string {
  const notes = deps.brain
    .snapshot()
    .notes.slice(0, 12)
    .map((note) => `- note:${note.id} — ${note.title}`)
  const widgets = deps.canvas
    .listWidgets()
    .slice(0, 12)
    .map((w) => `- widget:${w.id} — ${w.kind ?? 'widget'} "${w.title}"`)
  const tasks = deps.board
    .snapshot()
    .tasks.slice(0, 12)
    .map((task) => `- task:${task.id} — [${task.state}] ${task.title}`)
  const locks = deps.core.locks.list().map((lock) => `- ${lock.resource} held by ${lock.actorId}`)

  return [
    `project folder: ${deps.workspaceDir() ?? '(none)'}`,
    notes.length ? `notes:\n${notes.join('\n')}` : 'notes: none',
    widgets.length ? `widgets:\n${widgets.join('\n')}` : 'widgets: none',
    tasks.length ? `tasks:\n${tasks.join('\n')}` : 'tasks: none',
    locks.length ? `busy resources (do not plan against these):\n${locks.join('\n')}` : 'busy resources: none'
  ].join('\n')
}
