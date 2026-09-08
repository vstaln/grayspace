import type { CommandResult, TransactionResult } from './types.ts'

export type IdempotentPayload<T = unknown> = CommandResult<T> | TransactionResult<T>

export interface IdempotencyRecord<T = unknown> {
  key: string
  at: number
  result?: CommandResult<T> | TransactionResult<T>
  inFlight?: Promise<CommandResult<T> | TransactionResult<T>>
}







export class IdempotencyCache {
  private readonly entries = new Map<string, IdempotencyRecord<any>>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? 2_000
    this.ttlMs = options.ttlMs ?? 10 * 60_000
    this.now = options.now ?? Date.now
  }

  get<T = unknown, R extends CommandResult<T> | TransactionResult<T> = CommandResult<T>>(
    key: string
  ): { key: string; at: number; result?: R; inFlight?: Promise<R> } | undefined {
    const record = this.entries.get(key)
    if (!record) return undefined
    if (this.now() - record.at > this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return record as { key: string; at: number; result?: R; inFlight?: Promise<R> }
  }

  track<T = unknown>(key: string, promise: Promise<CommandResult<T> | TransactionResult<T>>): void {
    this.prune()
    const record: IdempotencyRecord<T> = {
      key,
      at: this.now(),
      inFlight: promise
    }
    this.entries.set(key, record)

    promise.then(
      (result) => {
        const current = this.entries.get(key)
        if (current) {
          current.result = { ...result, cached: true } as any
          current.inFlight = undefined
        }
      },
      () => {

        this.entries.delete(key)
      }
    )
  }

  set<T = unknown>(key: string, result: CommandResult<T> | TransactionResult<T>): void {
    this.prune()
    this.entries.set(key, {
      key,
      at: this.now(),
      result: { ...result, cached: true } as any
    })
  }

  has(key: string): boolean {
    return this.get(key) !== undefined
  }

  clear(): void {
    this.entries.clear()
  }

  size(): number {
    return this.entries.size
  }

  private prune(): void {
    const now = this.now()

    for (const [k, v] of this.entries.entries()) {
      if (now - v.at > this.ttlMs) this.entries.delete(k)
    }
    if (this.entries.size < this.maxEntries) return





    for (const [k, v] of this.entries.entries()) {
      if (v.inFlight !== undefined) continue
      this.entries.delete(k)
      if (this.entries.size < this.maxEntries) return
    }
  }
}
