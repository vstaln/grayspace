import { EventEmitter } from 'events'
import * as fs from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { readStoreJson, writeJsonAtomic, writeJsonAtomicAsync } from './storage.ts'
import { getUserDataDir } from './userData.ts'
import { registerCanvasWorkspaceListener } from './canvasState.ts'

export const CODE_SCHEMA_VERSION = 1
const EMPTY_WORKSPACE_SLOT = '__no-workspace__'
const MAX_SESSIONS = 32

export interface CodeSession {
  id: string
  agentId: string
  label: string
  command: string
  title?: string
}

export type WorkView = 'canvas' | 'code' | 'browser'

export interface CodeSnapshot {
  schemaVersion: number
  sessions: CodeSession[]
  featuredId: string | null
  maximizedId: string | null
  activeView?: WorkView | null
  version: number
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function sanitizeSession(raw: unknown): CodeSession | null {
  const v = raw as Record<string, unknown>
  if (!v || !isString(v.id) || !SESSION_ID_RE.test(v.id)) return null
  if (!isString(v.agentId) || !v.agentId.trim()) return null
  if (!isString(v.label) || !v.label.trim()) return null
  if (!isString(v.command)) return null
  const title = isString(v.title) && v.title.trim() ? v.title.trim().slice(0, 128) : undefined
  return {
    id: v.id,
    agentId: String(v.agentId).slice(0, 64),
    label: String(v.label).slice(0, 64),
    command: String(v.command).slice(0, 512),
    title
  }
}

function isWorkView(v: unknown): v is WorkView {
  return v === 'canvas' || v === 'code' || v === 'browser'
}

function sanitizeSnapshot(raw: Record<string, unknown>): CodeSnapshot {
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) && raw.version > 0 ? Math.floor(raw.version) : 1
  const sessions: CodeSession[] = Array.isArray(raw.sessions)
    ? (raw.sessions.map(sanitizeSession).filter(Boolean) as CodeSession[]).slice(0, MAX_SESSIONS)
    : []
  const featuredId = isString(raw.featuredId) && SESSION_ID_RE.test(raw.featuredId) && sessions.some(s => s.id === raw.featuredId)
    ? raw.featuredId
    : null
  const maximizedId = isString(raw.maximizedId) && SESSION_ID_RE.test(raw.maximizedId) && sessions.some(s => s.id === raw.maximizedId)
    ? raw.maximizedId
    : null
  const activeView = isWorkView(raw.activeView) ? raw.activeView : null
  return {
    schemaVersion: CODE_SCHEMA_VERSION,
    sessions,
    featuredId,
    maximizedId,
    activeView,
    version
  }
}

/**
 * Persisted Code tab state — sessions + layout.
 * Per-workspace file like CanvasStore (workspace-code-{slot}.json).
 */
export class CodeStore extends EventEmitter {
  private sessions = new Map<string, CodeSession>()
  private featuredId: string | null = null
  private maximizedId: string | null = null
  private activeView: WorkView | null = null
  private version = 1
  private loaded = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private writeSeq = 0
  private syncFlushSeq = 0
  private workspaceDir: string | undefined

  constructor() {
    super()
    registerCanvasWorkspaceListener((dir) => this.switchWorkspace(dir))
  }

  private get file(): string {
    const slot = this.workspaceSlot(this.workspaceDir ?? this.readActiveWorkspaceDir())
    return join(getUserDataDir(), `workspace-code-${slot}.json`)
  }

  private workspaceSlot(dir: string | undefined): string {
    if (!dir) return EMPTY_WORKSPACE_SLOT
    return createHash('sha256').update(dir).digest('hex').slice(0, 32)
  }

  private readActiveWorkspaceDir(): string | undefined {
    const raw = readStoreJson<Record<string, unknown>>(join(getUserDataDir(), 'workspace-state.json'), {})
    return typeof raw.workspaceDir === 'string' && raw.workspaceDir ? raw.workspaceDir : undefined
  }

  private switchWorkspace(dir: string | undefined): void {
    if (this.workspaceDir === dir && this.loaded) return
    if (this.loaded) this.flush()
    this.workspaceDir = dir
    this.loaded = false
    this.sessions.clear()
    this.featuredId = null
    this.maximizedId = null
    this.activeView = null
    this.version = 1
    const snapshot = this.load()
    this.emit('change', snapshot)
  }

