import { CommandError, type CommandPriority } from './types.ts'

export interface TokenBucketOptions {
  capacity?: number
  refillPerSec?: number
  now?: () => number
}




export class ActorRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>()
  private readonly capacity: number
  private readonly refillPerSec: number
  private readonly now: () => number

  constructor(options: TokenBucketOptions = {}) {
    this.capacity = options.capacity ?? 30
    this.refillPerSec = options.refillPerSec ?? 20
    this.now = options.now ?? Date.now
  }

  tryConsume(actorId: string, tokens = 1): boolean {
    const now = this.now()
    let bucket = this.buckets.get(actorId)
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now }
      this.buckets.set(actorId, bucket)
    } else {
      const elapsedSec = (now - bucket.lastRefill) / 1000
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec)
      bucket.lastRefill = now
    }

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens
      return true
    }
    return false
  }

  reset(actorId?: string): void {
    if (actorId) this.buckets.delete(actorId)
    else this.buckets.clear()
  }
}

export interface QueuedTask<T = unknown> {
  id: string
  priority: CommandPriority
  actorId: string





  lanes?: string[]
  run: (unblock: () => void) => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void

  enqueuedAt?: number
}

const RANK: Record<CommandPriority, number> = { high: 0, normal: 1, low: 2 }







const GLOBAL_LANE = '\u0000global'


























export class PriorityCommandQueue {
  private readonly high: QueuedTask[] = []
  private readonly normal: QueuedTask[] = []
  private readonly low: QueuedTask[] = []
  private readonly maxQueueLength: number
  private readonly agePromoteMs: number
  private readonly now: () => number
  private readonly busyLanes = new Set<string>()

  constructor(options: { maxQueueLength?: number; agePromoteMs?: number; now?: () => number } = {}) {
    this.maxQueueLength = options.maxQueueLength ?? 500
    this.agePromoteMs = options.agePromoteMs ?? 5_000
    this.now = options.now ?? Date.now
  }

  get totalLength(): number {
    return this.high.length + this.normal.length + this.low.length
  }


  get busyLaneCount(): number {
    return this.busyLanes.size
  }

  enqueue<T>(task: {
    id: string
    priority?: CommandPriority
    actorId: string
    lanes?: string[]
    run: (unblock: () => void) => Promise<T>
  }): Promise<T> {
    if (this.totalLength >= this.maxQueueLength) {
      throw new CommandError('backpressure', '429 Command queue overflow: server is experiencing high load')
    }

    return new Promise<T>((resolve, reject) => {
      const priority = task.priority ?? 'normal'
      const item: QueuedTask = {
        id: task.id,
        priority,
        actorId: task.actorId,
        lanes: task.lanes && task.lanes.length > 0 ? [...task.lanes] : [GLOBAL_LANE],
        run: task.run as (unblock: () => void) => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        enqueuedAt: this.now()
      }

      if (priority === 'high') this.high.push(item)
      else if (priority === 'low') this.low.push(item)
      else this.normal.push(item)

      this.pump()
    })
  }


  private rankOf(item: QueuedTask): number {
    const rank = RANK[item.priority]
    const waited = this.now() - (item.enqueuedAt ?? this.now())
    return waited >= this.agePromoteMs ? Math.max(0, rank - 1) : rank
  }








  private pickNext(): QueuedTask | undefined {
    let best: QueuedTask | undefined
    let bestBucket: QueuedTask[] | undefined
    let bestRank = Number.POSITIVE_INFINITY
    let bestAt = Number.POSITIVE_INFINITY
    for (const bucket of [this.high, this.normal, this.low]) {
      for (const item of bucket) {
        if (item.lanes && item.lanes.some((lane) => this.busyLanes.has(lane))) continue
        const rank = this.rankOf(item)
        const at = item.enqueuedAt ?? 0
        if (rank < bestRank || (rank === bestRank && at < bestAt)) {
          best = item
          bestBucket = bucket
          bestRank = rank
          bestAt = at
        }
      }
    }
    if (!best || !bestBucket) return undefined
    const index = bestBucket.indexOf(best)
    bestBucket.splice(index, 1)
    return best
  }

  private pump(): void {


    for (;;) {
      const next = this.pickNext()
      if (!next) return
      this.start(next)
    }
  }

  private start(item: QueuedTask): void {
    if (item.lanes) for (const lane of item.lanes) this.busyLanes.add(lane)
    let handedOn = false
    const release = (): void => {
      if (item.lanes) for (const lane of item.lanes) this.busyLanes.delete(lane)
      this.pump()
    }
    const unblock = (): void => {
      if (handedOn) return
      handedOn = true
      release()
    }

    let pending: Promise<unknown>
    try {
      pending = Promise.resolve(item.run(unblock))
    } catch (err) {

      release()
      item.reject(err)
      return
    }
    pending.then(
      (val) => {
        if (!handedOn) release()
        item.resolve(val)
      },
      (err) => {
        if (!handedOn) release()
        item.reject(err)
      }
    )
  }
}
