import { createHash } from 'crypto'
import * as fs from 'fs'
import { dirname, join } from 'path'

export interface CasStats {
  totalObjects: number
  totalBytes: number
}

/**
 * Content-Addressed Storage (CAS) for deduplicated immutable artifacts:
 * diffs, command stdout, PTY logs, checkpoints, snapshots.
 *
 * Objects are stored as `cas/objects/ab/cdef1234...` named by sha256(content).
 */
export class ContentAddressedStore {
  private readonly rootDir: string
  private readonly memoryStore = new Map<string, Buffer>()
  private readonly useMemoryOnly: boolean

  constructor(options: { rootDir?: string; inMemory?: boolean } = {}) {
    this.rootDir = options.rootDir ?? ''
    this.useMemoryOnly = options.inMemory ?? !options.rootDir
    if (!this.useMemoryOnly && this.rootDir) {
      try {
        fs.mkdirSync(join(this.rootDir, 'objects'), { recursive: true })
      } catch {
        /* ignore */
      }
    }
  }

  static hash(content: string | Buffer): string {
    return createHash('sha256').update(content).digest('hex')
  }

  private objectPath(hash: string): string {
    const prefix = hash.slice(0, 2)
    const rest = hash.slice(2)
    return join(this.rootDir, 'objects', prefix, rest)
  }

  put(content: string | Buffer): string {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    const hash = ContentAddressedStore.hash(buf)

    if (this.useMemoryOnly) {
      this.memoryStore.set(hash, buf)
      return hash
    }

    const filePath = this.objectPath(hash)
    if (fs.existsSync(filePath)) return hash

    fs.mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, filePath)
    return hash
  }

  putJson(data: unknown): string {
    return this.put(JSON.stringify(data))
  }

  get(hash: string): Buffer | null {
    if (this.useMemoryOnly) {
      return this.memoryStore.get(hash) ?? null
    }

    const filePath = this.objectPath(hash)
    if (!fs.existsSync(filePath)) return null
    try {
      return fs.readFileSync(filePath)
    } catch {
      return null
    }
  }

  getText(hash: string): string | null {
    const buf = this.get(hash)
    return buf ? buf.toString('utf8') : null
  }

  getJson<T = unknown>(hash: string): T | null {
    const text = this.getText(hash)
    if (!text) return null
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  has(hash: string): boolean {
    if (this.useMemoryOnly) {
      return this.memoryStore.has(hash)
    }
    return fs.existsSync(this.objectPath(hash))
  }

  stats(): CasStats {
    if (this.useMemoryOnly) {
      let bytes = 0
      for (const buf of this.memoryStore.values()) bytes += buf.length
      return { totalObjects: this.memoryStore.size, totalBytes: bytes }
    }

    let totalObjects = 0
    let totalBytes = 0
    const objectsDir = join(this.rootDir, 'objects')
    if (!fs.existsSync(objectsDir)) return { totalObjects: 0, totalBytes: 0 }

    for (const prefix of fs.readdirSync(objectsDir)) {
      const prefixDir = join(objectsDir, prefix)
      if (!fs.statSync(prefixDir).isDirectory()) continue
      for (const file of fs.readdirSync(prefixDir)) {
        const stat = fs.statSync(join(prefixDir, file))
        if (stat.isFile()) {
          totalObjects += 1
          totalBytes += stat.size
        }
      }
    }

    return { totalObjects, totalBytes }
  }

  /**
   * Garbage Collector: removes all blobs not present in `referencedHashes`.
   */
  gc(referencedHashes: Iterable<string>): { removed: number; freedBytes: number } {
    const keep = new Set(referencedHashes)
    let removed = 0
    let freedBytes = 0

    if (this.useMemoryOnly) {
      for (const [hash, buf] of this.memoryStore.entries()) {
        if (!keep.has(hash)) {
          freedBytes += buf.length
          removed += 1
          this.memoryStore.delete(hash)
        }
      }
      return { removed, freedBytes }
    }

    const objectsDir = join(this.rootDir, 'objects')
    if (!fs.existsSync(objectsDir)) return { removed: 0, freedBytes: 0 }

    for (const prefix of fs.readdirSync(objectsDir)) {
      const prefixDir = join(objectsDir, prefix)
      if (!fs.statSync(prefixDir).isDirectory()) continue
      for (const file of fs.readdirSync(prefixDir)) {
        const hash = `${prefix}${file}`
        if (!keep.has(hash)) {
          const filePath = join(prefixDir, file)
          try {
            const stat = fs.statSync(filePath)
            freedBytes += stat.size
            fs.unlinkSync(filePath)
            removed += 1
          } catch {
            /* ignore */
          }
        }
      }
    }

    return { removed, freedBytes }
  }
}
