import { EventEmitter } from 'events'

export interface BatcherOptions {
  frameIntervalMs?: number
  maxBatchBytes?: number
}

/** Coalesces PTY reads without dropping or rewriting terminal bytes. */
export class TerminalStreamBatcher extends EventEmitter {
  private readonly pending = new Map<string, string[]>()
  private readonly pendingBytes = new Map<string, number>()
  private readonly frameIntervalMs: number
  private readonly maxBatchBytes: number
  private timer: NodeJS.Timeout | null = null
  private immediate: NodeJS.Immediate | null = null

  constructor(options: BatcherOptions = {}) {
    super()
    this.frameIntervalMs = options.frameIntervalMs ?? 0
    this.maxBatchBytes = options.maxBatchBytes ?? 32 * 1024
  }

  push(terminalId: string, chunk: string): void {
    if (!chunk) return
    const list = this.pending.get(terminalId) ?? []
    list.push(chunk)
    this.pending.set(terminalId, list)
    const bytes = (this.pendingBytes.get(terminalId) ?? 0) + Buffer.byteLength(chunk, 'utf8')
    this.pendingBytes.set(terminalId, bytes)

    if (bytes >= this.maxBatchBytes) this.flushTerminal(terminalId)
    else this.ensureTimer()
  }

  private ensureTimer(): void {
    if (this.timer !== null || this.immediate !== null) return
    if (this.frameIntervalMs <= 0) {
      // Coalesce the current I/O turn without delaying keyboard echo by a frame.
      this.immediate = setImmediate(() => {
        this.immediate = null
        this.flushAll()
      })
      this.immediate.unref?.()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.flushAll()
    }, this.frameIntervalMs)
    this.timer.unref?.()
  }

  flush(terminalId: string): void {
    this.flushTerminal(terminalId)
  }

  private flushTerminal(terminalId: string): void {
    const list = this.pending.get(terminalId)
    if (!list?.length) return
    const combined = list.length === 1 ? list[0] : list.join('')
    this.pending.delete(terminalId)
    this.pendingBytes.delete(terminalId)
    this.emit('batch', terminalId, combined)
  }

  flushAll(): void {
    if (this.immediate !== null) {
      clearImmediate(this.immediate)
      this.immediate = null
    }
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const id of Array.from(this.pending.keys())) this.flushTerminal(id)
  }

  dispose(): void {
    if (this.immediate !== null) {
      clearImmediate(this.immediate)
      this.immediate = null
    }
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
    this.pendingBytes.clear()
  }
}
