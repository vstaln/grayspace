import { CommandError, type CommandPriority } from './types.ts'

export interface TokenBucketOptions {
  capacity?: number
  refillPerSec?: number
  now?: () => number
}

/**
 * Token Bucket Rate Limiter per actor to prevent loop runaway.
 */
export class ActorRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>()
  private readonly capacity: number
  private readonly refillPerSec: number
  private readonly now: () => number

  constructor(options: TokenBucketOptions = {}) {
    this.capacity = options.capacity ?? 30 // Burst max 30 commands
    this.refillPerSec = options.refillPerSec ?? 20 // 20 commands / sec
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
  /**
   * Resource lanes this task contends for (normalized target ids). Tasks on
   * disjoint lanes run concurrently; tasks sharing any lane run one at a
   * time. Empty or omitted means "contends for nothing" — always runnable.
   */
  lanes?: string[]
  run: (unblock: () => void) => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
  /** Set by the queue at enqueue time; drives starvation-aging. */
  enqueuedAt?: number
}

const RANK: Record<CommandPriority, number> = { high: 0, normal: 1, low: 2 }

/**
 * Lane assigned to tasks submitted without one. Direct users of the queue
 * (tests, tools) get the historical behaviour — one global lane, nothing ever
 * overlaps — while callers that declare lanes, like the CommandBus, opt into
 * per-resource concurrency explicitly.
 */
const GLOBAL_LANE = '\u0000global'

/**
 * Lane-aware priority queue with backpressure, user preemption and aging.
 *
 * The old design serialized *every* write through a single lane: correct for
 * shared state, but it parked a keystroke behind an unrelated agent's paced
 * terminal write, which is why `transient`/`bypassQueue` escape hatches had to
 * exist. Lanes fix the actual granularity: writes serialize **per resource**
 * (the thing the lock gate protects anyway), not globally.
 *
 * Selection rule: among tasks whose lanes are all free, the most senior
 * (effective priority, then age) wins. A task whose lane is busy is skipped —
 * it could not run anyway, and holding the whole queue behind it would rebuild
 * the single-lane stall through the back door. Same-lane tasks never run
 * concurrently because starting a task marks its lanes busy until it settles
 * or hands them on via `unblock()`.
 *
 * Transactions claim all their lanes up front, all-or-nothing: a transaction
 * waits in the queue rather than holding some lanes while waiting for others,
 * so circular wait — and therefore deadlock — cannot arise regardless of the
 * order targets appear in.
 *
 * Aging promotes a waiting task one priority level after `agePromoteMs`, so a
 * sustained stream of user commands delays `low` background work by seconds,
 * not forever.
 */
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

  /** Lanes currently held by running tasks — exposed for metrics/debugging. */
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

  /** Effective priority rank after aging: lower runs first (0 = high). */
  private rankOf(item: QueuedTask): number {
    const rank = RANK[item.priority]
    const waited = this.now() - (item.enqueuedAt ?? this.now())
    return waited >= this.agePromoteMs ? Math.max(0, rank - 1) : rank
  }

  /**
   * Most senior task whose lanes are all free, or undefined. Seniority is
   * (effective rank, then oldest enqueue) so aged work is not starved by a
   * fresh stream of higher-priority-but-equal-rank arrivals. Tasks whose lanes
   * are busy are skipped entirely: they cannot run, and stalling every freer
   * lane behind them would rebuild the single-lane queue through the back door.
   */
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
    // Start every runnable task, not just one: disjoint lanes mean several
    // handlers may legitimately be in flight at once.
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
      // A synchronously throwing run() must not leave lanes stuck busy.
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
