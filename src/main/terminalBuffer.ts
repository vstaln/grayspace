export interface RingBufferOptions {
  maxBytes?: number
}

/** Live entry count that triggers a merge of the oldest chunks. */
const MAX_LIVE_CHUNKS = 4096
















export class TerminalRingBuffer {
  private chunks: string[] = []








  private head = 0
  private totalBytes = 0
  private readonly maxBytes: number
  private headOffset = 0

  private joined: string | null = ''

  constructor(options: RingBufferOptions = {}) {
    this.maxBytes = options.maxBytes ?? 512 * 1024
  }

  append(chunk: string): void {
    if (!chunk) return
    this.chunks.push(chunk)
    this.totalBytes += Buffer.byteLength(chunk, 'utf8')
    this.joined = null

    while (this.totalBytes > this.maxBytes && this.head < this.chunks.length - 1) {
      const dropped = this.chunks[this.head]

      this.chunks[this.head] = ''
      this.head += 1
      this.totalBytes -= Buffer.byteLength(dropped, 'utf8')
      this.headOffset += Buffer.byteLength(dropped, 'utf8')
    }



    if (this.totalBytes > this.maxBytes && this.head === this.chunks.length - 1) {
      const last = this.chunks[this.head]
      const kept = utf8Tail(last, this.maxBytes)
      this.headOffset += Buffer.byteLength(last, 'utf8') - Buffer.byteLength(kept, 'utf8')
      this.chunks[this.head] = kept
      this.totalBytes = Buffer.byteLength(kept, 'utf8')
    }

    if (this.head > 32 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }

    // Chatty PTYs (token-by-token agent streaming, per-keystroke echoes) can
    // accumulate thousands of tiny chunks inside the byte budget. read() and
    // toString() walk the chunk list, so an unbounded entry count turns every
    // scan into main-thread jank that the PTY pump feels as backpressure.
    // Merging the oldest entries preserves every byte (and therefore every
    // offset), it only reduces the entry count.
    //
    // The merge is capped per group because a chunk is also the unit the drop
    // loop above evicts. Folding thousands of entries into one chunk made that
    // single chunk a large fraction of the whole budget, so the next append
    // past the limit threw all of it away at once: measured on token-sized
    // appends, scrollback collapsed to 6% of the budget and one eviction
    // discarded 491KB of a 512KB buffer. Grouping keeps eviction fine-grained
    // (a group is ~1.5% of the budget) while still collapsing the entry count.
    if (this.chunks.length - this.head > MAX_LIVE_CHUNKS) {
      const mergeCount = this.chunks.length - this.head - MAX_LIVE_CHUNKS / 2
      const groupBudget = Math.max(4096, Math.floor(this.maxBytes / 64))
      const merged: string[] = []
      let group: string[] = []
      let groupBytes = 0
      for (let i = this.head; i < this.head + mergeCount; i += 1) {
        const chunk = this.chunks[i]
        const size = Buffer.byteLength(chunk, 'utf8')
        if (group.length > 0 && groupBytes + size > groupBudget) {
          merged.push(group.join(''))
          group = []
          groupBytes = 0
        }
        group.push(chunk)
        groupBytes += size
      }
      if (group.length > 0) merged.push(group.join(''))
      this.chunks.splice(this.head, mergeCount, ...merged)
    }
  }

  get length(): number {
    return this.totalBytes
  }


  get globalOffset(): number {
    return this.headOffset + this.totalBytes
  }


  get startOffset(): number {
    return this.headOffset
  }

  read(sinceOffset: number, maxBytes = 128 * 1024): { data: string; newOffset: number } {
    if (sinceOffset >= this.globalOffset) {
      return { data: '', newOffset: this.globalOffset }
    }

    const localStart = Math.max(0, sinceOffset - this.headOffset)



    let index = this.head
    let skipped = 0
    while (index < this.chunks.length && skipped + Buffer.byteLength(this.chunks[index], 'utf8') <= localStart) {
      skipped += Buffer.byteLength(this.chunks[index], 'utf8')
      index += 1
    }
    const want = maxBytes + (localStart - skipped)
    const parts: string[] = []
    let collected = 0
    for (; index < this.chunks.length && collected < want; index += 1) {
      parts.push(this.chunks[index])
      collected += Buffer.byteLength(this.chunks[index], 'utf8')
    }
    const from = localStart - skipped
    const bytes = Buffer.from(parts.join(''), 'utf8')
    let start = Math.min(from, bytes.length)



    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
    let end = Math.min(bytes.length, start + maxBytes)
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1
    const slice = bytes.subarray(start, end).toString('utf8')

    return {
      data: slice,
      newOffset: this.headOffset + skipped + end
    }
  }

  toString(): string {
    if (this.joined === null) {
      this.joined = this.head === 0 ? this.chunks.join('') : this.chunks.slice(this.head).join('')
    }
    return this.joined
  }







  tail(maxBytes: number): string {
    if (maxBytes <= 0 || this.totalBytes === 0) return ''
    const budget = Math.min(maxBytes, this.totalBytes)
    const parts: string[] = []
    let collected = 0
    for (let i = this.chunks.length - 1; i >= this.head && collected < budget; i -= 1) {
      const chunk = this.chunks[i]
      const size = Buffer.byteLength(chunk, 'utf8')
      if (collected + size <= budget) {
        parts.unshift(chunk)
        collected += size
        continue
      }
      const need = budget - collected
      let slice = Buffer.from(chunk, 'utf8')
      let start = Math.max(0, slice.length - need)
      while (start < slice.length && (slice[start] & 0xc0) === 0x80) start += 1
      parts.unshift(slice.subarray(start).toString('utf8'))
      collected = budget
      break
    }
    return parts.join('')
  }

  clear(): void {
    this.chunks = []
    this.head = 0
    this.totalBytes = 0
    this.headOffset = 0
    this.joined = ''
  }
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  // Start on a real character boundary rather than decoding a split sequence
  // and stripping the U+FFFD afterwards: that replacement re-encodes to three
  // bytes regardless of how many the broken sequence occupied, so the caller's
  // `byteLength(last) - byteLength(kept)` no longer equalled the bytes actually
  // dropped and headOffset drifted \u2014 every later read(sinceOffset) returned
  // data shifted by the accumulated error.
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
  return bytes.subarray(start).toString('utf8')
}
