import { EventEmitter } from 'events'
import { parseResource } from './resources.ts'
import { CommandError, type ResourceId } from './types.ts'

export interface ResourceLock {
  resource: ResourceId
  actorId: string
  acquiredAt: number
  expiresAt: number
  /** Why the lock was taken — shown in the UI and written to the journal. */
  reason?: string
  /**
   * Implicit locks are taken by the Command Bus for the duration of a single
   * apply and released straight after. They exist so that "no write to a
   * resource without an active lock" is literally true, without forcing every
   * one-shot caller to bracket its command in acquire/release.
   */
  implicit: boolean
}

export const DEFAULT_LOCK_TTL_MS = 30_000
export const MIN_LOCK_TTL_MS = 1_000
export const MAX_LOCK_TTL_MS = 10 * 60_000

/**
 * Resource locks with a TTL and a heartbeat.
 *
 * Three rules, and every one of them is a fix for a specific failure the old
 * per-task locks had:
 *
 * 1. Locks are on resources (`file:…`, `note:…`, `terminal:…`, `git:repo`),
 *    not on kanban cards — two agents holding different cards could edit the
 *    same file, and the lock that "protected" the work protected nothing.
 * 2. Every lock expires. An agent that crashes mid-edit used to deadlock the
 *    resource until the app restarted; now the lock dies on its own unless the
 *    holder keeps saying it is alive.
 * 3. Locks are never persisted. Any process holding one is dead after a
 *    restart, so restoring them would only recreate the deadlock from disk.
 *    There is deliberately no `save()` on this class.
 */
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

  /**
   * Periodic sweep so expiry is observable (and emits events) even when nobody
   * touches the resource. Correctness does not depend on it — every read path
   * expires lazily — but the UI does: a lock chip that lingers until the next
   * write looks like a deadlock even when it is not one.
   */
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

  /**
   * Takes the lock, or throws `locked` naming the current holder. Re-acquiring
   * a lock you already hold is not an error — it extends it, which is what a
   * long-running agent looping over the same file actually needs.
   */
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
      // An explicit acquire over an implicit lock promotes it: the caller is
      // asking to hold the resource beyond the current command.
      implicit: input.implicit === true && (current?.implicit ?? true)
    }
    this.locks.set(resource, lock)
    this.emit(current ? 'renewed' : 'acquired', lock)
    return lock
  }

  /** Extends a lock the actor already holds. Throws if it has already lapsed. */
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

  /**
   * One ping renews everything an actor holds. This is the heartbeat the whole
   * TTL scheme rests on: a live actor keeps its locks with a single call per
   * interval instead of one per resource.
   */
  heartbeat(actorId: string, ttlMs?: number): number {
    const until = this.now() + clamp(ttlMs ?? this.defaultTtl, MIN_LOCK_TTL_MS, MAX_LOCK_TTL_MS)
    let renewed = 0
    for (const lock of this.locks.values()) {
      if (lock.actorId !== actorId) continue
      // A lock that already expired stays expired: reviving it would let an
      // actor that was gone long enough to lose the resource silently take it
      // back from whoever picked it up.
      if (lock.expiresAt <= this.now()) continue
      lock.expiresAt = until
      renewed += 1
      this.emit('renewed', lock)
    }
    return renewed
  }

  release(resource: ResourceId, actorId: string): void {
    const current = this.locks.get(resource)
    if (!current) return
    if (current.actorId !== actorId) {
      throw new CommandError('forbidden', `${resource} is held by ${current.actorId}`, { lock: current })
    }
    this.locks.delete(resource)
    this.emit('released', current)
  }

  /** Drops every lock an actor holds — used when it disconnects or dies. */
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

  /** Operator escape hatch from the UI: clears everything, whoever holds it. */
  releaseAll(): void {
    const all = Array.from(this.locks.values())
    this.locks.clear()
    for (const lock of all) this.emit('released', lock)
  }

  /** The live holder of a resource, or `undefined` if free (or expired). */
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

  /** Expires everything past its TTL, emitting one `expired` event each. */
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

  /** Reads through the TTL: an expired lock is not a lock. */
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
