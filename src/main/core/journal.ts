import { EventEmitter } from 'events'
import { createHash } from 'crypto'
import type { JournalEntry, JournalPhase, ResourceId } from './types.ts'

export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000'

/**
 * Computes deterministic cryptographic SHA-256 hash for a journal entry.
 */
export function computeEntryHash(
  prevHash: string,
  entry: {
    seq: number
    at: number
    phase: JournalPhase
    actorId: string
    type: string
    target: ResourceId
    payload?: unknown
    version?: number
    error?: string
  }
): string {
  const content = JSON.stringify({
    prev: prevHash,
    seq: entry.seq,
    at: entry.at,
    phase: entry.phase,
    actorId: entry.actorId,
    type: entry.type,
    target: entry.target,
    version: entry.version ?? null,
    error: entry.error ?? null,
    payload: entry.payload ?? null
  })
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Where journal entries go once the bus has produced them. Kept as an
 * interface so `core/` stays filesystem-free: the app plugs in an NDJSON file
 * sink, tests plug in nothing at all.
 */
export interface JournalSink {
  append(entry: JournalEntry): void
  /** Called on shutdown; must flush anything buffered. */
  flush?(): void
}

export interface JournalOptions {
  sink?: JournalSink
  now?: () => number
  /** How many entries to keep in memory for the recovery/undo window. */
  memoryLimit?: number
  /** Sequence to continue from after a restart (highest seq already on disk). */
  startSeq?: number
  /** Tail already on disk — loaded so recovery and `since()` work after restart. */
  seed?: readonly JournalEntry[]
}

/**
 * The append-only, tamper-evident log of everything that happened.
 *
 * Implements cryptographic hash-chaining: each entry contains the SHA-256 hash
 * of its predecessor, making any tampering, deletion or alteration mathematically detectable.
 */
export class Journal extends EventEmitter {
  private readonly entries: JournalEntry[] = []
  private readonly sink?: JournalSink
  private readonly now: () => number
  private readonly memoryLimit: number
  private seq: number
  private lastHash: string = GENESIS_HASH

  constructor(options: JournalOptions = {}) {
    super()
    this.sink = options.sink
    this.now = options.now ?? Date.now
    this.memoryLimit = options.memoryLimit ?? 5_000
    this.seq = options.startSeq ?? 0
    if (options.seed?.length) {
      this.entries.push(...options.seed)
      if (this.entries.length > this.memoryLimit) {
        this.entries.splice(0, this.entries.length - this.memoryLimit)
      }
      const maxSeq = options.seed.reduce((max, entry) => Math.max(max, entry.seq), 0)
      if (maxSeq > this.seq) this.seq = maxSeq
      const last = options.seed[options.seed.length - 1]
      this.lastHash = last.hash || computeEntryHash(last.prevHash || GENESIS_HASH, last)
    }
  }

  get lastSeq(): number {
    return this.seq
  }

  get currentHash(): string {
    return this.lastHash
  }

  append(input: {
    phase: JournalPhase
    actorId: string
    type: string
    target: ResourceId
    payload?: unknown
    version?: number
    error?: string
  }): JournalEntry {
    this.seq += 1
    const at = this.now()
    const prevHash = this.lastHash
    const hash = computeEntryHash(prevHash, { seq: this.seq, at, ...input })
    this.lastHash = hash

    const entry: JournalEntry = {
      seq: this.seq,
      at,
      prevHash,
      hash,
      ...input
    }

    this.entries.push(entry)
    if (this.entries.length > this.memoryLimit) this.entries.splice(0, this.entries.length - this.memoryLimit)
    try {
      this.sink?.append(entry)
    } catch (err) {
      console.error('failed to persist journal entry', err)
    }
    this.emit('entry', entry)
    return entry
  }

  /**
   * Verifies the cryptographic hash-chain of all entries.
   * Returns `{ valid: true }` if untouched, or details of the first broken entry.
   */
  verifyIntegrity(entries: readonly JournalEntry[] = this.entries): {
    valid: boolean
    totalEntries: number
    brokenSeq?: number
    reason?: string
  } {
    let expectedPrevHash = entries.length > 0 && entries[0].prevHash ? entries[0].prevHash : GENESIS_HASH
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      if (entry.prevHash && entry.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          totalEntries: entries.length,
          brokenSeq: entry.seq,
          reason: `prevHash mismatch at seq ${entry.seq}: expected ${expectedPrevHash}, got ${entry.prevHash}`
        }
      }
      const calculatedHash = computeEntryHash(entry.prevHash || expectedPrevHash, entry)
      if (entry.hash && entry.hash !== calculatedHash) {
        return {
          valid: false,
          totalEntries: entries.length,
          brokenSeq: entry.seq,
          reason: `hash mismatch at seq ${entry.seq}: expected ${calculatedHash}, got ${entry.hash}`
        }
      }
      expectedPrevHash = entry.hash || calculatedHash
    }
    return { valid: true, totalEntries: entries.length }
  }

  /** Entries after `seq`, oldest first — the renderer's change stream. */
  since(seq: number, limit = 500): JournalEntry[] {
    // Walk forward from the cursor so the limit drops the NEWEST entries,
    // never the ones the consumer has not seen yet.
    const out: JournalEntry[] = []
    for (const entry of this.entries) {
      if (entry.seq <= seq) continue
      out.push(entry)
      if (out.length >= limit) break
    }
    return out
  }

  recent(limit = 100): JournalEntry[] {
    return this.entries.slice(-limit)
  }

  /** All in-memory journal entries in sequence order. */
  all(): JournalEntry[] {
    return this.entries.slice()
  }

  /** All committed events (phase === 'commit') in sequence order. */
  allCommits(): JournalEntry[] {
    return this.entries.filter((e) => e.phase === 'commit')
  }

  /** Committed events after sequence `seq`. */
  commitsSince(seq: number, limit = 5_000): JournalEntry[] {
    const out: JournalEntry[] = []
    for (const entry of this.entries) {
      if (entry.seq > seq && entry.phase === 'commit') {
        out.push(entry)
        if (out.length >= limit) break
      }
    }
    return out
  }

  /** Committed events addressing a specific target resource. */
  commitsForTarget(target: ResourceId): JournalEntry[] {
    return this.entries.filter((e) => e.phase === 'commit' && e.target === target)
  }

  unfinished(): JournalEntry[] {
    const stacks = new Map<string, JournalEntry[]>()
    for (const entry of this.entries) {
      const key = `${entry.type}|${entry.target}|${entry.actorId}`
      if (entry.phase === 'intent') {
        const stack = stacks.get(key) ?? []
        stack.push(entry)
        stacks.set(key, stack)
        continue
      }
      const stack = stacks.get(key)
      if (stack?.length) stack.pop()
    }
    return Array.from(stacks.values()).flat()
  }

  flush(): void {
    this.sink?.flush?.()
  }
}
