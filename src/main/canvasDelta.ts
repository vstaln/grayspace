import { EventEmitter } from 'node:events'
import type { CanvasCamera, CanvasConnection, CanvasSnapshot, CanvasStroke, CanvasWidget } from './canvasState.ts'
import type { Journal } from './core/journal.ts'
import type { JournalEntry } from './core/types.ts'

export const CANVAS_DELTA_SCHEMA_VERSION = 1
export const DEFAULT_CANVAS_DELTA_LIMIT = 2_048

export type CanvasDeltaPatch =
  | { op: 'upsert'; widget: CanvasWidget }
  | { op: 'update'; id: string; changes: Partial<Pick<CanvasWidget, 'x' | 'y'>> }
  | { op: 'remove'; id: string }
  | { op: 'replace'; value: CanvasCamera | CanvasStroke[] | CanvasConnection[] | CanvasSnapshot }

export interface CanvasDelta {
  schemaVersion: typeof CANVAS_DELTA_SCHEMA_VERSION
  eventId: string
  canvasId: string
  seq: number
  workspaceDir: string | null
  resourceId: string
  version: number
  actorId: string
  commandId?: string
  type: string
  patch: CanvasDeltaPatch
}

export interface CanvasDeltaReplay {
  schemaVersion: typeof CANVAS_DELTA_SCHEMA_VERSION
  workspaceDir: string | null
  events: CanvasDelta[]
  lastSeq: number
  resetRequired: boolean
  snapshot?: CanvasSnapshot
}

export interface CanvasDeltaStreamOptions {
  journal: Journal
  snapshot: () => CanvasSnapshot
  workspaceDir?: () => string | undefined
  maxEvents?: number
}

/**
 * Turns committed canvas journal entries into a small replayable event stream.
 * CommandFlow remains the mutation gate; this class only observes commits and
 * fans out a renderer-friendly representation.
 */
export class CanvasDeltaStream extends EventEmitter {
  private readonly journal: Journal
  private readonly snapshot: () => CanvasSnapshot
  private readonly workspaceDir: () => string | undefined
  private readonly maxEvents: number
  private readonly events: CanvasDelta[] = []
  private readonly onJournalEntryBound: (entry: JournalEntry) => void
  private currentWorkspace: string | null
  private earliestSeq = 0
  private ringTruncated = false

  constructor(options: CanvasDeltaStreamOptions) {
    super()
    this.setMaxListeners(0)
    this.journal = options.journal
    this.snapshot = options.snapshot
    this.workspaceDir = options.workspaceDir ?? (() => undefined)
    this.maxEvents = Math.max(1, Math.floor(options.maxEvents ?? DEFAULT_CANVAS_DELTA_LIMIT))
    this.currentWorkspace = this.workspaceKey()
    this.onJournalEntryBound = (entry) => this.onJournalEntry(entry)
    this.journal.on('entry', this.onJournalEntryBound)
  }

  private workspaceKey(): string | null {
    try {
      return this.workspaceDir() ?? null
    } catch {
      return null
    }
  }

