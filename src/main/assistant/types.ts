import type { ResourceId } from '../core/index.ts'

export type NodeId = 'plan' | 'acquire_lock' | 'act' | 'observe' | 'reflect' | 'human_gate' | 'done' | 'failed'

export type RunStatus = 'running' | 'waiting_human' | 'done' | 'failed'

/** One thing the plan intends to do, in the order it intends to do it. */
export interface PlanStep {
  /** Command type to submit, e.g. `note.create`. */
  command: string
  target: ResourceId
  payload: unknown
  /** Shown in the UI and written to the journal as the reason for the lock. */
  summary: string
  /** Steps the human must approve before they run. */
  needsApproval?: boolean
}

/**
 * The whole of an assistant run, as one typed object.
 *
 * This is the LangGraph idea worth keeping and the reason none of the library
 * is: state lives in a single serialisable value that flows through the nodes,
 * so a checkpoint is just this object, and resuming is just loading it back.
 */
export interface RunState {
  runId: string
  goal: string
  /** Which actor the run writes as; a real registered actor, not a bypass. */
  actorId: string
  step: number
  status: RunStatus
  currentNode: NodeId
  plan: PlanStep[]
  /** Index into `plan` of the step being executed. */
  cursor: number
  /** Resources this run currently holds. */
  held: ResourceId[]
  /** Intermediate results, keyed freely by the nodes that produce them. */
  scratch: Record<string, unknown>
  /** Human-readable trace, shown in the chat panel. */
  log: string[]
  /** Set when `status` is `waiting_human`. */
  question?: string
  error?: string
  startedAt: number
  updatedAt: number
}

export interface NodeResult {
  next: NodeId
  patch: Partial<RunState>
}

export type AssistantNode = (state: RunState) => Promise<NodeResult>

/** What a run needs from the outside world. Injected so the engine is testable. */
export interface RunDeps {
  /** Turns a goal into an ordered list of commands. */
  plan(state: RunState): Promise<PlanStep[]>
  /** Submits one command; returns whatever the handler produced. */
  execute(state: RunState, step: PlanStep): Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>
  /** Reads back the effect of a step (terminal output, canvas state, …). */
  observe(state: RunState, step: PlanStep): Promise<unknown>
  /** Takes a lock for the run's actor; false means somebody else holds it. */
  acquire(state: RunState, resource: ResourceId, reason: string): boolean
  release(state: RunState, resource: ResourceId): void
  /** True if the step's effect is already present — the idempotency check. */
  alreadyDone?(state: RunState, step: PlanStep): Promise<boolean>
  /** Persists a checkpoint after every step. */
  checkpoint(state: RunState): void
  now?(): number
}
