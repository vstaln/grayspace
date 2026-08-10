import { EventEmitter } from 'events'
import type { ActorRegistry } from './actors.ts'
import type { Journal } from './journal.ts'
import type { LockManager } from './locks.ts'
import { parseResource } from './resources.ts'
import {
  CommandError,
  type Command,
  type CommandHandler,
  type CommandResult,
  type ResourceId,
  type ResourceScheme,
  type VersionSource
} from './types.ts'

export interface CommandBusOptions {
  actors: ActorRegistry
  locks: LockManager
  journal: Journal
  now?: () => number
  /** TTL of the implicit lock the bus takes around a single apply. */
  implicitLockTtlMs?: number
}

/**
 * The one write path.
 *
 * Every actor — the human's UI, the built-in assistant, every external agent —
 * submits commands here, and this class is the only thing that touches state.
 * That buys four properties that were impossible with three transports writing
 * to four stores directly:
 *
 * - **Sequential application.** Commands run one at a time, so there is no
 *   interleaving to reason about inside a handler.
 * - **Optimistic concurrency.** A command carrying a stale `baseVersion` is
 *   refused as a conflict instead of silently overwriting whoever got there
 *   first (the lost-update bug).
 * - **No unlocked writes.** If another actor holds the target, the command is
 *   refused; if nobody does, the bus takes the lock itself for the duration.
 * - **A journal of everything**, written as intent-then-commit so a crash
 *   mid-apply is recoverable rather than ambiguous.
 */
export class CommandBus extends EventEmitter {
  private readonly handlers = new Map<string, CommandHandler<never, unknown>>()
  private readonly versions = new Map<ResourceScheme, VersionSource>()
  private readonly actors: ActorRegistry
  private readonly locks: LockManager
  private readonly journal: Journal
  private readonly implicitLockTtl: number
  /** The serialisation point: every submit chains onto the previous one. */
  private queue: Promise<unknown> = Promise.resolve()
  private depth = 0

  constructor(options: CommandBusOptions) {
    super()
    this.actors = options.actors
    this.locks = options.locks
    this.journal = options.journal
    this.implicitLockTtl = options.implicitLockTtlMs ?? 15_000
  }

  /** Registers the handler for one command type (`note.update`, `widget.move`, …). */
  register<P, R>(type: string, handler: CommandHandler<P, R>): void {
    if (this.handlers.has(type)) throw new Error(`command ${type} is already registered`)
    this.handlers.set(type, handler as CommandHandler<never, unknown>)
  }

  /** Registers where the bus reads current versions for a resource scheme. */
  registerVersions(scheme: ResourceScheme, source: VersionSource): void {
    this.versions.set(scheme, source)
  }

  knows(type: string): boolean {
    return this.handlers.has(type)
  }

  types(): string[] {
    return Array.from(this.handlers.keys()).sort()
  }

  /** Current version of a resource, `0` when it does not exist yet. */
  versionOf(target: ResourceId): number {
    const parsed = parseResource(target)
    if (!parsed) return 0
    return this.versions.get(parsed.scheme)?.versionOf(target) ?? 0
  }

  /**
   * Submits a command and resolves with its result. Never rejects: a caller
   * that has to distinguish a conflict from a crash gets a discriminated
   * result, not an exception it might forget to catch.
   */
  submit<T = unknown>(command: Command): Promise<CommandResult<T>> {
    const prior = this.queue
    // The turn is held by an explicit signal rather than by the apply promise
    // itself, so a handler can hand the queue on early via `ctx.unblock()`
    // without having to finish first.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // The queue tracks completion only — a failed command must not poison the
    // chain and stall every later one.
    this.queue = prior.then(
      () => held,
      () => held
    )
    const start = (): Promise<CommandResult<T>> => this.runTurn<T>(command, release)
    return prior.then(start, start)
  }

  /** One queued turn: applies the command and always hands the queue on. */
  private async runTurn<T>(command: Command, release: () => void): Promise<CommandResult<T>> {
    let handedOn = false
    const unblock = (): void => {
      if (handedOn) return
      handedOn = true
      release()
    }
    try {
      return await this.apply<T>(command, unblock)
    } finally {
      unblock()
    }
  }

