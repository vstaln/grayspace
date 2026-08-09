import { EventEmitter } from 'events'
import type { JournalEntry, JournalPhase, ResourceId } from './types.ts'

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
}

/**
 * The append-only log of everything that happened, in the order it happened.
 *
 * It is deliberately one log rather than several: the canvas undo stack, the
 * audit trail of who changed what, crash recovery, and the assistant's
 * checkpoints are all the same question — "what has been done so far?" — and
 * answering it from four places is how the four-store problem started.
 */
export class Journal extends EventEmitter {
  private readonly entries: JournalEntry[] = []
  private readonly sink?: JournalSink
  private readonly now: () => number
  private readonly memoryLimit: number
  private seq: number

  constructor(options: JournalOptions = {}) {
    super()
    this.sink = options.sink
    this.now = options.now ?? Date.now
    this.memoryLimit = options.memoryLimit ?? 5_000
    this.seq = options.startSeq ?? 0
  }

  get lastSeq(): number {
    return this.seq
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
    const entry: JournalEntry = { seq: this.seq, at: this.now(), ...input }
    this.entries.push(entry)
    // The in-memory window is a cache for recovery and the UI; the sink is the
    // durable copy, so trimming here loses nothing.
    if (this.entries.length > this.memoryLimit) this.entries.splice(0, this.entries.length - this.memoryLimit)
    try {
      this.sink?.append(entry)
    } catch (err) {
      // A journal write that fails must not take the command down with it: the
      // state change already happened, and losing the audit line is the lesser
      // failure. It is logged loudly instead.
      console.error('failed to persist journal entry', err)
    }
    this.emit('entry', entry)
    return entry
  }

  /** Entries after `seq`, oldest first — the renderer's change stream. */
  since(seq: number, limit = 500): JournalEntry[] {
    const out: JournalEntry[] = []
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i]
      if (entry.seq <= seq) break
      out.push(entry)
      if (out.length >= limit) break
    }
    return out.reverse()
  }

  recent(limit = 100): JournalEntry[] {
    return this.entries.slice(-limit)
  }

  /**
   * Commands whose `intent` was written but which never reached `commit` or
   * `abort` — i.e. the app died mid-apply. The recovery path checks each one
   * against actual state before deciding to replay it, because a half-executed
   * destructive command replayed blindly is worse than one left alone.
   */
  unfinished(): JournalEntry[] {
    const open = new Map<string, JournalEntry>()
    for (const entry of this.entries) {
      const key = `${entry.type}|${entry.target}|${entry.actorId}`
      if (entry.phase === 'intent') open.set(key, entry)
      else open.delete(key)
    }
    return Array.from(open.values())
  }

  flush(): void {
    this.sink?.flush?.()
  }
}
