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

/**
 * Locks address *resources*, not tasks. A kanban card is a fine thing to
 * assign but a useless thing to lock: two agents can hold different cards and
 * still edit the same file.
 */
export const RESOURCE_SCHEMES = [
  'widget',
  'note',
  'terminal',
  'file',
  'task',
  'canvas',
  'git',
  'run',
  'plan'
] as const
export type ResourceScheme = (typeof RESOURCE_SCHEMES)[number]

/** `scheme:id` — e.g. `note:note-17`, `file:src/main/index.ts`, `git:repo`. */
export type ResourceId = string

export interface ParsedResource {
  scheme: ResourceScheme
  id: string
}

// ---- commands -------------------------------------------------------------

/**
 * The only way state changes. Submitted by every actor through every
 * transport; applied one at a time by the {@link CommandBus}.
 */
export interface Command<P = unknown> {
  /** Assigned by the bus if the caller does not supply one (used for dedupe). */
  id?: string
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

export type CommandResult<T = unknown> =
  | { ok: true; seq: number; version: number; data: T }
  | { ok: false; code: CommandErrorCode; message: string; details?: Record<string, unknown> }

/**
 * Thrown by handlers; the bus turns it into a failed {@link CommandResult}.
 *
 * Fields are assigned in the body rather than declared as constructor
 * parameter properties: `core/` is run directly by `node --test` through
 * Node's type stripping, which only erases TypeScript syntax and cannot
 * synthesise the assignments a parameter property implies.
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

/**
 * Every command is written twice: `intent` before it runs, `commit` (or
 * `abort`) after. The pair is what makes crash recovery safe — on restart the
 * engine can see "this delete was started but never finished" and check
 * whether the effect already landed instead of blindly replaying it.
 */
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
}

// ---- stores ---------------------------------------------------------------

/**
 * What the bus needs from a store to enforce optimistic concurrency. Stores
 * register one of these per scheme; everything else about them stays private.
 */
export interface VersionSource {
  /** Current version of a resource, or `undefined` if it does not exist. */
  versionOf(target: ResourceId): number | undefined
}

export interface CommandContext {
  command: Command
  actor: Actor
  /** Version of the target when the handler was entered (`0` if new). */
  currentVersion: number
  /**
   * Lets the next command start while this handler is still running.
   *
   * A handler that waits on something *outside* the bus — the renderer
   * mounting a widget, a pty coming up — cannot hold the queue while it waits,
   * because the thing it is waiting for arrives as another command and would
   * be stuck behind it. That is a deadlock the handler always loses, once per
   * timeout.
   *
   * Call it at the point where the handler has finished mutating state and is
   * only observing. The target's lock is *not* released — it is held until the
   * command actually returns — so nothing else may write to the resource in
   * the meantime; only unrelated commands proceed.
   */
  unblock(): void
}

export interface CommandHandler<P = never, R = unknown> {
  /**
   * `true` (the default) means the bus refuses the command while another actor
   * holds the target's lock, and takes an implicit lock for the duration of the
   * apply. Read-through commands that genuinely cannot conflict set it false.
   */
  requiresLock?: boolean
  /** Skip the `baseVersion` check — for creates, and for append-only targets. */
  ignoreVersion?: boolean
  apply(ctx: CommandContext & { command: Command<P> }): R | Promise<R>
}
