import { EventEmitter } from 'events'
import { parseResource } from './resources.ts'
import { CommandError, type ResourceId } from './types.ts'

export interface ResourceLock {
  resource: ResourceId
  actorId: string
  acquiredAt: number
  expiresAt: number

  reason?: string






  implicit: boolean
}

export const DEFAULT_LOCK_TTL_MS = 30_000
export const MIN_LOCK_TTL_MS = 1_000
export const MAX_LOCK_TTL_MS = 10 * 60_000

















export class LockManager extends EventEmitter {
  private readonly locks = new Map<ResourceId, ResourceLock>()
  private readonly now: () => number
  private readonly defaultTtl: number
  private sweeper: ReturnType<typeof setInterval> | null = null

  constructor(options: { now?: () => number; defaultTtlMs?: number } = {}) {
    super()
    this.now = options.now ?? Date.now
    this.defaultTtl = clamp(options.defaultTtlMs ?? DEFAULT_LOCK_TTL_MS, MIN_LOCK_TTL_MS, MAX_LOCK_TTL_MS)
  }







  startSweeper(intervalMs = 5_000): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.sweep(), intervalMs)
    this.sweeper.unref?.()
  }

  stopSweeper(): void {
    if (!this.sweeper) return
    clearInterval(this.sweeper)
    this.sweeper = null
  }






  acquire(input: {
    resource: ResourceId
    actorId: string
    ttlMs?: number
    reason?: string
    implicit?: boolean
  }): ResourceLock {
    const resource = this.validate(input.resource)
    const actorId = input.actorId?.trim()
    if (!actorId) throw new CommandError('invalid', 'actorId is required to take a lock')

    const current = this.live(resource)
    if (current && current.actorId !== actorId) {
      throw new CommandError('locked', `${resource} is locked by ${current.actorId}`, { lock: current })
    }

    const at = this.now()
    const lock: ResourceLock = {
      resource,
      actorId,
      acquiredAt: current?.acquiredAt ?? at,
      expiresAt: at + clamp(input.ttlMs ?? this.defaultTtl, MIN_LOCK_TTL_MS, MAX_LOCK_TTL_MS),
      reason: input.reason ?? current?.reason,


      implicit: input.implicit === true && (current?.implicit ?? true)
    }
    this.locks.set(resource, lock)
    this.emit(current ? 'renewed' : 'acquired', lock)
    return lock
  }


  renew(resource: ResourceId, actorId: string, ttlMs?: number): ResourceLock {
    const current = this.live(resource)
    if (!current) throw new CommandError('not_found', `${resource} is not locked`)
    if (current.actorId !== actorId) {
      throw new CommandError('forbidden', `${resource} is held by ${current.actorId}`, { lock: current })
    }
    current.expiresAt = this.now() + clamp(ttlMs ?? this.defaultTtl, MIN_LOCK_TTL_MS, MAX_LOCK_TTL_MS)
    this.emit('renewed', current)
    return current
  }






  heartbeat(actorId: string, ttlMs?: number): number {
    const until = this.now() + clamp(ttlMs ?? this.defaultTtl, MIN_LOCK_TTL_MS, MAX_LOCK_TTL_MS)
    let renewed = 0
    for (const lock of this.locks.values()) {
      if (lock.actorId !== actorId) continue

      if ((lock as unknown as { implicit?: boolean }).implicit) continue



      if (lock.expiresAt <= this.now()) continue
      lock.expiresAt = until
      renewed += 1
      this.emit('renewed', lock)
    }
    return renewed
  }

  release(resource: ResourceId, actorId: string): void {
    // `live`, not a raw map read: every other method here treats an expired
    // lock as absent. Reading the map directly made this the one place where a
    // lock nobody holds any more still reported "held by <the dead actor>",
    // so a cleanup path releasing a resource it had every right to release got
    // a spurious `forbidden` until the sweeper happened to run.
    const current = this.live(resource)
    if (!current) return
    if (current.actorId !== actorId) {
      throw new CommandError('forbidden', `${resource} is held by ${current.actorId}`, { lock: current })
    }
    this.locks.delete(resource)
    this.emit('released', current)
  }


  releaseAllFor(actorId: string): ResourceLock[] {
    const dropped: ResourceLock[] = []
    for (const [resource, lock] of this.locks) {
      if (lock.actorId !== actorId) continue
      this.locks.delete(resource)
      dropped.push(lock)
    }
    for (const lock of dropped) this.emit('released', lock)
    return dropped
  }


  releaseAll(): void {
    const all = Array.from(this.locks.values())
    this.locks.clear()
    for (const lock of all) this.emit('released', lock)
  }


  holder(resource: ResourceId): ResourceLock | undefined {
    return this.live(resource)
  }

  isLockedByOther(resource: ResourceId, actorId: string): boolean {
    const current = this.live(resource)
    return !!current && current.actorId !== actorId
  }

  isHeldBy(resource: ResourceId, actorId: string): boolean {
    const current = this.live(resource)
    return !!current && current.actorId === actorId
  }

  list(): ResourceLock[] {
    this.sweep()
    return Array.from(this.locks.values())
  }


  sweep(): ResourceLock[] {
    const at = this.now()
    const expired: ResourceLock[] = []
    for (const [resource, lock] of this.locks) {
      if (lock.expiresAt > at) continue
      this.locks.delete(resource)
      expired.push(lock)
    }
    for (const lock of expired) this.emit('expired', lock)
    return expired
  }


  private live(resource: ResourceId): ResourceLock | undefined {
    const lock = this.locks.get(resource)
    if (!lock) return undefined
    if (lock.expiresAt > this.now()) return lock
    this.locks.delete(resource)
    queueMicrotask(() => this.emit('expired', lock))
    return undefined
  }

  private validate(resource: ResourceId): ResourceId {
    if (!parseResource(resource)) {
      throw new CommandError('invalid', `"${resource}" is not a resource id (expected scheme:id)`)
    }
    return resource
  }

  dispose(): void {
    this.stopSweeper()
    this.releaseAll()
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
