// Keep writes to xterm small; the main process applies PTY backpressure to bound this queue.
export class TerminalRenderQueue {
  private pending = ''
  private acceptedLength = 0
  private parsedLength = 0
  private readonly parsedCallbacks: Array<{ length: number; callback: () => void }> = []
  private busy = false
  private paused = false
  private disposed = false
  private readonly write: (data: string, done: () => void) => void
  private readonly schedule: () => void
  private readonly chunkSize: number

  /**
   * Each event task hands one bounded chunk to the parser. Smaller chunks
   * leave time for keyboard and paint events; callbacks provide backpressure.
   * Scheduling is independent of animation frames, so throughput is not
   * capped at one chunk per display refresh.
   *
   * PTY output is lossless. The sender pauses the process when parser debt
   * grows, so this queue stays bounded without deleting control sequences.
   */
  constructor(
    write: (data: string, done: () => void) => void,
    schedule: () => void,
    chunkSize = 32 * 1024
  ) {
    this.write = write
    this.schedule = schedule
    this.chunkSize = Math.max(2, chunkSize)
  }

  get pendingLength(): number { return this.pending.length }

  push(data: string, onParsed?: () => void): void {
    if (this.disposed) return
    if (!data) {
      if (onParsed) this.whenParsed(this.acceptedLength, onParsed)
      return
    }
    this.acceptedLength += data.length
    this.pending += data
    if (onParsed) this.whenParsed(this.acceptedLength, onParsed)
    if (!this.busy && !this.paused) this.schedule()
  }

  afterPending(onParsed: () => void): void {
    if (this.disposed) return
    this.whenParsed(this.acceptedLength, onParsed)
  }

  private whenParsed(length: number, callback: () => void): void {
    if (length <= this.parsedLength) callback()
    else this.parsedCallbacks.push({ length, callback })
  }

  pause(paused: boolean): void {
    this.paused = paused
    if (!paused && this.pending) this.schedule()
  }

  flush(): void {
    if (this.disposed || this.paused || this.busy || !this.pending) return
    let end = Math.min(this.chunkSize, this.pending.length)
    if (end < this.pending.length && isLowSurrogate(this.pending.charCodeAt(end))) end -= 1
    const data = this.pending.slice(0, end)
    this.pending = this.pending.slice(end)
    this.busy = true
    try {
      this.write(data, () => {
        this.busy = false
        this.parsedLength += end
        while (this.parsedCallbacks[0]?.length <= this.parsedLength) {
          try {
            this.parsedCallbacks.shift()?.callback()
          } catch (error) {
            console.warn('terminal parser completion callback failed', error)
          }
        }
        if (!this.disposed && !this.paused && this.pending) this.schedule()
      })
    } catch (error) {
      this.busy = false
      this.pending = ''
      this.acceptedLength = this.parsedLength
      this.parsedCallbacks.length = 0
      console.warn('terminal parser write failed', error)
    }
  }

  dispose(): void {
    this.disposed = true
    this.pending = ''
    this.parsedCallbacks.length = 0
  }
}

function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff }
