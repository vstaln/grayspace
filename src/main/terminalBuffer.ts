export interface RingBufferOptions {
  maxBytes?: number
}
















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
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const bytes = Buffer.from(value, 'utf8')
  let out = bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString('utf8')


  while (out.startsWith('\uFFFD')) out = out.slice(1)
  return out
}