  /**
   * Runs a command from inside another handler, bypassing the queue — the
   * caller is already the one command being applied, so re-entering `submit`
   * would deadlock on its own turn.
   */
  async submitNested<T = unknown>(command: Command): Promise<CommandResult<T>> {
    if (this.depth === 0) return this.submit<T>(command)
    return this.apply<T>(command)
  }

  private async apply<T>(command: Command, unblock: () => void = () => {}): Promise<CommandResult<T>> {
    this.depth += 1
    let implicitLock: ResourceId | null = null
    let intentWritten = false
    try {
      const handler = this.handlers.get(command.type)
      if (!handler) throw new CommandError('unknown_command', `no handler for ${command.type}`)
      if (!parseResource(command.target)) {
        throw new CommandError('invalid', `"${command.target}" is not a resource id (expected scheme:id)`)
      }

      const actor = this.actors.require(command.actorId)
      this.actors.touch(actor.id)

      // ---- lock gate ----------------------------------------------------
      // "No write to a resource without an active lock" is one check, here,
      // rather than four checks spread across the stores.
      if (handler.requiresLock !== false) {
        if (this.locks.isLockedByOther(command.target, actor.id)) {
          const lock = this.locks.holder(command.target)
          throw new CommandError('locked', `${command.target} is locked by ${lock?.actorId}`, { lock })
        }
        if (!this.locks.isHeldBy(command.target, actor.id)) {
          this.locks.acquire({
            resource: command.target,
            actorId: actor.id,
            ttlMs: this.implicitLockTtl,
            reason: command.type,
            implicit: true
          })
          implicitLock = command.target
        }
      }

      // ---- version gate --------------------------------------------------
      const currentVersion = this.versionOf(command.target)
      if (
        handler.ignoreVersion !== true &&
        typeof command.baseVersion === 'number' &&
        command.baseVersion !== currentVersion
      ) {
        throw new CommandError(
          'conflict',
          `${command.target} moved on: expected version ${command.baseVersion}, found ${currentVersion}`,
          { target: command.target, expected: command.baseVersion, actual: currentVersion }
        )
      }

      // ---- apply ----------------------------------------------------------
      this.journal.append({
        phase: 'intent',
        actorId: actor.id,
        type: command.type,
        target: command.target,
        payload: command.payload
      })
      intentWritten = true

      // The handler map is heterogeneous by design — each entry knows its own
      // payload type, which the map's shared value type cannot express — so
      // the payload is re-typed once, here, at the single call site.
      const apply = handler.apply as (ctx: {
        command: Command
        actor: typeof actor
        currentVersion: number
        unblock: () => void
      }) => unknown
      const data = (await apply({ command, actor, currentVersion, unblock })) as T
      // A create addresses a `<scheme>:new` sentinel, which has no version of
      // its own — the object that came back does, and that is the number the
      // caller needs in order to send a matching baseVersion next time.
      const created = (data as { version?: unknown } | null)?.version
      const version =
        this.versionOf(command.target) || (typeof created === 'number' ? created : 0) || currentVersion

      const entry = this.journal.append({
        phase: 'commit',
        actorId: actor.id,
        type: command.type,
        target: command.target,
        payload: command.payload,
        version
      })

      const result: CommandResult<T> = { ok: true, seq: entry.seq, version, data }
      this.emit('applied', { command, result, actor })
      return result
    } catch (err) {
      const error = err instanceof CommandError ? err : new CommandError('failed', String(err))
      if (intentWritten) {
        this.journal.append({
          phase: 'abort',
          actorId: command.actorId,
          type: command.type,
          target: command.target,
          error: error.message
        })
      }
      if (!(err instanceof CommandError)) console.error(`command ${command.type} failed`, err)
      const result: CommandResult<T> = {
        ok: false,
        code: error.code,
        message: error.message,
        details: error.details
      }
      this.emit('rejected', { command, result })
      return result
    } finally {
      // An implicit lock lives exactly as long as the apply it protected;
      // an explicit one taken by the actor beforehand is left alone.
      if (implicitLock && this.locks.holder(implicitLock)?.implicit === true) {
        try {
          this.locks.release(implicitLock, command.actorId)
        } catch {
          /* the handler may have released it already */
        }
      }
      this.depth -= 1
    }
  }
}
