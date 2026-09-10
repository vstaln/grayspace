export interface TerminalOutputGateOptions {
  intervalMs?: number
  maxDispatchBytes?: number
  maxPendingBytes?: number
}

type Queue = {
  chunks: string[]
  bytes: number
}

/**
 * Keeps a noisy PTY from flooding Electron's renderer IPC queue.
 * The complete output is still retained by TerminalManager; this gate only
 * limits the live view so keyboard input and window controls stay responsive.
 */
export class TerminalOutputGate {
  private readonly queues = new Map<string, Queue>()
  private readonly send: (terminalId: string, chunk: string) => void
  private readonly intervalMs: number
  private readonly maxDispatchBytes: number
  private readonly maxPendingBytes: number
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    send: (terminalId: string, chunk: string) => void,
    options: TerminalOutputGateOptions = {}
  ) {
    this.send = send
    this.intervalMs = options.intervalMs ?? 32
    this.maxDispatchBytes = options.maxDispatchBytes ?? 16 * 1024
    this.maxPendingBytes = options.maxPendingBytes ?? 256 * 1024
  }

  enqueue(terminalId: string, chunk: string): void {
    if (!chunk) return
    let queue = this.queues.get(terminalId)
    if (!queue) {
      queue = { chunks: [], bytes: 0 }
      this.queues.set(terminalId, queue)
    }

    let chunkBytes = Buffer.byteLength(chunk, 'utf8')
    while (queue.chunks.length > 0 && queue.bytes + chunkBytes > this.maxPendingBytes) {
      const dropped = queue.chunks.shift()!
      queue.bytes -= Buffer.byteLength(dropped, 'utf8')
    }
    if (chunkBytes > this.maxPendingBytes) {
      chunk = truncateToBytes(chunk, this.maxPendingBytes)
      chunkBytes = Buffer.byteLength(chunk, 'utf8')
    }
    queue.chunks.push(chunk)
    queue.bytes += chunkBytes
    this.schedule()
  }

  /** Send all currently queued output, used before the exit marker. */
  flush(terminalId: string): void {
    const queue = this.queues.get(terminalId)
    if (!queue) return
    while (queue.chunks.length > 0) this.dispatch(queue, terminalId, Number.MAX_SAFE_INTEGER)
    this.queues.delete(terminalId)
    this.scheduleIfNeeded()
  }

  clear(terminalId: string): void {
    this.queues.delete(terminalId)
    this.scheduleIfNeeded()
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.queues.clear()
  }

  private schedule(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.drain()
    }, this.intervalMs)
    this.timer.unref?.()
  }

  private scheduleIfNeeded(): void {
    if (this.queues.size > 0) this.schedule()
  }

  private drain(): void {
    for (const [terminalId, queue] of this.queues) {
      this.dispatch(queue, terminalId, this.maxDispatchBytes)
      if (queue.chunks.length === 0) this.queues.delete(terminalId)
    }
    this.scheduleIfNeeded()
  }

  private dispatch(queue: Queue, terminalId: string, limit: number): void {
    let remaining = limit
    const parts: string[] = []
    while (queue.chunks.length > 0 && remaining > 0) {
      const chunk = queue.chunks[0]
      const chunkBytes = Buffer.byteLength(chunk, 'utf8')
      if (chunkBytes <= remaining) {
        parts.push(chunk)
        queue.chunks.shift()
        queue.bytes -= chunkBytes
        remaining -= chunkBytes
      } else {
        const head = splitAtBytes(chunk, remaining)
        parts.push(head[0])
        queue.chunks[0] = head[1]
        queue.bytes -= Buffer.byteLength(head[0], 'utf8')
        remaining = 0
      }
    }
    if (parts.length > 0) this.send(terminalId, parts.join(''))
  }
}

function truncateToBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(s.slice(s.length - mid), 'utf8') <= maxBytes) lo = mid
    else hi = mid - 1
  }
  let out = s.slice(s.length - lo)
  while (out && /[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1)
  return fixLoneSurrogateStart(out)
}

function splitAtBytes(s: string, maxBytes: number): [string, string] {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return [s, '']
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid
    else hi = mid - 1
  }
  let idx = lo
  while (idx > 0 && idx < s.length && /[\uD800-\uDBFF]$/.test(s.slice(0, idx))) idx -= 1
  return [s.slice(0, idx), s.slice(idx)]
}

function fixLoneSurrogateStart(s: string): string {
  return /^[\uDC00-\uDFFF]/.test(s) ? s.slice(1) : s
}
