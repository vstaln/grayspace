import { EventEmitter } from 'events'
import { CommandError, type Actor, type ActorType } from './types.ts'

/** An actor that has not been heard from in this long is presumed dead. */
export const ACTOR_TTL_MS = 60_000

/**
 * Who is allowed to write, and under what name. Every transport registers the
 * caller here before translating a request into a command, so there is no such
 * thing as an anonymous write — the audit trail in the journal is only worth
 * anything if the `actorId` on each entry means something.
 *
 * Liveness matters beyond bookkeeping: {@link LockManager} releases the locks
 * of an actor that has gone quiet, and this registry is where "quiet" is
 * measured.
 */
export class ActorRegistry extends EventEmitter {
  private readonly actors = new Map<string, Actor>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    super()
    this.now = now
  }

  /**
   * Idempotent: re-registering an existing id refreshes its liveness and label
   * rather than failing. Transports reconnect (a renderer reload, an MCP client
   * restarting) and should not have to care whether they are new.
   */
  register(input: { id: string; type: ActorType; label?: string; transport: string }): Actor {
    const id = input.id?.trim()
    if (!id) throw new CommandError('invalid', 'actorId is required')
    const at = this.now()
    const existing = this.actors.get(id)
    if (existing) {
      existing.lastSeenAt = at
      if (input.label) existing.label = input.label
      return existing
    }
    const actor: Actor = {
      id,
      type: input.type,
      label: input.label?.trim() || id,
      transport: input.transport,
      registeredAt: at,
      lastSeenAt: at
    }
    this.actors.set(id, actor)
    this.emit('registered', actor)
    return actor
  }

  get(id: string): Actor | undefined {
    return this.actors.get(id)
  }

  /** Resolves an actor for a command, refusing unknown ids outright. */
  require(id: string): Actor {
    const actor = this.actors.get(id)
    if (!actor) throw new CommandError('unknown_actor', `actor ${id || '<empty>'} is not registered`, { actorId: id })
    return actor
  }

  /** Liveness ping. Called on every command and by explicit heartbeats. */
  touch(id: string): void {
    const actor = this.actors.get(id)
    if (actor) actor.lastSeenAt = this.now()
  }

  isAlive(id: string, ttlMs = ACTOR_TTL_MS): boolean {
    const actor = this.actors.get(id)
    return !!actor && this.now() - actor.lastSeenAt <= ttlMs
  }

  forget(id: string): void {
    const actor = this.actors.get(id)
    if (!actor) return
    this.actors.delete(id)
    this.emit('forgotten', actor)
  }

  /** Drops actors past their TTL and returns them, so locks can be swept. */
  pruneDead(ttlMs = ACTOR_TTL_MS): Actor[] {
    const cutoff = this.now() - ttlMs
    const dead: Actor[] = []
    for (const actor of this.actors.values()) {
      // The user is the app itself; it does not go stale between keystrokes.
      if (actor.type === 'user' || actor.type === 'system') continue
      if (actor.lastSeenAt < cutoff) dead.push(actor)
    }
    for (const actor of dead) this.forget(actor.id)
    return dead
  }

  list(): Actor[] {
    return Array.from(this.actors.values())
  }
}
