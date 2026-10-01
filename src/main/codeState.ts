import { EventEmitter } from 'events'
import * as fs from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { readStoreJson, writeJsonAtomic, writeJsonAtomicAsync } from './storage.ts'
import { getUserDataDir } from './userData.ts'
import { ensureFolderStore, forgetFolderStore, workspaceSessionFile } from './workspaceFolderStore.ts'
import { notifyPersistError } from './persistNotifier.ts'

export const CODE_SCHEMA_VERSION = 1
const EMPTY_WORKSPACE_SLOT = '__no-workspace__'
const MAX_SESSIONS = 32

export interface CodeSession {
  id: string
  agentId: string
  label: string
  command: string
  title?: string
  status?: 'active' | 'finished'
}

export type WorkView = 'canvas' | 'code' | 'overview'

export interface CodeSnapshot {
  workspaceScope?: string
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
  const status = v.status === 'finished' ? 'finished' : 'active'
  return {
    id: v.id,
    agentId: String(v.agentId).slice(0, 64),
    label: String(v.label).slice(0, 64),
    command: String(v.command).slice(0, 512),
    title,
    status
  }
}

function isWorkView(v: unknown): v is WorkView {
  return v === 'canvas' || v === 'code' || v === 'overview'
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
  let activeView: WorkView | null = isWorkView(raw.activeView) ? (raw.activeView as WorkView) : null
  return {
    schemaVersion: CODE_SCHEMA_VERSION,
    sessions,
    featuredId,
    maximizedId,
    activeView,
    version
  }
}





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


  private workspaceScope = 'code-default'
  private legacyFolder: string | undefined
  private folder: string | undefined
  private readonly workspaceSessions = new Map<string, string[]>()
  private readonly deletedScopes = new Set<string>()

  forgetWorkspace(scope: string): string[] {
    this.deletedScopes.add(scope)
    const ids = scope === this.workspaceScope && this.loaded
      ? Array.from(this.sessions.keys())
      : this.workspaceSessions.get(scope) ?? []
    this.workspaceSessions.delete(scope)
    if (scope === this.workspaceScope) {
      if (this.saveTimer !== null) clearTimeout(this.saveTimer)
      this.saveTimer = null
      this.loaded = false
      this.sessions.clear()
    }
    return ids
  }

  constructor() { super() }

  /**
   * A workspace's sessions live next to the project when it has one, so the
   * folder carries its own terminals; the app data directory holds them for a
   * folder that cannot be written to, and for work with no folder open.
   */
  private get file(): string {
    // `ensureFolderStore` is what decides whether the folder can hold the file
    // at all — without it a read-only project would take every write into a
    // path that silently fails. Its answer is cached per folder.
    const inFolder = this.folder && ensureFolderStore(this.folder)
      ? workspaceSessionFile(this.folder, this.activeWorkspaceId())
      : null
    return inFolder ?? this.userDataFile
  }

  private get userDataFile(): string {
    const slot = this.workspaceSlot(this.workspaceScope)
    return join(getUserDataDir(), `workspace-code-${slot}.json`)
  }

  private workspaceSlot(scope: string): string {
    if (!scope) return EMPTY_WORKSPACE_SLOT
    return createHash('sha256').update(scope).digest('hex').slice(0, 32)
  }

  setWorkspaceScope(scope: string, legacyFolder?: string, folder?: string): void {
    if (!scope || (this.workspaceScope === scope && this.folder === folder && this.loaded)) return
    if (this.loaded) this.flush()
    this.workspaceScope = scope
    this.legacyFolder = legacyFolder
    this.folder = folder && folder.trim() ? folder : undefined
    this.loaded = false
    this.sessions.clear()
    this.featuredId = null
    this.maximizedId = null
    this.activeView = null
    this.version = 1
    const snapshot = this.load()
    this.emit('change', snapshot)
  }

  activeWorkspaceScope(): string { return this.workspaceScope }
  activeWorkspaceId(): string {
    const separator = this.workspaceScope.lastIndexOf('\u0000')
    return separator >= 0 ? this.workspaceScope.slice(separator + 1) : this.workspaceScope
  }

  private ensure(): void {
    if (this.loaded) return
    const raw = readStoreJson<Record<string, unknown>>(this.file, {})

    let source: Record<string, unknown> = raw
    if (Object.keys(raw).length === 0) {
      // Sessions recorded before this folder kept its own store, or while it
      // was read-only. Read once here; the next save writes them to the folder.
      if (this.file !== this.userDataFile) {
        const carriedElsewhere = readStoreJson<Record<string, unknown>>(this.userDataFile, {})
        if (Object.keys(carriedElsewhere).length > 0) source = carriedElsewhere
      }
      if (Object.keys(source).length === 0 && this.legacyFolder) {
        const oldFolderFile = join(getUserDataDir(), `workspace-code-${this.workspaceSlot(this.legacyFolder)}.json`)
        const oldFolderRaw = readStoreJson<Record<string, unknown>>(oldFolderFile, {})
        if (Object.keys(oldFolderRaw).length > 0) source = oldFolderRaw
      }
      const legacyGlobal = join(getUserDataDir(), 'workspace-code.json')
      try {
        if (Object.keys(source).length === 0 && fs.existsSync(legacyGlobal) && this.workspaceScope !== 'code-default') {

          const globalRaw = readStoreJson<Record<string, unknown>>(legacyGlobal, {})
          if (Object.keys(globalRaw).length > 0) {
            source = globalRaw
          }
        }
      } catch {

      }
    }
    this.loaded = true
    // Sessions that came from somewhere other than where they now belong:
    // hand the folder its copy straight away, so it carries the workspace even
    // if this run never changes anything.
    const adoptedFromElsewhere = source !== raw && Object.keys(source).length > 0
    const codeSchemaVersion = Number((source as Record<string, unknown>)?.schemaVersion)
    if (Number.isFinite(codeSchemaVersion) && codeSchemaVersion > CODE_SCHEMA_VERSION) {
      console.warn(`code store schema v${codeSchemaVersion} is newer than supported v${CODE_SCHEMA_VERSION}; loading best-effort`)
    }
    const data = sanitizeSnapshot(source)
    for (const s of data.sessions) this.sessions.set(s.id, s)
    this.featuredId = data.featuredId
    this.maximizedId = data.maximizedId
    this.activeView = data.activeView ?? null
    this.version = data.version
    if (adoptedFromElsewhere) this.flushAsync()
  }

  load(): CodeSnapshot {
    this.ensure()
    return this.snapshot()
  }

  snapshot(): CodeSnapshot {
    this.ensure()
    this.workspaceSessions.set(this.workspaceScope, Array.from(this.sessions.keys()))
    return {
      workspaceScope: this.workspaceScope,
      schemaVersion: CODE_SCHEMA_VERSION,
      sessions: Array.from(this.sessions.values()),
      featuredId: this.featuredId,
      maximizedId: this.maximizedId,
      activeView: this.activeView,
      version: this.version
    }
  }





  save(
    input: { sessions?: unknown; featuredId?: unknown; maximizedId?: unknown; activeView?: unknown },
    flushImmediate = false
  ): CodeSnapshot {
    this.ensure()
    let changed = false
    if (Array.isArray(input.sessions)) {
      const incoming = (input.sessions.map(sanitizeSession).filter(Boolean) as CodeSession[]).slice(0, MAX_SESSIONS)
      const sessionsDiffer = incoming.length !== this.sessions.size || incoming.some(s => {
        const existing = this.sessions.get(s.id)
        return !existing || existing.agentId !== s.agentId || existing.label !== s.label || existing.command !== s.command || (existing.title ?? '') !== (s.title ?? '') || (existing.status ?? 'active') !== (s.status ?? 'active')
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
      let sanitized: WorkView | null = isWorkView(input.activeView) ? (input.activeView as WorkView) : null
      if (sanitized !== this.activeView) {
        this.activeView = sanitized
        changed = true
      }
    }
    if (changed) {
      this.version += 1
      if (flushImmediate) {
        this.emit('change', this.snapshot())
        this.flush()
      } else {
        this.changed()
      }
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

  flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.loaded) return
    try {
      writeJsonAtomic(this.file, this.snapshotForPersist())
      this.syncFlushSeq = this.writeSeq
    } catch (err) {
      if (this.demoteToUserData(err)) {
        try {
          writeJsonAtomic(this.userDataFile, this.snapshotForPersist())
          this.syncFlushSeq = this.writeSeq
          return
        } catch (retryErr) {
          console.error('failed to persist code layout', retryErr)
          notifyPersistError('code-layout', retryErr)
          return
        }
      }
      console.error('failed to persist code layout', err)
      notifyPersistError('code-layout', err)
    }
  }

  /**
   * The project folder refused the write — it turned read-only, went away with
   * its share, or never really allowed one. Sessions are worth more than where
   * they are kept, so the rest of this session goes to the app data directory
   * instead of throwing the layout away one failed save at a time.
   *
   * Returns false when there was nowhere to fall back to, and the error is the
   * caller's to report.
   */
  private demoteToUserData(err: unknown): boolean {
    if (!this.folder) return false
    console.warn(`workspace folder store unavailable; keeping sessions in the app data directory instead`, err)
    forgetFolderStore(this.folder)
    this.folder = undefined
    return true
  }

  private flushAsync(): void {
    if (!this.loaded) return
    this.writeSeq += 1
    const seq = this.writeSeq
    const snapshot = this.snapshotForPersist()




    const file = this.file
    const scope = this.workspaceScope
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async (): Promise<boolean> => {
        if (seq <= this.syncFlushSeq || this.deletedScopes.has(scope)) return false
        await writeJsonAtomicAsync(file, snapshot)
        if (this.deletedScopes.has(scope)) {
          await fs.promises.rm(file, { force: true })
          return false
        }
        return true
      })
      .then((wrote) => {
        if (!wrote) return



        if (this.syncFlushSeq >= seq && file === this.file) {
          try {
            writeJsonAtomic(file, this.snapshotForPersist())
          } catch (err) {
            console.error('failed to persist code layout', err)
            notifyPersistError('code-layout', err)
          }
        }
      })
      .catch((err: unknown) => {
        if (this.deletedScopes.has(scope)) return
        // Same fallback as the synchronous path: a folder that cannot take the
        // write must not cost the user their layout.
        if (this.demoteToUserData(err)) {
          try {
            writeJsonAtomic(this.userDataFile, this.snapshotForPersist())
            return
          } catch (retryErr) {
            console.error('failed to persist code layout', retryErr)
            notifyPersistError('code-layout', retryErr)
            return
          }
        }
        console.error('failed to persist code layout', err)
        notifyPersistError('code-layout', err)
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
