/**
 * The orchestration vocabulary: what one agent needs in order to hand work to
 * another and find out how it went.
 *
 * This is deliberately *not* the kanban board. A board task is something a
 * human files and an agent may pick up; an orchestration Task is a unit of
 * delegated work with a dependency edge, a dispatch attempt behind it, and a
 * lifecycle a coordinator is actively waiting on. The two coexist — a
 * coordinator often reads the board and files orchestration tasks from it.
 */

/**
 * `pending` — created, dependencies unmet.
 * `ready`   — every dependency completed; eligible for dispatch.
 * `dispatched` — a worker is on it.
 * `completed` / `failed` — settled by a `worker_done`.
 * `blocked` — a worker escalated, or a decision gate is open.
 */
export const TASK_STATUSES = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
] as const
export type OrcTaskStatus = (typeof TASK_STATUSES)[number]

/**
 * Mail types. The set is closed on purpose: a coordinator's whole control flow
 * is `check --wait --types ...`, and a free-form type would silently never be
 * waited on by anyone.
 */
export const MESSAGE_TYPES = [
  /** Coordinator → worker: here is your task. Carries the preamble. */
  'dispatch',
  /** Worker → coordinator: finished, exactly once, with an outcome. */
  'worker_done',
  /** Worker → coordinator: still alive, mid-task. */
  'heartbeat',
  /** Worker → coordinator: I am stuck and need intervention. */
  'escalation',
  /** Worker → coordinator: blocking question; the worker waits for a reply. */
  'ask',
  /** Any → any: the answer to an `ask`, addressed by `replyTo`. */
  'reply',
  /** Any → any: unstructured note or broadcast. */
  'note'
] as const
export type MessageType = (typeof MESSAGE_TYPES)[number]

/** How a dispatch ended. A `worker_done` must state one. */
export const OUTCOMES = ['succeeded', 'failed'] as const
export type Outcome = (typeof OUTCOMES)[number]

/**
 * `running` — the worker holds the terminal.
 * `settled` — a `worker_done` arrived; the coordinator still owes a decision.
 * `retained` — settled, and the coordinator explicitly kept the terminal.
 * `released` — settled, output archived, terminal handed back.
 */
export const DISPATCH_STATES = ['running', 'settled', 'retained', 'released'] as const
export type DispatchState = (typeof DISPATCH_STATES)[number]

export interface Run {
  id: string
  objective: string
  /** Actor that opened the run; the default recipient of worker mail. */
  coordinator: string
  createdAt: number
  closedAt?: number
  version: number
}

export interface OrcTask {
  id: string
  runId: string
  title: string
  /** The brief handed to the worker verbatim as part of the preamble. */
  spec: string
  /** Task ids that must reach `completed` before this one becomes `ready`. */
  deps: string[]
  status: OrcTaskStatus
  createdBy: string
  createdAt: number
  updatedAt: number
  /** Set when a `worker_done` settles the task. */
  outcome?: Outcome
  version: number
}

export interface Dispatch {
  id: string
  runId: string
  taskId: string
  /** OrcSpace terminal the worker runs in. */
  terminalId: string
  /** CLI the worker is: `claude`, `codex`, … Informational. */
  agent: string
  state: DispatchState
  outcome?: Outcome
  /**
   * The contract text injected into the worker's terminal. A worker whose
   * dispatch has no preamble is not authorised to send lifecycle mail — that
   * is how a stale terminal is stopped from reporting on a run it left.
   */
  preamble: string
  startedAt: number
  settledAt?: number
  filesModified?: string[]
  version: number
}

export interface Message {
  id: string
  runId: string
  type: MessageType
  /** Actor id of the sender. */
  from: string
  /**
   * Recipient: an actor id, or a handle — `@all`, `@idle`, `@coordinator`,
   * or `@<agent>` (every worker running that CLI).
   */
  to: string
  subject: string
  body: string
  taskId?: string
  dispatchId?: string
  outcome?: Outcome
  filesModified?: string[]
  /** `ask`: the choices offered, so a coordinator can reply with one. */
  options?: string[]
  /** `reply`: the id of the `ask` being answered. */
  replyTo?: string
  createdAt: number
  /** Actor ids that have consumed this message. */
  ackedBy: string[]
}

export interface Gate {
  id: string
  runId: string
  taskId?: string
  question: string
  options: string[]
  createdBy: string
  resolution?: string
  createdAt: number
  resolvedAt?: number
  version: number
}

export interface OrchestrationSnapshot {
  runs: Run[]
  tasks: OrcTask[]
  dispatches: Dispatch[]
  messages: Message[]
  gates: Gate[]
}

/** Recipient handles that address a group rather than one actor. */
export function isHandle(to: string): boolean {
  return to.startsWith('@')
}