  private ensure(): void {
    if (this.loaded) return
    const workspaceDir = this.workspaceDir ?? this.readActiveWorkspaceDir()
    this.workspaceDir = workspaceDir
    const raw = readStoreJson<Record<string, unknown>>(this.file, {})
    // Also try legacy global file if per-workspace empty and global exists
    let source: Record<string, unknown> = raw
    if (Object.keys(raw).length === 0) {
      const legacyGlobal = join(getUserDataDir(), 'workspace-code.json')
      try {
        if (fs.existsSync(legacyGlobal) && this.workspaceSlot(workspaceDir) !== EMPTY_WORKSPACE_SLOT) {
          // For initial migration from global, copy over if slot file empty
          const globalRaw = readStoreJson<Record<string, unknown>>(legacyGlobal, {})
          if (Object.keys(globalRaw).length > 0) {
            source = globalRaw
          }
        }
      } catch {
        /* ignore */
      }
    }
    this.loaded = true
    const data = sanitizeSnapshot(source)
    for (const s of data.sessions) this.sessions.set(s.id, s)
    this.featuredId = data.featuredId
    this.maximizedId = data.maximizedId
    this.activeView = data.activeView ?? null
    this.version = data.version
  }

  load(): CodeSnapshot {
    this.ensure()
    return this.snapshot()
  }

  snapshot(): CodeSnapshot {
    this.ensure()
    return {
      schemaVersion: CODE_SCHEMA_VERSION,
      sessions: Array.from(this.sessions.values()),
      featuredId: this.featuredId,
      maximizedId: this.maximizedId,
      activeView: this.activeView,
      version: this.version
    }
  }

  /**
   * Replaces stored state with the renderer's current view.
   * Merge not versioned per session — last writer wins, like canvas import without version check.
   */
  save(input: { sessions?: unknown; featuredId?: unknown; maximizedId?: unknown; activeView?: unknown }): CodeSnapshot {
    this.ensure()
    let changed = false
    if (Array.isArray(input.sessions)) {
      const incoming = (input.sessions.map(sanitizeSession).filter(Boolean) as CodeSession[]).slice(0, MAX_SESSIONS)
      const sessionsDiffer = incoming.length !== this.sessions.size || incoming.some(s => {
        const existing = this.sessions.get(s.id)
        return !existing || existing.agentId !== s.agentId || existing.label !== s.label || existing.command !== s.command || (existing.title ?? '') !== (s.title ?? '')
      })
      let orderingDiffers = false
      if (!sessionsDiffer) {
        const curArr = Array.from(this.sessions.values())
        for (let i = 0; i < curArr.length; i++) {
          if (curArr[i].id !== incoming[i].id) { orderingDiffers = true; break }
        }
      }
      if (sessionsDiffer || orderingDiffers) {
        this.sessions.clear()
        for (const s of incoming) this.sessions.set(s.id, s)
        changed = true
      }
    }
    if ('featuredId' in input) {
      const sanitized = (typeof input.featuredId === 'string' && SESSION_ID_RE.test(input.featuredId) && this.sessions.has(input.featuredId)) ? input.featuredId : null
      if (sanitized !== this.featuredId) {
        this.featuredId = sanitized
        changed = true
      }
    }
    if ('maximizedId' in input) {
      const sanitized = (typeof input.maximizedId === 'string' && SESSION_ID_RE.test(input.maximizedId) && this.sessions.has(input.maximizedId)) ? input.maximizedId : null
      if (sanitized !== this.maximizedId) {
        this.maximizedId = sanitized
        changed = true
      }
    }
    if ('activeView' in input) {
      const sanitized = isWorkView(input.activeView) ? input.activeView : null
      if (sanitized !== this.activeView) {
        this.activeView = sanitized
        changed = true
      }
    }
    if (changed) {
      this.version += 1
      this.changed()
    }
    return this.snapshot()
  }

  private changed(): void {
    this.emit('change', this.snapshot())
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flushAsync()
    }, 400)
    this.saveTimer.unref?.()
  }

  private snapshotForPersist(): CodeSnapshot {
    return {
      schemaVersion: CODE_SCHEMA_VERSION,
      sessions: Array.from(this.sessions.values()),
      featuredId: this.featuredId,
      maximizedId: this.maximizedId,
      activeView: this.activeView,
      version: this.version
    }
  }

  private flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.loaded) return
    try {
      writeJsonAtomic(this.file, this.snapshotForPersist())
      this.syncFlushSeq = this.writeSeq
    } catch (err) {
      console.error('failed to persist code layout', err)
    }
  }

  private flushAsync(): void {
    if (!this.loaded) return
    this.writeSeq += 1
    const seq = this.writeSeq
    const snapshot = this.snapshotForPersist()
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async (): Promise<boolean> => {
        if (seq <= this.syncFlushSeq) return false
        await writeJsonAtomicAsync(this.file, snapshot)
        return true
      })
      .then((wrote) => {
        if (!wrote) return
        if (this.syncFlushSeq >= seq) {
          try {
            writeJsonAtomic(this.file, this.snapshotForPersist())
          } catch (err) {
            console.error('failed to persist code layout', err)
          }
        }
      })
      .catch((err: unknown) => {
        console.error('failed to persist code layout', err)
      })
  }

  dispose(): void {
    this.flush()
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.loaded = false
    this.removeAllListeners('change')
    this.writeChain = Promise.resolve()
  }
}
