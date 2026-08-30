/**
 * The vocabulary every actor, transport and store in OrcSpace shares.
 *
 * Nothing in `core/` may import from `electron` or touch the filesystem: the
 * whole point of the unified core is that its concurrency rules can be tested
 * in a plain Node process, with a fake clock, without booting an app.
 */

// ---- actors ---------------------------------------------------------------

/**
 * `user` is the human at the keyboard, `assistant` is the built-in chat agent,
 * `agent` is an external CLI (Claude Code, Codex, opencode) reaching in over
 * MCP. The type only ever affects presentation and audit — the assistant has
 * no privileges the others lack, which is the rule the architecture is built
 * around.
 */
export type ActorType = 'user' | 'assistant' | 'agent' | 'system'

export interface Actor {
  id: string
  type: ActorType
  /** Human-readable name for the audit trail and the UI. */
  label: string
  /** Which transport authenticated this actor (`ipc`, `http`, `mcp`, `internal`). */
  transport: string
  registeredAt: number
  lastSeenAt: number
}

// ---- resources ------------------------------------------------------------

export const RESOURCE_SCHEMES = [
  'widget',
  'note',
  'terminal',
  'file',
  'task',
  'canvas',
  'git',
  'run',
  // Orchestration: a delegated task, one worker's attempt at it, and a
  // blocking question put to the coordinator. Separate from `task` (the
  // kanban card) because they have different lifecycles and different owners.
  'orctask',
  'dispatch',
  'gate',
  'plan',
  'chat',
  'search',
  'system'
] as const
export type ResourceScheme = (typeof RESOURCE_SCHEMES)[number]

/** `scheme:id` — e.g. `note:note-17`, `file:src/main/index.ts`, `git:repo`. */
export type ResourceId = string

export interface ParsedResource {
  scheme: ResourceScheme
  id: string
}

// ---- commands -------------------------------------------------------------

export type CommandPriority = 'high' | 'normal' | 'low'

/**
 * The only way state changes. Submitted by every actor through every
 * transport; applied one at a time by the {@link CommandBus}.
 */
export interface Command<P = unknown> {
  /** Assigned by the bus if the caller does not supply one (used for tracking & cancellation). */
  id?: string
  /** Idempotency key for safe client retries without duplicate execution. */
  idempotencyKey?: string
  /** Execution priority: user actions jump ahead of external background agents. */
  priority?: CommandPriority
  actorId: string
  /** Handler key, e.g. `note.update`, `widget.move`, `terminal.write`. */
  type: string
  /** The resource this command writes to. */
  target: ResourceId
  payload: P
  /**
   * The version of `target` the caller believes it read. A mismatch is a
   * conflict, never a silent overwrite. Omit for creates and for commands
   * whose target has no version yet.
   */
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
  | { ok: true; seq: number; version: number; data: T; cached?: boolean; /** Id the bus assigned (or accepted) for this command — the handle `bus.cancel()` takes. */ commandId?: string }
  | { ok: false; code: CommandErrorCode; message: string; details?: Record<string, unknown>; cached?: boolean; commandId?: string }

/**
 * Thrown by handlers; the bus turns it into a failed {@link CommandResult}.
 */
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

// ---- journal --------------------------------------------------------------

export type JournalPhase = 'intent' | 'commit' | 'abort'

export interface JournalEntry {
  seq: number
  at: number
  phase: JournalPhase
  actorId: string
  type: string
  target: ResourceId
  payload?: unknown
  /** Version of the target *after* a committed command. */
  version?: number
  /** Failure reason on `abort`. */
  error?: string
  /** Cryptographic hash chain: SHA-256 hash of previous journal entry. */
  prevHash?: string
  /** Cryptographic hash chain: SHA-256 hash of this journal entry. */
  hash?: string
}

// ---- stores ---------------------------------------------------------------

export interface VersionSource {
  /** Current version of a resource, or `undefined` if it does not exist. */
  versionOf(target: ResourceId): number | undefined
}

export interface CommandContext {
  command: Command
  actor: Actor
  /** Version of the target when the handler was entered (`0` if new). */
  currentVersion: number
  /** Shadow overlay identifier if running in overlay mode (dry-run/speculation). */
  overlayId?: string
  /** Abort signal for in-flight cancellation (e.g. Stop button). */
  signal?: AbortSignal
  /**
   * Lets the next command start while this handler is still running.
   */
  unblock(): void
}

export interface CommandHandler<P = never, R = unknown> {
  requiresLock?: boolean
  ignoreVersion?: boolean
  description?: string
  /**
   * This command carries no state worth replaying, and arrives far too often
   * to pay the full write-path for.
   *
   * A `transient` command still goes through validation, the actor check and
   * the lock *gate* — an agent holding `terminal:<id>` still keeps the user
   * out — but it skips the journal (two hash-chained, fsynced NDJSON entries)
   * and skips taking the implicit lock it would release again microseconds
   * later.
   *
   * The motivating case is `terminal.input`: one command per keypress, per
   * terminal. Journaling those wrote two disk records for every character the
   * user typed, and the journal's periodic flush is a synchronous fsync on the
   * Electron main thread — the same thread that serves the window. Nothing
   * reads those entries back: recovery replays state changes, and a keystroke
   * is not one, it is already in the pty.
   */
  transient?: boolean
  /**
   * Run immediately instead of queueing behind whatever the single-lane
   * command queue is currently draining.
   *
   * The queue exists to serialize *writes to shared state*. Keystrokes and
   * geometry updates are neither: they land in a pty or in node-pty's resize
   * call, both of which are already serialized by the terminal they name. Left
   * in the queue they sat behind unrelated work — an agent's `terminal.write`
   * alone parks the lane for ~210ms of deliberate pacing sleeps — which is
   * felt directly as typing lag in every other terminal on the canvas.
   *
   * Only safe for handlers whose `apply` is synchronous (no await), so two
   * commands for the same target cannot interleave.
   */
  bypassQueue?: boolean
  apply(ctx: CommandContext & { command: Command<P> }): R | Promise<R>
}

// ---- transactions & overlays -----------------------------------------------

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
  /** Id of the transaction as a whole — the handle `bus.cancel()` takes. */
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