  private onJournalEntry(entry: JournalEntry): void {
    if (entry.phase !== 'commit') return
    const workspace = this.workspaceKey()
    if (workspace !== this.currentWorkspace) {
      this.currentWorkspace = workspace
      this.events.length = 0
      this.earliestSeq = 0
      this.ringTruncated = false
    }

    const delta = this.toDelta(entry, workspace)
    if (!delta) return
    this.events.push(delta)
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
      this.ringTruncated = true
    }
    this.earliestSeq = this.events[0]?.seq ?? 0
    this.emit('delta', delta)
  }

  private toDelta(entry: JournalEntry, workspaceDir: string | null): CanvasDelta | null {
    const isWidget = entry.target.startsWith('widget:')
    const isCanvas = entry.target.startsWith('canvas:')
    const isCanvasType = entry.type === 'widget.create' || entry.type === 'widget.update' ||
      entry.type === 'widget.remove' || entry.type === 'canvas.camera' ||
      entry.type === 'canvas.strokes' || entry.type === 'canvas.connections' ||
      entry.type === 'canvas.import'

    if (isWidget && (entry.type === 'widget.create' || entry.type === 'widget.update')) {
      const id = entry.type === 'widget.create'
        ? this.widgetIdFromCreate(entry)
        : entry.target.slice('widget:'.length)
      const widget = id ? this.snapshot().widgets.find((candidate) => candidate.id === id) : undefined
      if (!id || !widget) return null
      if (entry.type === 'widget.update') {
        const changes = this.widgetChanges(entry.payload, widget)
        if (changes) {
          return this.baseDelta(entry, workspaceDir, `widget:${id}`, widget.version, {
            op: 'update',
            id,
            changes
          })
        }
      }
      return this.baseDelta(entry, workspaceDir, `widget:${id}`, widget.version, { op: 'upsert', widget })
    }

    if (isWidget && entry.type === 'widget.remove') {
      const id = entry.target.slice('widget:'.length)
      return this.baseDelta(entry, workspaceDir, entry.target, entry.version ?? this.snapshot().version, {
        op: 'remove',
        id
      })
    }

    if (!isCanvas || !isCanvasType) {
      // A transaction commit carries its canvas mutations in the command list
      // but no per-command payload. Send one atomic snapshot replacement.
      if (entry.type !== 'flow.transact' || !this.transactionTouchesCanvas(entry)) return null
      const snapshot = this.snapshot()
      return this.baseDelta(entry, workspaceDir, 'canvas:main', snapshot.version, { op: 'replace', value: snapshot })
    }

    const snapshot = this.snapshot()
    if (entry.type === 'canvas.camera') {
      return this.baseDelta(entry, workspaceDir, entry.target, snapshot.version, { op: 'replace', value: snapshot.camera })
    }
    if (entry.type === 'canvas.strokes') {
      return this.baseDelta(entry, workspaceDir, entry.target, snapshot.version, { op: 'replace', value: snapshot.strokes })
    }
    if (entry.type === 'canvas.connections') {
      return this.baseDelta(entry, workspaceDir, entry.target, snapshot.version, { op: 'replace', value: snapshot.connections })
    }

    // Imports may contain renderer metadata and can touch several resources;
    // the post-commit snapshot is the canonical, sanitized result.
    return this.baseDelta(entry, workspaceDir, entry.target, snapshot.version, { op: 'replace', value: snapshot })
  }

  private widgetIdFromCreate(entry: JournalEntry): string | null {
    const payload = entry.payload
    if (!payload || typeof payload !== 'object') return null
    const id = (payload as { id?: unknown }).id
    return typeof id === 'string' && id.length > 0 ? id : null
  }

  private widgetChanges(
    payload: unknown,
    widget: CanvasWidget
  ): Partial<Pick<CanvasWidget, 'x' | 'y'>> | null {
    if (!payload || typeof payload !== 'object') return null
    const source = payload as Record<string, unknown>
    const keys = Object.keys(source).filter((key) => source[key] !== undefined)
    if (keys.length === 0 || keys.some((key) => key !== 'x' && key !== 'y')) return null
    const changes: Partial<Pick<CanvasWidget, 'x' | 'y'>> = {}
    for (const key of ['x', 'y'] as const) {
      if (source[key] !== undefined && typeof source[key] === 'number' && Number.isFinite(source[key])) {
        changes[key] = widget[key]
      }
    }
    return Object.keys(changes).length > 0 ? changes : null
  }

  private transactionTouchesCanvas(entry: JournalEntry): boolean {
    const payload = entry.payload
    if (!payload || typeof payload !== 'object') return false
    const commands = (payload as { commands?: unknown }).commands
    if (!Array.isArray(commands)) return false
    return commands.some((command) => {
      if (!command || typeof command !== 'object') return false
      const target = (command as { target?: unknown }).target
      return typeof target === 'string' && (target.startsWith('canvas:') || target.startsWith('widget:'))
    })
  }

  private baseDelta(
    entry: JournalEntry,
    workspaceDir: string | null,
    resourceId: string,
    version: number,
    patch: CanvasDeltaPatch
  ): CanvasDelta {
    return {
      schemaVersion: CANVAS_DELTA_SCHEMA_VERSION,
      eventId: `canvas-delta-${entry.seq}`,
      canvasId: 'main',
      seq: entry.seq,
      workspaceDir,
      resourceId,
      version,
      actorId: entry.actorId,
      ...(entry.commandId ? { commandId: entry.commandId } : {}),
      type: entry.type,
      patch
    }
  }

  replay(since = 0): CanvasDeltaReplay {
    const safeSince = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0
    const workspaceDir = this.workspaceKey()
    const events = this.events.filter((event) => event.workspaceDir === workspaceDir && event.seq > safeSince)
    const hasOtherWorkspaceEvents = this.events.some((event) => event.workspaceDir !== workspaceDir)
    const hasTruncatedCurrent = this.ringTruncated &&
      this.events.some((event) => event.workspaceDir === workspaceDir) &&
      safeSince < this.earliestSeq
    const resetRequired = hasOtherWorkspaceEvents || hasTruncatedCurrent
    return {
      schemaVersion: CANVAS_DELTA_SCHEMA_VERSION,
      workspaceDir,
      events,
      lastSeq: this.journal.lastSeq,
      resetRequired,
      ...(resetRequired ? { snapshot: this.snapshot() } : {})
    }
  }

  dispose(): void {
    this.journal.off('entry', this.onJournalEntryBound)
    this.removeAllListeners()
    this.events.length = 0
    this.ringTruncated = false
  }
}
