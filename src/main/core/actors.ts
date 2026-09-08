import { EventEmitter } from 'events'
import { CommandError, type Actor, type ActorType } from './types.ts'


export const ACTOR_TTL_MS = 60_000











export class ActorRegistry extends EventEmitter {
  private readonly actors = new Map<string, Actor>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    super()
    this.now = now
  }






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


  require(id: string): Actor {
    const actor = this.actors.get(id)
    if (!actor) throw new CommandError('unknown_actor', `actor ${id || '<empty>'} is not registered`, { actorId: id })
    return actor
  }


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


  pruneDead(ttlMs = ACTOR_TTL_MS): Actor[] {
    const cutoff = this.now() - ttlMs
    const dead: Actor[] = []
    for (const actor of this.actors.values()) {

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
