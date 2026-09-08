
















export type ActorType = 'user' | 'assistant' | 'agent' | 'system'

export interface Actor {
  id: string
  type: ActorType

  label: string

  transport: string
  registeredAt: number
  lastSeenAt: number
}



export const RESOURCE_SCHEMES = [
  'widget',
  'note',
  'terminal',
  'file',
  'task',
  'canvas',
  'git',
  'run',



  'orctask',
  'dispatch',
  'gate',
  'plan',
  'search',
  'system'
] as const
export type ResourceScheme = (typeof RESOURCE_SCHEMES)[number]


export type ResourceId = string

export interface ParsedResource {
  scheme: ResourceScheme
  id: string
}



export type CommandPriority = 'high' | 'normal' | 'low'





export interface Command<P = unknown> {

  id?: string

  idempotencyKey?: string

  priority?: CommandPriority
  actorId: string

  type: string

  target: ResourceId
  payload: P





  baseVersion?: number
}

export type CommandErrorCode =
  | 'conflict'
  | 'locked'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'unknown_command'
  | 'unknown_actor'
  | 'failed'
  | 'rate_limited'
  | 'backpressure'
  | 'cancelled'

export type CommandResult<T = unknown> =
  | { ok: true; seq: number; version: number; data: T; cached?: boolean;  commandId?: string }
  | { ok: false; code: CommandErrorCode; message: string; details?: Record<string, unknown>; cached?: boolean; commandId?: string }




export class CommandError extends Error {
  readonly code: CommandErrorCode
  readonly details: Record<string, unknown>

  constructor(code: CommandErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'CommandError'
    this.code = code
    this.details = details
  }
}



export type JournalPhase = 'intent' | 'commit' | 'abort'

export interface JournalEntry {
  seq: number
  at: number
  phase: JournalPhase
  actorId: string
  type: string
  target: ResourceId
  payload?: unknown

  version?: number

  error?: string

  prevHash?: string

  hash?: string
}



export interface VersionSource {

  versionOf(target: ResourceId): number | undefined
}

export interface CommandContext {
  command: Command
  actor: Actor

  currentVersion: number

  overlayId?: string

  signal?: AbortSignal



  unblock(): void
}

export interface CommandHandler<P = never, R = unknown> {
  requiresLock?: boolean
  ignoreVersion?: boolean
  description?: string

















  transient?: boolean














  bypassQueue?: boolean
  apply(ctx: CommandContext & { command: Command<P> }): R | Promise<R>
}



export interface TransactionOptions {
  actorId?: string
  implicitLockTtlMs?: number
  overlayId?: string
  idempotencyKey?: string
  priority?: CommandPriority
}

export interface TransactionResult<T = unknown> {
  ok: boolean
  seq?: number
  version?: number
  code?: CommandErrorCode
  message?: string
  details?: Record<string, unknown>
  data?: T
  results?: CommandResult[]
  cached?: boolean

  commandId?: string
}

export interface OverlayDiffEntry {
  target: ResourceId
  op: 'put' | 'delete'
  value?: unknown
  version: number
}

export interface DryRunResult<T = unknown> {
  ok: boolean
  code?: CommandErrorCode
  message?: string
  details?: Record<string, unknown>
  data?: T
  diff: OverlayDiffEntry[]
  logs: JournalEntry[]
}

export interface SpeculativeResult<T = unknown> {
  planId: string
  ok: boolean
  code?: CommandErrorCode
  message?: string
  data?: T
  diff: OverlayDiffEntry[]
}
