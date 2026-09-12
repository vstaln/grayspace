
















export const TASK_STATUSES = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
] as const
export type OrcTaskStatus = (typeof TASK_STATUSES)[number]






export const MESSAGE_TYPES = [

  'dispatch',

  'worker_done',

  'heartbeat',

  'escalation',

  'ask',

  'permission',

  'reply',

  'note'
] as const
export type MessageType = (typeof MESSAGE_TYPES)[number]


export const OUTCOMES = ['succeeded', 'failed'] as const
export type Outcome = (typeof OUTCOMES)[number]







export const DISPATCH_STATES = ['running', 'settled', 'retained', 'released'] as const
export type DispatchState = (typeof DISPATCH_STATES)[number]

export interface Run {
  id: string
  objective: string

  coordinator: string
  createdAt: number
  closedAt?: number
  version: number
}

export interface OrcTask {
  id: string
  runId: string
  title: string

  spec: string

  deps: string[]

  images?: string[]
  status: OrcTaskStatus
  createdBy: string
  createdAt: number
  updatedAt: number

  outcome?: Outcome
  version: number
}

export interface Dispatch {
  id: string
  runId: string
  taskId: string

  terminalId: string

  agent: string
  state: DispatchState
  outcome?: Outcome





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

  from: string




  to: string
  subject: string
  body: string
  taskId?: string
  dispatchId?: string
  outcome?: Outcome
  filesModified?: string[]


  images?: string[]

  options?: string[]

  replyTo?: string
  createdAt: number

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


export function isHandle(to: string): boolean {
  return to.startsWith('@')
}
