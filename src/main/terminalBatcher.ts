import { EventEmitter } from 'events'

export interface BatcherOptions {
  frameIntervalMs?: number
  maxBatchBytes?: number
}

/**
 * Frame-aligned terminal stream batcher (60 FPS / 16ms or 32KB threshold).
 * Consolidates high-frequency PTY chunks into single IPC messages per animation frame,
 * preventing UI thread starvation when multiple terminals stream build outputs.
 */
export class TerminalStreamBatcher extends EventEmitter {
  private readonly pending = new Map<string, string[]>()
  private readonly pendingBytes = new Map<string, number>()
  private readonly frameIntervalMs: number
  private readonly maxBatchBytes: number
  private timer: NodeJS.Timeout | null = null

  constructor(options: BatcherOptions = {}) {
    super()
    this.frameIntervalMs = options.frameIntervalMs ?? 16 // ~60 FPS
    this.maxBatchBytes = options.maxBatchBytes ?? 32 * 1024 // 32 KB threshold
  }

  push(terminalId: string, chunk: string): void {
    if (!chunk) return

    let list = this.pending.get(terminalId)
    if (!list) {
      list = []
      this.pending.set(terminalId, list)
      this.pendingBytes.set(terminalId, 0)
    }

    list.push(chunk)
    const currentBytes = (this.pendingBytes.get(terminalId) || 0) + chunk.length
    this.pendingBytes.set(terminalId, currentBytes)

    if (currentBytes >= this.maxBatchBytes) {
      this.flushTerminal(terminalId)
    } else {
      this.ensureTimer()
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flushAll()
    }, this.frameIntervalMs)
    this.timer.unref?.()
  }

  /** Flushes one terminal's pending batch immediately, bypassing the frame
   *  timer — used right before an exit/detach notice so the last output chunk
   *  cannot arrive after (and thus render below) that notice. */
  flush(terminalId: string): void {
    this.flushTerminal(terminalId)
  }

  private flushTerminal(terminalId: string): void {
    const list = this.pending.get(terminalId)
    if (!list || list.length === 0) return

    const combined = list.length === 1 ? list[0] : list.join('')
    this.pending.delete(terminalId)
    this.pendingBytes.delete(terminalId)

    this.emit('batch', terminalId, combined)
  }

  flushAll(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (this.pending.size === 0) return

    const ids = Array.from(this.pending.keys())
    for (const id of ids) {
      this.flushTerminal(id)
    }
  }

  dispose(): void {
    this.flushAll()
  }
}
