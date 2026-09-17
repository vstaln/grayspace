import { join } from 'path'
import { readStoreJson, writeJsonAtomic, writeJsonAtomicAsync } from './storage.ts'
import { getUserDataDir } from './userData.ts'
import { notifyPersistError } from './persistNotifier.ts'

const SCHEMA_VERSION = 1
const MAX_KEYS = 2_000
const MAX_KEY_LENGTH = 256
const MAX_VALUE_LENGTH = 1024 * 1024
const MAX_TOTAL_LENGTH = 8 * 1024 * 1024

export interface RendererStateSnapshot {
  schemaVersion: number
  values: Record<string, string>
}

export function isDurableRendererKey(key: string): boolean {
  return key === 'workspace-theme' || key === 'rail-order' || /^orcspace(?::|-)/.test(key)
}

function sanitizeValues(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const values: Record<string, string> = Object.create(null) as Record<string, string>
  let total = 0
  let count = 0
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (count >= MAX_KEYS) break
    if (typeof value !== 'string') continue
    if (!isDurableRendererKey(key) || key.length > MAX_KEY_LENGTH || value.length > MAX_VALUE_LENGTH) continue
    if (total + key.length + value.length > MAX_TOTAL_LENGTH) continue
    values[key] = value
    total += key.length + value.length
    count += 1
  }
  return values
}

export class RendererStateStore {
  private readonly file: string
  private loaded = false
  private values: Record<string, string> = Object.create(null) as Record<string, string>
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private writeSeq = 0
  private syncFlushedSeq = 0

  constructor(file = join(getUserDataDir(), 'renderer-state.json')) {
    this.file = file
  }

  snapshot(): RendererStateSnapshot {
    this.ensureLoaded()
    return { schemaVersion: SCHEMA_VERSION, values: { ...this.values } }
  }

  replace(input: unknown): RendererStateSnapshot {
    this.ensureLoaded()
    this.values = sanitizeValues(input)
    this.writeSeq += 1
    this.schedulePersist()
    return this.snapshot()
  }

  set(key: unknown, value: unknown): boolean {
    this.ensureLoaded()
    if (typeof key !== 'string' || typeof value !== 'string') return false
    if (!isDurableRendererKey(key) || key.length > MAX_KEY_LENGTH || value.length > MAX_VALUE_LENGTH) return false
    const next = { ...this.values, [key]: value }
    const sanitized = sanitizeValues(next)
    if (sanitized[key] !== value) return false
    this.values = sanitized
    this.writeSeq += 1
    this.schedulePersist()
    return true
  }

  remove(key: unknown): boolean {
    this.ensureLoaded()
    if (typeof key !== 'string' || !isDurableRendererKey(key)) return false
    if (!Object.prototype.hasOwnProperty.call(this.values, key)) return true
    const next = { ...this.values }
    delete next[key]
    this.values = next
    this.writeSeq += 1
    this.schedulePersist()
    return true
  }

  flush(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (!this.loaded) return
    try {
      writeJsonAtomic(this.file, this.payload())
      this.syncFlushedSeq = this.writeSeq
    } catch (error) {
      notifyPersistError('widget-state', error)
    }
  }

  dispose(): void {
    this.flush()
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const raw = readStoreJson<Partial<RendererStateSnapshot>>(this.file, {})
    this.values = sanitizeValues(raw.values)
  }

  private payload(): RendererStateSnapshot {
    return { schemaVersion: SCHEMA_VERSION, values: { ...this.values } }
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      const seq = this.writeSeq
      const payload = this.payload()
      this.writeChain = this.writeChain
        .catch(() => undefined)
        .then(async () => {
          if (seq <= this.syncFlushedSeq) return
          await writeJsonAtomicAsync(this.file, payload)
          if (seq <= this.syncFlushedSeq) writeJsonAtomic(this.file, this.payload())
        })
        .catch((error) => notifyPersistError('widget-state', error))
    }, 150)
    this.persistTimer.unref?.()
  }
}
